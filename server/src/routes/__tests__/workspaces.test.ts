import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', () => ({
  default: {
    env:  'test',
    lockEnforcementMode: 'off', // HF1: 워크스페이스 저장도 편집 락 게이트를 거친다 — 테스트별로 바꿀 수 있게 가변 객체로 둔다
    cors: { origins: [] },
    auth: {
      accessTokenTtl:     900,
      accessTokenSecret:  'test-access-secret-0123456789abcd',
    },
  },
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:    vi.fn(),
  auditMiddleware:  vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import config from '../../config';
import { writeAuditLog } from '../../middleware/audit';
import { createWorkspacesRouter } from '../workspaces';
import { createErrorHandler } from '../../http/errorHandler';
import { createLogger } from '../../logger';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  const query = vi.fn();
  const client = { query, release: vi.fn() };
  return { connect: vi.fn().mockResolvedValue(client), query } as unknown as Pool;
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

/** Token for an org-scoped user. */
function orgToken(role: 'admin' | 'doctor' = 'doctor'): string {
  return generateAccessToken({
    sub: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sessionId: 'sess-1', orgId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    role, name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

/** Token for a superadmin (null org). */
function superToken(): string {
  return generateAccessToken({
    sub: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    sessionId: 'sess-2', orgId: null,
    role: 'admin', name: 'Superadmin', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/workspaces', createWorkspacesRouter(pool));
  app.use(createErrorHandler(createLogger({ level: 'silent' }))); // as in createApp (S1)
  return app;
}

// Wire: first call is auth middleware session check, subsequent calls are route queries.
function wireQueries(pool: Pool, ...results: { rows: unknown[]; rowCount?: number }[]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth middleware
  for (const r of results) {
    mock.mockResolvedValueOnce(r);
  }
}

// 환자 upsert 경로까지 현실적인 값을 돌려주는 SQL 라우팅 목. 쿼리 "순서"가 아니라 SQL 조각으로 응답을
// 고르므로 쿼리가 추가/재배치돼도 깨지지 않는다(순서 큐 방식은 이 파일의 오래된 테스트에만 남아 있다).
function routeQueries(
  mock: ReturnType<typeof vi.fn>,
  opts: { existing?: Record<string, unknown> | null; lock?: Record<string, unknown> | null } = {},
): void {
  mock.mockImplementation(async (sql: unknown) => {
    const s = typeof sql === 'string' ? sql : '';
    if (s.includes('FROM sessions')) return { rows: [{ exists: 1 }] };
    if (s.includes('FROM patient_records') && s.includes('FOR SHARE')) return { rows: [] };
    if (s.includes('FROM patient_records') && s.includes('FOR UPDATE')) return { rows: opts.existing ? [opts.existing] : [] };
    if (s.includes('FROM patient_locks')) return { rows: opts.lock ? [opts.lock] : [] };
    if (s.includes('SELECT patient_no FROM patient_persons')) return { rows: [{ patient_no: null }] };
    if (s.includes('FROM patient_persons')) return { rows: [] };
    if (s.includes('INSERT INTO patient_persons')) return { rows: [{ id: PERSON_ID }] };
    if (s.includes('UPDATE patient_persons')) return { rows: [], rowCount: 1 };
    if (s.includes('INSERT INTO patient_records')) return { rows: [{ revision: 1, assigned_doctor_user_id: USER_ID }], rowCount: 1 };
    if (s.includes('UPDATE patient_records')) return { rows: [{ revision: 2, assigned_doctor_user_id: USER_ID }], rowCount: 1 };
    if (s.includes('INSERT INTO workspaces')) return { rows: [{ id: WS_ID, version: VERSION }], rowCount: 1 };
    if (s.includes('UPDATE workspaces') && s.includes('RETURNING')) return { rows: [{ version: VERSION }], rowCount: 1 };
    if (s.includes('FROM workspaces')) return { rows: [WS_ROW] };
    return { rows: [], rowCount: 1 };
  });
}

// ---------------------------------------------------------------------------
// Sample data — all IDs are valid UUIDs
// ---------------------------------------------------------------------------
const PAT_ID  = '11111111-1111-1111-1111-111111111111';
const PERSON_ID = '99999999-9999-9999-9999-999999999999';
const WS_ID   = '22222222-2222-2222-2222-222222222222';
const VERSION = '2026-01-15 10:00:00.123456+00'; // 저장본의 created_at(마이크로초 문자열) — 보정 UPDATE의 버전 조건
const ORG_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const PATIENT_SNAPSHOT = {
  id:    PAT_ID,
  phase: 'evaluation',
  data:  {
    shared: {
      name: 'Kim', patientNo: 'P001', birthDate: '1980-01-01',
      injuryDate: '2024-01-01', evaluationDate: '2024-01-10', diagnoses: [{ code: 'M54.5' }],
      jobs: [{ jobName: '사무직' }],
    },
    modules: {},
    activeModules: ['knee'],
  },
};

const WS_ROW = {
  id:               WS_ID,
  name:             'Visit 2024',
  created_at:       new Date('2024-01-15T10:00:00Z'),
  patient_ids:      [PAT_ID],
  snapshot_payload: [PATIENT_SNAPSHOT],
};

const WS_ITEM = {
  id:       WS_ID,
  name:     'Visit 2024',
  count:    1,
  savedAt:  '2024-01-15T10:00:00.000Z',
  patients: [PATIENT_SNAPSHOT],
};

const VALID_BODY = { name: 'New Visit', patients: [PATIENT_SNAPSHOT] };

// 기존 patient_records 행(SELECT … FOR UPDATE 결과) 픽스처 — 담당의는 기본적으로 요청자(USER_ID).
const existingRow = (over: Record<string, unknown> = {}) => ({
  patient_person_id: PERSON_ID, deleted_at: null, revision: 1, assigned_doctor_user_id: USER_ID,
  completion_status: 'draft', server_observed_modules_complete_at: null, completion_source: null,
  completion_client_build_version: null, completion_client_schema_version: null,
  server_verified_modules_complete_at: null, completion_verification_engine_version: null,
  ...over,
});

// person 해석을 단순화하는 익명(등록번호 없음) 환자 — 기존 행 테스트들이 공통으로 쓴다.
const ANON_PATIENT = {
  ...PATIENT_SNAPSHOT,
  data: { ...PATIENT_SNAPSHOT.data, shared: { ...PATIENT_SNAPSHOT.data.shared, patientNo: '' } },
};

// ---------------------------------------------------------------------------
// GET /api/workspaces
// ---------------------------------------------------------------------------
describe('GET /api/workspaces', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool)).get('/api/workspaces');
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty items for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    // No second DB query — superadmin short-circuits before listing
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('returns 200 with workspace list for org user', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [WS_ROW] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: WS_ID, name: 'Visit 2024', count: 1 });
  });

  it('answers a DB failure with the 500 envelope (central error handler, S1)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // auth middleware
      .mockRejectedValueOnce(new Error('connection terminated'));
    const res = await request(makeApp(pool))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
  });

  it('returns 200 with empty list when user has no workspaces', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('GET /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool)).get(`/api/workspaces/${WS_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with snapshot payload (default)', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [WS_ROW] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(WS_ITEM);
    expect(res.body.view).toBeUndefined();
  });

  it('returns live patient payload for ?view=current', async () => {
    const pool = makePool();
    const live = { ...PATIENT_SNAPSHOT, data: { ...PATIENT_SNAPSHOT.data, shared: { ...PATIENT_SNAPSHOT.data.shared, name: 'Kim Updated' } } };
    wireQueries(
      pool,
      { rows: [WS_ROW] },
      { rows: [{ id: PAT_ID, deleted_at: null, payload: live }] }
    );
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('current');
    expect(res.body.patients).toHaveLength(1);
    expect((res.body.patients[0] as typeof live).data.shared.name).toBe('Kim Updated');
  });

  it('returns redacted stub for patient not in patient_records', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [WS_ROW] }, { rows: [] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients[0]).toEqual({ id: PAT_ID, redacted: true });
  });

  it('returns redacted stub for soft-deleted patient', async () => {
    const pool = makePool();
    wireQueries(
      pool,
      { rows: [WS_ROW] },
      { rows: [{ id: PAT_ID, deleted_at: new Date(), payload: {} }] }
    );
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients[0]).toEqual({ id: PAT_ID, redacted: true });
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces
// ---------------------------------------------------------------------------
describe('POST /api/workspaces', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${superToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 400 for empty name', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: '', patients: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 for patients not array', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Test', patients: 'not-array' });
    expect(res.status).toBe(400);
  });

  // snapshot을 커밋하기 *전에* 막아야 한다. patient upsert는 커밋 이후 best-effort로
  // 돌면서 오류를 삼키므로, 거기서 검증하면 API는 201을 반환하고 오염된 생년월일은
  // 이미 snapshot_payload에 저장된 뒤가 된다.
  it('오염된 생년월일이 있으면 400이고 workspace 행을 만들지 않는다', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth

    const badPatient = {
      ...PATIENT_SNAPSHOT,
      data: {
        ...PATIENT_SNAPSHOT.data,
        shared: { ...PATIENT_SNAPSHOT.data.shared, birthDate: '4110-02-12' },
      },
    };

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Bad Visit', patients: [badPatient] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BIRTH_DATE');
    expect(res.body.fields[0]).toMatchObject({ field: 'birthDate', reason: 'future' });

    // snapshot 트랜잭션 자체가 열리지 않아야 한다
    expect(pool.connect).not.toHaveBeenCalled();
    const insertWs = (mock.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWs).toBeUndefined();
    // 날짜 값 자체는 PHI이므로 응답에 되싣지 않는다
    expect(JSON.stringify(res.body)).not.toContain('4110-02-12');
  });

  it('redacts soft-deleted patients before saving a new workspace snapshot', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [{ id: PAT_ID, deleted_at: new Date('2024-02-01T00:00:00Z') }] });
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID, version: VERSION }] }); // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT
    mock.mockResolvedValueOnce({
      rows: [{
        ...WS_ROW,
        snapshot_payload: [{ id: PAT_ID, redacted: true }],
      }],
    }); // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    const calls = mock.mock.calls as unknown[][];
    const insertWsCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall).toBeDefined();
    expect(JSON.parse((insertWsCall![1] as unknown[])[4] as string)).toEqual([
      { id: PAT_ID, redacted: true },
    ]);

    const upsertCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall).toBeUndefined();
  });

  it('ignores patients with non-UUID or missing id', async () => {
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({ rows: [{ exists: 1 }] });

    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Test', patients: [{ id: 'local-123' }, { id: 'not-a-uuid' }] });

    const calls = (mock).mock.calls;
    const insertWsCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall![1][3]).toEqual([]); // patient_ids empty

    // No patient_records upsert (name is missing → meta returns null)
    const upsertCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// PUT /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('PUT /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .put(`/api/workspaces/${WS_ID}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found or not owned', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE workspace
    mock.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(makeApp(pool))
      .put(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with updated list on overwrite success', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    const updatedRow = { ...WS_ROW, name: 'New Visit' };
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [{ version: VERSION }], rowCount: 1 }); // UPDATE workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [] }); // pg_advisory_xact_lock (환자 id별 직렬화)
    mock.mockResolvedValueOnce({ rows: [] }); // SELECT existing patient_records
    mock.mockResolvedValueOnce({ rows: [] }); // SELECT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ id: PERSON_ID }] }); // INSERT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ revision: 1, assigned_doctor_user_id: USER_ID }], rowCount: 1 }); // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE workspaces (저장된 환자 revision을 스냅샷에 반영)
    mock.mockResolvedValueOnce({ rows: [updatedRow] }); // list query

    const res = await request(makeApp(pool))
      .put(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('New Visit');

    const calls = mock.mock.calls as unknown[][];
    const updateWsCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('UPDATE workspaces')
    );
    expect(updateWsCall).toBeDefined();
    expect((updateWsCall![1] as unknown[])[0]).toBe(WS_ID);

    const insertWsCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${superToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found or not owned', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [], rowCount: 0 });
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with updated list on success', async () => {
    const pool = makePool();
    wireQueries(
      pool,
      { rows: [], rowCount: 1 },
      { rows: [] }
    );
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HF1: 기존 환자에 대한 쓰기 규칙(담당의 / revision / 편집 락) — SQL 라우팅 목.
// 실DB 동시성은 workspaces.integration.test.ts가 증명한다. 여기는 DB 없이도 도는 회귀 방어선이다.
// ---------------------------------------------------------------------------
describe('POST /api/workspaces — 기존 환자 쓰기 규칙 (HF1)', () => {
  const OTHER_DOCTOR = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const setLockMode = (mode: 'off' | 'observe' | 'enforce') => {
    (config as unknown as { lockEnforcementMode: string }).lockEnforcementMode = mode;
  };

  beforeEach(() => { vi.mocked(writeAuditLog).mockClear(); });
  afterEach(() => { setLockMode('off'); });

  async function save(opts: {
    existing?: Record<string, unknown> | null;
    lock?: Record<string, unknown> | null;
    revision?: number;
    extra?: Record<string, unknown>;
  }) {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    routeQueries(mock, { existing: opts.existing ?? null, lock: opts.lock ?? null });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'HF1', patients: [{ ...ANON_PATIENT, sync: { revision: opts.revision ?? 1 } }], ...opts.extra });
    const calls = mock.mock.calls as unknown[][];
    const wrote = calls.some((c) =>
      typeof c[0] === 'string' && /(INSERT INTO|UPDATE) patient_records/.test(c[0] as string));
    return { res, calls, wrote };
  }

  it('저장된 환자의 확정 revision·담당의를 스냅샷에 찍는다 — 가려진 항목·나중 저장본은 건드리지 않는 조건으로', async () => {
    const { res, calls } = await save({ existing: existingRow() });
    const stamp = calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('jsonb_to_recordset'));
    expect(stamp).toBeDefined();
    const [stampsJson, workspaceId, orgId, userId, version] = stamp![1] as string[];
    expect(JSON.parse(stampsJson)).toEqual([{ id: PAT_ID, revision: 2, assigned: USER_ID }]);
    // 소유자·조직·"내가 기록한 저장본" 조건으로만 갱신한다
    expect([workspaceId, orgId, userId, version]).toEqual([WS_ID, ORG_ID, USER_ID, VERSION]);
    const sql = stamp![0] as string;
    expect(sql).toContain("NOT (e.elem ? 'redacted')");     // 삭제로 가려진 항목은 건드리지 않는다
    expect(sql).toContain('created_at = $5::timestamptz');   // 나중 저장이 덮어쓴 행에는 적용하지 않는다
    expect(res.status).toBe(201);
  });

  it('저장된 환자가 없으면(전부 제외) 스냅샷 보정 UPDATE를 하지 않는다', async () => {
    const { calls } = await save({ existing: existingRow({ assigned_doctor_user_id: OTHER_DOCTOR }) });
    expect(calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes('jsonb_to_recordset'))).toBe(false);
  });

  it('스냅샷 보정이 실패해도 저장은 성공으로 응답한다(환자 기록은 이미 저장됨)', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    routeQueries(mock, { existing: existingRow() });
    const route = mock.getMockImplementation()!;
    mock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('jsonb_to_recordset')) throw new Error('stamp failed');
      return route(sql);
    });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'HF1', patients: [{ ...ANON_PATIENT, sync: { revision: 1 } }] });
    expect(res.status).toBe(201);
    expect(res.body.saved).toHaveLength(1);
  });

  it('lockTokens 값이 비어 있거나 너무 길면 400', async () => {
    const pool = makePool();
    routeQueries(pool.query as ReturnType<typeof vi.fn>);
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'HF1', patients: [ANON_PATIENT], lockTokens: { [PAT_ID]: 'x'.repeat(257) } });
    expect(res.status).toBe(400);
  });
});

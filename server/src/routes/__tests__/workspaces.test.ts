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
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
  },
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:    vi.fn(),
  auditMiddleware:  vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import config from '../../config';
import { writeAuditLog } from '../../middleware/audit';
import { hashToken } from '../../auth/sessionStore';
import { createWorkspacesRouter } from '../workspaces';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';
import { COMPLETION_ENGINE_VERSION } from '../../completionTracking';

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

  // 검증만 하고 원본을 저장하면 DB DATE는 2020-01-02, snapshot/payload는 2020/01/02가 되어
  // dateOnly() 비교에서 어긋나 존재하지 않는 생년월일 충돌이 난다.
  it('2020/01/02를 canonical 형식으로 정규화해 snapshot과 upsert 양쪽에 저장한다', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] });              // BEGIN
    mock.mockResolvedValueOnce({ rows: [] });              // deleted patient check
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID, version: VERSION }] });              // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] });              // COMMIT
    mock.mockResolvedValueOnce({ rows: [] });              // BEGIN (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [] });              // pg_advisory_xact_lock (환자 id별 직렬화)
    mock.mockResolvedValueOnce({ rows: [] });              // SELECT existing patient_records
    mock.mockResolvedValueOnce({ rows: [] });              // SELECT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ id: PERSON_ID }] }); // INSERT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ revision: 1, assigned_doctor_user_id: USER_ID }], rowCount: 1 });  // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [] });              // COMMIT (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 });              // UPDATE workspaces (저장된 환자 revision을 스냅샷에 반영)
    mock.mockResolvedValueOnce({ rows: [WS_ROW] });        // list query

    const slashed = {
      ...PATIENT_SNAPSHOT,
      data: {
        ...PATIENT_SNAPSHOT.data,
        shared: { ...PATIENT_SNAPSHOT.data.shared, birthDate: '2020/01/02' },
      },
    };

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Slashed', patients: [slashed] });

    expect(res.status).toBe(201);
    const calls = mock.mock.calls as unknown[][];

    // snapshot_payload에 정규화된 값이 들어가야 한다
    const insertWs = calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    const snapshot = JSON.parse((insertWs![1] as unknown[])[4] as string) as Array<{
      data: { shared: { birthDate: string } };
    }>;
    expect(snapshot[0].data.shared.birthDate).toBe('2020-01-02');

    // patient_records upsert의 birth_date 컬럼과 payload도 정규화된 값이어야 한다
    const upsert = calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect((upsert![1] as unknown[])[7]).toBe('2020-01-02');
    const payload = JSON.parse((upsert![1] as unknown[])[13] as string) as {
      data: { shared: { birthDate: string } };
    };
    expect(payload.data.shared.birthDate).toBe('2020-01-02');
  });

  it('returns 201 with updated list on success', async () => {
    const pool   = makePool();
    const newRow = { ...WS_ROW, id: '33333333-3333-3333-3333-333333333333', name: 'New Visit' };
    const mock   = pool.query as ReturnType<typeof vi.fn>;
    // Call order: auth -> BEGIN -> deleted check -> INSERT workspace -> COMMIT
    // -> [환자별 트랜잭션] BEGIN -> existing record lookup -> person lookup/insert
    //    -> upsert patient_records -> COMMIT
    // -> list
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });   // auth
    mock.mockResolvedValueOnce({ rows: [] });                  // BEGIN
    mock.mockResolvedValueOnce({ rows: [] });                  // deleted patient check
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID, version: VERSION }] });                  // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] });                  // COMMIT
    mock.mockResolvedValueOnce({ rows: [] });                  // BEGIN (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [] });                  // pg_advisory_xact_lock (환자 id별 직렬화)
    mock.mockResolvedValueOnce({ rows: [] });                  // SELECT existing patient_records
    mock.mockResolvedValueOnce({ rows: [] });                  // SELECT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ id: PERSON_ID }] }); // INSERT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ revision: 1, assigned_doctor_user_id: USER_ID }], rowCount: 1 });      // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [] });                  // COMMIT (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 });                  // UPDATE workspaces (저장된 환자 revision을 스냅샷에 반영)
    mock.mockResolvedValueOnce({ rows: [newRow, WS_ROW] });   // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    // HF1: 환자별 저장 결과 — 새 환자는 revision 1로 saved
    expect(res.body.saved).toEqual([{ id: PAT_ID, revision: 1, assignedDoctorUserId: USER_ID }]);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.lockedByOther).toEqual([]);
    expect(res.body.items[0].name).toBe('New Visit');
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

  it('upserts patient_records after workspace insert', async () => {
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    routeQueries(mock); // 기존 환자 없음 → 새 환자 INSERT 경로

    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    // Transactional workspace insert is followed by best-effort patient_records upsert.
    const calls = (mock).mock.calls;
    const deletedCheckCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('FROM patient_records') &&
      (c[0] as string).includes('FOR SHARE')
    );
    expect(deletedCheckCall).toBeDefined();

    const upsertCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall![1][0]).toBe(PAT_ID);   // id
    expect(upsertCall![1][1]).toBe(ORG_ID);   // organization_id
    expect(upsertCall![1][3]).toBe(USER_ID);  // owner_user_id
    expect(upsertCall![1][4]).toBe(USER_ID);  // assigned_doctor_user_id (resolved: role=doctor, no doctorName)
    expect(upsertCall![1][5]).toBe('Kim');    // name (shifted)
    expect(upsertCall![0]).not.toContain('deleted_at       = NULL');
    // HF1: 인가 없이 덮어쓰는 ON CONFLICT 경로는 폐기됐다 — 새 환자는 순수 INSERT.
    expect(upsertCall![0]).not.toContain('ON CONFLICT');
  });

  // PR0-A: workspace 수동 저장도 patients.ts의 PATCH/POST와 같은 3상태 완료 규칙을 따라야
  // 한다 — 이 upsert가 patient_records를 직접 갱신하는 또 다른 경로이므로, 클라이언트가 각
  // 환자 객체 최상위에 실어보내는 modulesCompleteObserved를 여기서도 읽어 반영해야 한다.
  it('완료 보고(modulesCompleteObserved=true)를 workspace 저장에도 반영한다', async () => {
    const ANON_PERSON_ID = '66666666-6666-6666-6666-666666666666';
    const completePatient = {
      ...ANON_PATIENT,
      sync: { revision: 1, syncStatus: 'synced' },
      modulesCompleteObserved: true,
      completionClientBuildVersion: '6.6.0+abc123',
      completionClientSchemaVersion: 1,
    };
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN (ws tx)
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID, version: VERSION }] }); // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT (ws tx)
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [] }); // pg_advisory_xact_lock (환자 id별 직렬화)
    mock.mockResolvedValueOnce({
      rows: [{
        patient_person_id: ANON_PERSON_ID, deleted_at: null, revision: 1, assigned_doctor_user_id: USER_ID,
        completion_status: 'draft', server_observed_modules_complete_at: null,
        completion_source: null, completion_client_build_version: null, completion_client_schema_version: null,
        server_verified_modules_complete_at: null, completion_verification_engine_version: null,
      }],
    }); // existing record lookup (FOR UPDATE) — draft, never observed
    mock.mockResolvedValueOnce({ rows: [{ patient_no: null }] }); // SELECT patient_no FOR UPDATE
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE existing person
    mock.mockResolvedValueOnce({ rows: [{ revision: 2, assigned_doctor_user_id: USER_ID }], rowCount: 1 }); // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE workspaces (저장된 환자 revision을 스냅샷에 반영)
    mock.mockResolvedValueOnce({ rows: [WS_ROW] }); // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Completed Visit', patients: [completePatient] });

    expect(res.status).toBe(201);
    // 기존 행이므로 UPDATE — 바인드 파라미터(0-based): 13=completion_status, 14=observed_at, 15=source,
    // 16=build version, 17=schema version.
    const upsertCall = (mock.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE patient_records')
    );
    expect(upsertCall).toBeDefined();
    const params = upsertCall![1] as unknown[];
    expect(params[13]).toBe('modules_complete');
    expect(params[14]).toBeInstanceOf(Date);
    expect(params[15]).toBe('client_reported');
    expect(params[16]).toBe('6.6.0+abc123');
    expect(params[17]).toBe(1);
  });

  // PR0-B2 §5.5: server_verified_modules_complete_at은 client_reported와 완전히 별도 컬럼
  // — workspace 저장도 patient_records를 직접 갱신하는 경로라 이 재검증이 여기서도 빠지면
  // 안 된다. 기존 행 UPDATE 바인드 파라미터 인덱스(0-based): 18=server_verified_modules_complete_at,
  // 19=completion_verification_engine_version.
  it('서버 재검증(server_verified)은 실제 완료 조건을 만족하는 진단이 있을 때만 별도 컬럼에 기록된다', async () => {
    const ANON_PERSON_ID = '66666666-6666-6666-6666-666666666666';
    const completePatient = {
      ...PATIENT_SNAPSHOT,
      sync: { revision: 1, syncStatus: 'synced' },
      data: {
        ...PATIENT_SNAPSHOT.data,
        // modules.knee가 없으면(undefined) analytics-core의 §P1 방어(모듈 데이터가 구조적
        // 으로 유효하지 않으면 isComplete를 호출하지 않고 미완료로 차단)에 걸린다.
        modules: { knee: {} },
        shared: {
          ...PATIENT_SNAPSHOT.data.shared,
          // 위 완료 보고 테스트와 동일하게 anonymous person 흐름(patientNo 빈 값)을 그대로
          // 써서 mock 쿼리 시퀀스를 맞춘다 — 이 테스트가 검증하려는 건 person 해석이 아니라
          // 완료 재검증이다. M17.0은 analytics-core에서 무릎으로 확정 매핑되는 코드이고,
          // side/confirmedRight/assessmentRight까지 갖춰 isKneeAssessmentComplete가 실제로
          // true를 낸다 — 기본 fixture의 M54.5(척추로 매핑됨)와 달리 서버가 스스로 완료를
          // 판정할 수 있다.
          patientNo: '',
          diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }],
        },
      },
    };
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN (ws tx)
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID, version: VERSION }] }); // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT (ws tx)
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [] }); // pg_advisory_xact_lock (환자 id별 직렬화)
    mock.mockResolvedValueOnce({
      rows: [{
        patient_person_id: ANON_PERSON_ID, deleted_at: null, revision: 1, assigned_doctor_user_id: USER_ID,
        completion_status: 'draft', server_observed_modules_complete_at: null,
        completion_source: null, completion_client_build_version: null, completion_client_schema_version: null,
        server_verified_modules_complete_at: null, completion_verification_engine_version: null,
      }],
    }); // existing record lookup (FOR UPDATE) — draft, never verified
    mock.mockResolvedValueOnce({ rows: [{ patient_no: null }] }); // SELECT patient_no FOR UPDATE
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE existing person
    mock.mockResolvedValueOnce({ rows: [{ revision: 2, assigned_doctor_user_id: USER_ID }], rowCount: 1 }); // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE workspaces (저장된 환자 revision을 스냅샷에 반영)
    mock.mockResolvedValueOnce({ rows: [WS_ROW] }); // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Completed Visit', patients: [completePatient] });

    expect(res.status).toBe(201);
    const upsertCall = (mock.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE patient_records')
    );
    const params = upsertCall![1] as unknown[];
    expect(params[18]).toBeInstanceOf(Date);
    expect(params[19]).toBe(COMPLETION_ENGINE_VERSION);
  });

  // HF1: 같은 id를 동시에 처음 저장하는 경합은 이제 환자 id별 advisory lock + 일반 INSERT(ON CONFLICT 폐기)로
  // 막는다(workspaces.integration.test.ts가 실DB로 증명). 여기서는 mock으로 SQL 텍스트만 고정한다:
  // 완료 provenance 컬럼(최초 관측 시각·출처·빌드/스키마 버전·서버 검증 시각·엔진 버전)은 기존 행 UPDATE에서도
  // COALESCE로 "최초 한 번 찍히면 불변"을 지키고, completion_status만 "현재 상태"라 그대로 덮어쓴다.
  // 갱신은 클라이언트가 본 revision과 같을 때만 일어난다(revision 조건).
  it('기존 행 UPDATE는 provenance 컬럼 전부에 COALESCE를 쓰고 revision 조건으로만 갱신한다', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    routeQueries(mock, { existing: existingRow() });

    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Visit', patients: [{ ...ANON_PATIENT, sync: { revision: 1 } }] });

    const upsertCall = (mock.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE patient_records')
    );
    expect(upsertCall).toBeDefined();
    const sql = upsertCall![0] as string;
    expect(sql).toContain('server_verified_modules_complete_at    = COALESCE(server_verified_modules_complete_at, $19)');
    expect(sql).toContain('completion_verification_engine_version = COALESCE(completion_verification_engine_version, $20)');
    expect(sql).toContain('server_observed_modules_complete_at = COALESCE(server_observed_modules_complete_at, $15)');
    expect(sql).toContain('completion_source                   = COALESCE(completion_source, $16)');
    expect(sql).toContain('completion_client_build_version     = COALESCE(completion_client_build_version, $17)');
    expect(sql).toContain('completion_client_schema_version    = COALESCE(completion_client_schema_version, $18)');
    // completion_status는 "현재 상태"라 COALESCE 대상이 아니다.
    expect(sql).toContain('completion_status                   = $14');
    expect(sql).toContain('WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND revision = $21');
    expect(sql).not.toContain('ON CONFLICT');
  });

  it('reuses existing anonymous patient_person when patientNo is blank', async () => {
    const ANON_PERSON_ID = '55555555-5555-5555-5555-555555555555';
    const anonymousPatient = { ...ANON_PATIENT, sync: { revision: 1, syncStatus: 'synced' } };
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID, version: VERSION }] }); // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [] }); // pg_advisory_xact_lock (환자 id별 직렬화)
    mock.mockResolvedValueOnce({ rows: [{ patient_person_id: ANON_PERSON_ID, revision: 1, assigned_doctor_user_id: USER_ID }] }); // existing record lookup
    // 기존 person이 이미 익명(patient_no NULL)이므로 그대로 재사용한다.
    // 옛 번호가 남아 있었다면 새 익명 person으로 옮겨야 한다(번호 점유 해제).
    mock.mockResolvedValueOnce({ rows: [{ patient_no: null }] }); // SELECT patient_no FOR UPDATE
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE existing person
    mock.mockResolvedValueOnce({ rows: [{ revision: 2, assigned_doctor_user_id: USER_ID }], rowCount: 1 }); // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE workspaces (저장된 환자 revision을 스냅샷에 반영)
    mock.mockResolvedValueOnce({ rows: [WS_ROW] }); // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Anonymous Visit', patients: [anonymousPatient] });

    expect(res.status).toBe(201);
    const calls = mock.mock.calls as unknown[][];
    const insertPersonCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_persons')
    );
    expect(insertPersonCall).toBeUndefined();

    const upsertCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('UPDATE patient_records')
    );
    expect(upsertCall).toBeDefined();
    expect((upsertCall![1] as unknown[])[2]).toBe(ANON_PERSON_ID);
  });

  it('uses sync.serverId over patient.id when building patient_ids', async () => {
    const SERVER_ID = '44444444-4444-4444-4444-444444444444';
    const patientWithServerId = {
      ...PATIENT_SNAPSHOT,
      sync: { serverId: SERVER_ID, revision: 1, syncStatus: 'synced', lastSyncedAt: null },
    };
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    routeQueries(mock); // 기존 환자 없음 → 새 환자 INSERT 경로

    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Test', patients: [patientWithServerId] });

    const calls = (mock).mock.calls;
    const insertWsCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall).toBeDefined();
    const patientIds = insertWsCall![1][3]; // 4th param: patient_ids
    expect(patientIds).toContain(SERVER_ID);
    expect(patientIds).not.toContain(PAT_ID);

    // patient_records upsert should also use the server ID
    const upsertCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall![1][0]).toBe(SERVER_ID);
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

  it('continues workspace save even if patient_records upsert fails', async () => {
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });  // auth
    mock.mockResolvedValueOnce({ rows: [] });                // BEGIN
    mock.mockResolvedValueOnce({ rows: [] });                // deleted patient check
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID, version: VERSION }] });                // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] });                // COMMIT
    mock.mockResolvedValueOnce({ rows: [] });                // BEGIN (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [] });                // pg_advisory_xact_lock (환자 id별 직렬화)
    mock.mockResolvedValueOnce({ rows: [] });                // SELECT existing patient_records
    mock.mockResolvedValueOnce({ rows: [] });                // SELECT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ id: PERSON_ID }] }); // INSERT patient_persons
    mock.mockRejectedValueOnce(new Error('DB error'));       // upsert fails
    mock.mockResolvedValueOnce({ rows: [] });                // ROLLBACK (환자 트랜잭션)
    mock.mockResolvedValueOnce({ rows: [WS_ROW] });         // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    // Workspace save must succeed despite patient_records failure
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    // HF1: 실패한 환자는 응답에서 error로 제외 보고된다(저장 전체는 성공)
    expect(res.body.skipped).toEqual([{ id: PAT_ID, reason: 'error' }]);
    expect(res.body.saved).toEqual([]);
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

  const lockRow = (over: Record<string, unknown> = {}) => ({
    patient_id: PAT_ID, client_instance_id: 'ci-1', user_id: OTHER_DOCTOR, holder_name: 'Dr. Lee',
    acquired_at: new Date('2026-01-01T00:00:00Z'), expires_at: new Date('2026-01-01T00:01:40Z'),
    lease_token_hash: hashToken('someone-elses-token'), ...over,
  });

  it('담당의 본인이 올바른 revision으로 저장하면 UPDATE되고 saved에 새 revision·담당의가 담긴다', async () => {
    const { res, wrote } = await save({ existing: existingRow() });
    expect(wrote).toBe(true);
    expect(res.body.saved).toEqual([{ id: PAT_ID, revision: 2, assignedDoctorUserId: USER_ID }]);
    expect(res.body.skipped).toEqual([]);
  });

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

  it('담당의가 아니면 쓰지 않고 skipped(not_assigned)로 보고하며 감사에 남긴다', async () => {
    const { res, wrote } = await save({ existing: existingRow({ assigned_doctor_user_id: OTHER_DOCTOR }) });
    expect(wrote).toBe(false);
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([{ id: PAT_ID, reason: 'not_assigned' }]);
    expect(res.body.saved).toEqual([]);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'workspace_patient_write_rejected', targetType: 'patient', targetId: PAT_ID, outcome: 'denied',
    }));
  });

  it('담당의가 없는(NULL) 기존 환자는 admin만 쓸 수 있다 — PATCH와 같은 규칙', async () => {
    const { res, wrote } = await save({ existing: existingRow({ assigned_doctor_user_id: null }) });
    expect(wrote).toBe(false);
    expect(res.body.skipped).toEqual([{ id: PAT_ID, reason: 'not_assigned' }]);
  });

  it('서버 revision이 다르면 쓰지 않고 conflicts로 보고한다', async () => {
    const { res, wrote } = await save({ existing: existingRow({ revision: 3 }), revision: 1 });
    expect(wrote).toBe(false);
    expect(res.body.conflicts).toEqual([{ id: PAT_ID, serverRevision: 3 }]);
    expect(res.body.saved).toEqual([]);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'workspace_patient_write_rejected', outcome: 'failure',
      extra: expect.objectContaining({ kind: 'conflict', serverRevision: 3 }),
    }));
  });

  it('삭제된 환자는 skipped(deleted)이고 감사 소음을 만들지 않는다', async () => {
    const { res, wrote } = await save({ existing: existingRow({ deleted_at: new Date() }) });
    expect(wrote).toBe(false);
    expect(res.body.skipped).toEqual([{ id: PAT_ID, reason: 'deleted' }]);
    expect(writeAuditLog).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'workspace_patient_write_rejected',
    }));
  });

  it('enforce 모드에서 다른 사용자가 락을 쥐면 lockedByOther로 보고하고 holder에 토큰을 싣지 않는다', async () => {
    setLockMode('enforce');
    const { res, wrote } = await save({ existing: existingRow(), lock: lockRow() });
    expect(wrote).toBe(false);
    expect(res.body.lockedByOther).toEqual([{
      id: PAT_ID,
      holder: { holderName: 'Dr. Lee', acquiredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:01:40.000Z' },
    }]);
    expect(JSON.stringify(res.body)).not.toMatch(/lease/i);
    // 감사에는 누가 락을 쥐고 있었는지(holderName만)가 남는다 — 토큰·사용자 id는 없다
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'denied',
      extra: { kind: 'locked', holderName: 'Dr. Lee' },
    }));
  });

  it('enforce 모드에서 lockTokens의 토큰이 락과 일치하면 저장된다(환자 로컬 id로 조회)', async () => {
    setLockMode('enforce');
    const { res, wrote } = await save({
      existing: existingRow(),
      lock: lockRow({ user_id: USER_ID, lease_token_hash: hashToken('my-lease') }),
      extra: { lockTokens: { [PAT_ID]: 'my-lease' } },
    });
    expect(wrote).toBe(true);
    expect(res.body.saved).toEqual([{ id: PAT_ID, revision: 2, assignedDoctorUserId: USER_ID }]);
    expect(res.body.lockedByOther).toEqual([]);
  });

  it('락 모드가 off이면 락이 있어도 막지 않는다(구버전 배포 호환)', async () => {
    const { res, wrote } = await save({ existing: existingRow(), lock: lockRow() });
    expect(wrote).toBe(true);
    expect(res.body.lockedByOther).toEqual([]);
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

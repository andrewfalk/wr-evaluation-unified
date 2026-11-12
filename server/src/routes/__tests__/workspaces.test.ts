import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Workspace routes on the shared test harness (src/testing/) — migrated in S7-1b with the same it titles and
// assertions. The patient_records upsert itself is covered against real PostgreSQL in
// workspaces.integration.test.ts and workspaces.upsert.integration.test.ts (S7-1).

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// HF1: 워크스페이스 저장도 편집 락 게이트를 거친다 — 테스트 중 모드를 바꿀 수 있게 getter로 둔다(lockGate.test.ts와 같은 방식).
const lockMode = vi.hoisted(() => ({ value: 'off' as 'off' | 'observe' | 'enforce' }));
vi.mock('../../config', async () => {
  const cfg = (await import('../../testing/configMock.js')).testConfig();
  Object.defineProperty(cfg, 'lockEnforcementMode', { get: () => lockMode.value, enumerable: true });
  return { default: cfg };
});

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:    vi.fn(),
  auditMiddleware:  vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { writeAuditLog } from '../../middleware/audit';
import { createWorkspacesRouter } from '../workspaces';
import { createFakePool, authSessionHandler, type FakePool, type FakeQueryReply, type QueryHandler } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders, TEST_CSRF_TOKEN } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// CSRF 원문은 testing/tokens 기본값('ok') — 원래 로컬 도우미와 같은 클레임(sub/orgId는 tokens 기본 UUID).
/** Token for an org-scoped user. */
function orgToken(role: 'admin' | 'doctor' = 'doctor'): string {
  return makeAccessToken({ sessionId: 'sess-1', role, name: 'Dr. Kim' });
}

/** Token for a superadmin (null org). */
function superToken(): string {
  return makeAccessToken({
    userId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', sessionId: 'sess-2', orgId: null,
    role: 'admin', name: 'Superadmin',
  });
}

function workspacesApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/workspaces', createWorkspacesRouter(fake.pool)));
}

// 세션 없음(인증 미들웨어가 401) — 원래 테스트는 모든 쿼리에 빈 결과를 줬다.
function noSessionFake(): FakePool {
  return createFakePool({ handlers: [authSessionHandler({ revoked: true })] });
}

// 인증만 통과하고 라우트 쿼리 handler는 테스트가 덧붙인다.
function authedFake(...handlers: QueryHandler[]): FakePool {
  return createFakePool({ handlers: [authSessionHandler(), ...handlers] });
}

// ---- 라우트 쿼리 handler (SQL로 고른다) ----
const listHandler = (reply: FakeQueryReply | Error): QueryHandler =>
  ({ name: 'workspaces.list', match: /FROM workspaces\s+WHERE organization_id = \$1 AND owner_user_id = \$2\s+ORDER BY created_at DESC/, reply });
const getHandler = (reply: FakeQueryReply): QueryHandler =>
  ({ name: 'workspaces.get', match: /FROM workspaces\s+WHERE id = \$1 AND organization_id = \$2 AND owner_user_id = \$3/, reply });
const currentPatientsHandler = (reply: FakeQueryReply): QueryHandler =>
  ({ name: 'patients.current', match: /FROM patient_records\s+WHERE id = ANY\(\$1::uuid\[\]\) AND organization_id = \$2/, reply });
const deleteHandler = (reply: FakeQueryReply): QueryHandler =>
  ({ name: 'workspaces.delete', match: /DELETE FROM workspaces/, reply });

// 저장(POST/PUT) 경로 전체 — 원본 routeQueries(SQL 조각 라우팅)를 handler 목록으로 옮긴 것.
// 순서 큐가 아니므로 쿼리가 추가/재배치돼도 깨지지 않고, 맞지 않는 SQL은 미매치 오류(fake.unmatched)로 드러난다.
interface SaveDb {
  /** 스냅샷 커밋 전 삭제 환자 확인(… FOR SHARE) 결과. */
  deleted?: unknown[];
  /** 기존 patient_records 행(SELECT … FOR UPDATE 결과). */
  existing?: Record<string, unknown> | null;
  lock?: Record<string, unknown> | null;
  /** PUT의 UPDATE workspaces … RETURNING 응답. */
  workspaceUpdate?: FakeQueryReply;
  /** 저장 뒤 스냅샷 revision 보정 UPDATE 응답. */
  stamp?: FakeQueryReply | Error;
  /** 마지막 목록 조회 결과. */
  list?: unknown[];
}

function saveHandlers(db: SaveDb = {}): QueryHandler[] {
  return [
    authSessionHandler(),
    { name: 'patients.deletedCheck', match: /FROM patient_records\s+WHERE organization_id = \$1 AND id = ANY\(\$2::uuid\[\]\)\s+FOR SHARE/, reply: { rows: db.deleted ?? [] } },
    { name: 'workspaces.insert', match: /INSERT INTO workspaces/, reply: { rows: [{ id: WS_ID, version: VERSION }], rowCount: 1 } },
    { name: 'workspaces.update', match: /UPDATE workspaces\s+SET name = \$4/, reply: db.workspaceUpdate ?? { rows: [{ version: VERSION }], rowCount: 1 } },
    { name: 'patients.advisoryLock', match: /pg_advisory_xact_lock/, reply: { rows: [] } },
    { name: 'patients.lockForUpdate', match: /FROM patient_records\s+WHERE id = \$1 AND organization_id = \$2\s+FOR UPDATE/, reply: { rows: db.existing ? [db.existing] : [] } },
    { name: 'patientLocks.read', match: /FROM patient_locks/, reply: { rows: db.lock ? [db.lock] : [] } },
    { name: 'persons.currentNo', match: /SELECT patient_no FROM patient_persons/, reply: { rows: [{ patient_no: null }] } },
    { name: 'persons.update', match: /UPDATE patient_persons/, reply: { rows: [], rowCount: 1 } },
    { name: 'persons.insert', match: /INSERT INTO patient_persons/, reply: { rows: [{ id: PERSON_ID }] } },
    { name: 'persons.lookup', match: /FROM patient_persons/, reply: { rows: [] } },
    { name: 'patients.insert', match: /INSERT INTO patient_records/, reply: { rows: [{ revision: 1, assigned_doctor_user_id: USER_ID }], rowCount: 1 } },
    { name: 'patients.update', match: /UPDATE patient_records/, reply: { rows: [{ revision: 2, assigned_doctor_user_id: USER_ID }], rowCount: 1 } },
    { name: 'workspaces.stamp', match: /jsonb_to_recordset/, reply: db.stamp ?? { rows: [], rowCount: 1 } },
    listHandler({ rows: db.list ?? [WS_ROW] }),
  ];
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
    const fake = noSessionFake();
    const res = await request(workspacesApp(fake)).get('/api/workspaces');
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty items for superadmin (null org)', async () => {
    const fake = authedFake();
    const res = await request(workspacesApp(fake))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    // No second DB query — superadmin short-circuits before listing
    expect(fake.calls.length).toBe(1);
  });

  it('returns 200 with workspace list for org user', async () => {
    const fake = authedFake(listHandler({ rows: [WS_ROW] }));
    const res = await request(workspacesApp(fake))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: WS_ID, name: 'Visit 2024', count: 1 });
  });

  it('answers a DB failure with the 500 envelope (central error handler, S1)', async () => {
    const fake = authedFake(listHandler(new Error('connection terminated')));
    const res = await request(workspacesApp(fake))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`);
    // 500의 원인이 목록 쿼리 handler의 오류여야 한다 — 미매치 오류로 우연히 500이 된 것이 아님
    fake.assertNoUnmatched();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
  });

  it('returns 200 with empty list when user has no workspaces', async () => {
    const fake = authedFake(listHandler({ rows: [] }));
    const res = await request(workspacesApp(fake))
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
    const fake = noSessionFake();
    const res = await request(workspacesApp(fake)).get(`/api/workspaces/${WS_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const fake = authedFake();
    const res = await request(workspacesApp(fake))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found', async () => {
    const fake = authedFake(getHandler({ rows: [] }));
    const res = await request(workspacesApp(fake))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with snapshot payload (default)', async () => {
    const fake = authedFake(getHandler({ rows: [WS_ROW] }));
    const res = await request(workspacesApp(fake))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(WS_ITEM);
    expect(res.body.view).toBeUndefined();
  });

  it('returns live patient payload for ?view=current', async () => {
    const live = { ...PATIENT_SNAPSHOT, data: { ...PATIENT_SNAPSHOT.data, shared: { ...PATIENT_SNAPSHOT.data.shared, name: 'Kim Updated' } } };
    const fake = authedFake(
      getHandler({ rows: [WS_ROW] }),
      currentPatientsHandler({ rows: [{ id: PAT_ID, deleted_at: null, payload: live }] }),
    );
    const res = await request(workspacesApp(fake))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('current');
    expect(res.body.patients).toHaveLength(1);
    expect((res.body.patients[0] as typeof live).data.shared.name).toBe('Kim Updated');
  });

  it('returns redacted stub for patient not in patient_records', async () => {
    const fake = authedFake(getHandler({ rows: [WS_ROW] }), currentPatientsHandler({ rows: [] }));
    const res = await request(workspacesApp(fake))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients[0]).toEqual({ id: PAT_ID, redacted: true });
  });

  it('returns redacted stub for soft-deleted patient', async () => {
    const fake = authedFake(
      getHandler({ rows: [WS_ROW] }),
      currentPatientsHandler({ rows: [{ id: PAT_ID, deleted_at: new Date(), payload: {} }] }),
    );
    const res = await request(workspacesApp(fake))
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
    const fake = noSessionFake();
    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set('x-csrf-token', TEST_CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const fake = authedFake();
    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(superToken()))
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 400 for empty name', async () => {
    const fake = authedFake();
    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send({ name: '', patients: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 for patients not array', async () => {
    const fake = authedFake();
    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send({ name: 'Test', patients: 'not-array' });
    expect(res.status).toBe(400);
  });

  // snapshot을 커밋하기 *전에* 막아야 한다. patient upsert는 커밋 이후 best-effort로
  // 돌면서 오류를 삼키므로, 거기서 검증하면 API는 201을 반환하고 오염된 생년월일은
  // 이미 snapshot_payload에 저장된 뒤가 된다.
  it('오염된 생년월일이 있으면 400이고 workspace 행을 만들지 않는다', async () => {
    const fake = authedFake();

    const badPatient = {
      ...PATIENT_SNAPSHOT,
      data: {
        ...PATIENT_SNAPSHOT.data,
        shared: { ...PATIENT_SNAPSHOT.data.shared, birthDate: '4110-02-12' },
      },
    };

    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send({ name: 'Bad Visit', patients: [badPatient] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BIRTH_DATE');
    expect(res.body.fields[0]).toMatchObject({ field: 'birthDate', reason: 'future' });

    // snapshot 트랜잭션 자체가 열리지 않아야 한다
    expect(fake.connected).toBe(0);
    const insertWs = fake.calls.find((c) => c.sql.includes('INSERT INTO workspaces'));
    expect(insertWs).toBeUndefined();
    // 날짜 값 자체는 PHI이므로 응답에 되싣지 않는다
    expect(JSON.stringify(res.body)).not.toContain('4110-02-12');
  });

  it('redacts soft-deleted patients before saving a new workspace snapshot', async () => {
    const fake = createFakePool({
      handlers: saveHandlers({
        deleted: [{ id: PAT_ID, deleted_at: new Date('2024-02-01T00:00:00Z') }],
        list:    [{ ...WS_ROW, snapshot_payload: [{ id: PAT_ID, redacted: true }] }],
      }),
    });

    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send(VALID_BODY);

    fake.assertNoUnmatched();
    expect(res.status).toBe(201);
    const calls = fake.calls;
    const insertWsCall = calls.find((c) => c.sql.includes('INSERT INTO workspaces'));
    expect(insertWsCall).toBeDefined();
    expect(JSON.parse(insertWsCall!.params[4] as string)).toEqual([
      { id: PAT_ID, redacted: true },
    ]);

    const upsertCall = calls.find((c) => c.sql.includes('INSERT INTO patient_records'));
    expect(upsertCall).toBeUndefined();
  });

  it('ignores patients with non-UUID or missing id', async () => {
    const fake = createFakePool({ handlers: saveHandlers({ list: [] }) });

    await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send({ name: 'Test', patients: [{ id: 'local-123' }, { id: 'not-a-uuid' }] });

    fake.assertNoUnmatched();
    const calls = fake.calls;
    const insertWsCall = calls.find((c) => c.sql.includes('INSERT INTO workspaces'));
    expect(insertWsCall!.params[3]).toEqual([]); // patient_ids empty

    // No patient_records upsert (name is missing → meta returns null)
    const upsertCall = calls.find((c) => c.sql.includes('INSERT INTO patient_records'));
    expect(upsertCall).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// PUT /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('PUT /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = noSessionFake();
    const res = await request(workspacesApp(fake))
      .put(`/api/workspaces/${WS_ID}`)
      .set('x-csrf-token', TEST_CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found or not owned', async () => {
    const fake = createFakePool({ handlers: saveHandlers({ workspaceUpdate: { rows: [], rowCount: 0 } }) });

    const res = await request(workspacesApp(fake))
      .put(`/api/workspaces/${WS_ID}`)
      .set(authHeaders(orgToken()))
      .send(VALID_BODY);

    fake.assertNoUnmatched();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with updated list on overwrite success', async () => {
    const updatedRow = { ...WS_ROW, name: 'New Visit' };
    const fake = createFakePool({ handlers: saveHandlers({ list: [updatedRow] }) });

    const res = await request(workspacesApp(fake))
      .put(`/api/workspaces/${WS_ID}`)
      .set(authHeaders(orgToken()))
      .send(VALID_BODY);

    fake.assertNoUnmatched();
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('New Visit');

    const calls = fake.calls;
    const updateWsCall = calls.find((c) => c.sql.includes('UPDATE workspaces'));
    expect(updateWsCall).toBeDefined();
    expect(updateWsCall!.params[0]).toBe(WS_ID);

    const insertWsCall = calls.find((c) => c.sql.includes('INSERT INTO workspaces'));
    expect(insertWsCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = noSessionFake();
    const res = await request(workspacesApp(fake))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('x-csrf-token', TEST_CSRF_TOKEN);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const fake = authedFake();
    const res = await request(workspacesApp(fake))
      .delete(`/api/workspaces/${WS_ID}`)
      .set(authHeaders(superToken()));
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found or not owned', async () => {
    const fake = authedFake(deleteHandler({ rows: [], rowCount: 0 }));
    const res = await request(workspacesApp(fake))
      .delete(`/api/workspaces/${WS_ID}`)
      .set(authHeaders(orgToken()));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with updated list on success', async () => {
    const fake = authedFake(
      deleteHandler({ rows: [], rowCount: 1 }),
      listHandler({ rows: [] }),
    );
    const res = await request(workspacesApp(fake))
      .delete(`/api/workspaces/${WS_ID}`)
      .set(authHeaders(orgToken()));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HF1: 기존 환자에 대한 쓰기 규칙(담당의 / revision / 편집 락) — SQL로 고르는 가짜 Pool.
// 실DB 동시성은 workspaces.integration.test.ts가 증명한다. 여기는 DB 없이도 도는 회귀 방어선이다.
// ---------------------------------------------------------------------------
describe('POST /api/workspaces — 기존 환자 쓰기 규칙 (HF1)', () => {
  const OTHER_DOCTOR = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const setLockMode = (mode: 'off' | 'observe' | 'enforce') => {
    lockMode.value = mode;
  };

  beforeEach(() => { vi.mocked(writeAuditLog).mockClear(); });
  afterEach(() => { setLockMode('off'); });

  async function save(opts: {
    existing?: Record<string, unknown> | null;
    lock?: Record<string, unknown> | null;
    revision?: number;
    extra?: Record<string, unknown>;
  }) {
    const fake = createFakePool({ handlers: saveHandlers({ existing: opts.existing ?? null, lock: opts.lock ?? null }) });
    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send({ name: 'HF1', patients: [{ ...ANON_PATIENT, sync: { revision: opts.revision ?? 1 } }], ...opts.extra });
    // 모든 쿼리가 handler에 맞았어야 한다 — 미매치 오류로 upsert가 실패해 "보정 UPDATE 없음"이 우연히 성립하지 않게.
    fake.assertNoUnmatched();
    return { res, calls: fake.calls };
  }

  it('저장된 환자의 확정 revision·담당의를 스냅샷에 찍는다 — 가려진 항목·나중 저장본은 건드리지 않는 조건으로', async () => {
    const { res, calls } = await save({ existing: existingRow() });
    const stamp = calls.find((c) => c.sql.includes('jsonb_to_recordset'));
    expect(stamp).toBeDefined();
    const [stampsJson, workspaceId, orgId, userId, version] = stamp!.params as string[];
    expect(JSON.parse(stampsJson)).toEqual([{ id: PAT_ID, revision: 2, assigned: USER_ID }]);
    // 소유자·조직·"내가 기록한 저장본" 조건으로만 갱신한다
    expect([workspaceId, orgId, userId, version]).toEqual([WS_ID, ORG_ID, USER_ID, VERSION]);
    const sql = stamp!.sql;
    expect(sql).toContain("NOT (e.elem ? 'redacted')");     // 삭제로 가려진 항목은 건드리지 않는다
    expect(sql).toContain('created_at = $5::timestamptz');   // 나중 저장이 덮어쓴 행에는 적용하지 않는다
    expect(res.status).toBe(201);
  });

  it('저장된 환자가 없으면(전부 제외) 스냅샷 보정 UPDATE를 하지 않는다', async () => {
    const { calls } = await save({ existing: existingRow({ assigned_doctor_user_id: OTHER_DOCTOR }) });
    expect(calls.some((c) => c.sql.includes('jsonb_to_recordset'))).toBe(false);
  });

  it('스냅샷 보정이 실패해도 저장은 성공으로 응답한다(환자 기록은 이미 저장됨)', async () => {
    const fake = createFakePool({ handlers: saveHandlers({ existing: existingRow(), stamp: new Error('stamp failed') }) });
    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send({ name: 'HF1', patients: [{ ...ANON_PATIENT, sync: { revision: 1 } }] });
    // 보정 실패는 handler가 던진 'stamp failed'여야 한다 — 미매치 오류가 대신 실패시킨 것이 아님
    fake.assertNoUnmatched();
    expect(res.status).toBe(201);
    expect(res.body.saved).toHaveLength(1);
  });

  it('lockTokens 값이 비어 있거나 너무 길면 400', async () => {
    const fake = createFakePool({ handlers: saveHandlers() });
    const res = await request(workspacesApp(fake))
      .post('/api/workspaces')
      .set(authHeaders(orgToken()))
      .send({ name: 'HF1', patients: [ANON_PATIENT], lockTokens: { [PAT_ID]: 'x'.repeat(257) } });
    expect(res.status).toBe(400);
  });
});

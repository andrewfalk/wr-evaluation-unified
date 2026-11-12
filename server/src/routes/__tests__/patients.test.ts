// Patients routes (list · read · lease lock · doctor-counts · birth-date 400) on the shared test harness
// (src/testing/) — migrated in S7-8b with the same it titles and assertions. Query replies are chosen by SQL
// (table and key clause fragments, whitespace-tolerant), not by call order. The write paths (create, PATCH,
// delete, assignment, identity correction) run against real PostgreSQL in patients.*.integration.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// 원본 config mock과 같은 값 — 'off'가 기본값(testConfig 기본과 같음). 이 파일의 어떤 테스트도 락 모드를
// 바꾸지 않으므로 가변 getter는 두지 않는다.
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig({ lockEnforcementMode: 'off' }),
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:       vi.fn(),
  writeAuditLogStrict: vi.fn(),
  auditFailuresOnly:   (ctx: { status: number }) => ctx.status >= 400,
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createPatientsRouter } from '../patients';
import { requestIdMiddleware } from '../../http/requestId';
import { writeAuditLog } from '../../middleware/audit';
import { createFakePool, authSessionHandler, type FakePool, type QueryHandler } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// 원래 로컬 도우미와 같은 클레임(CSRF 원문 'ok' = tokens 기본값, sub/orgId는 tokens 기본 UUID = 원래 상수).
function orgToken(): string {
  return makeAccessToken({ sessionId: 'sess-1', role: 'doctor', name: 'Dr. Kim' });
}

function superToken(): string {
  return makeAccessToken({
    userId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', sessionId: 'sess-2', orgId: null,
    role: 'admin', name: 'Superadmin',
  });
}

function adminToken(): string {
  return makeAccessToken({ userId: ADMIN_ID, sessionId: 'sess-3', role: 'admin', name: 'Admin User' });
}

// 원래 makeApp과 같은 구성: json → cookieParser → 요청 ID(createApp과 같이, S1) → 라우터 → 중앙 에러 처리기.
// makeRouterApp은 요청 ID 미들웨어를 붙이지 않으므로 mount 안에서 라우터 앞에 붙인다 —
// 500 테스트가 X-Request-Id를 오류 본문의 requestId로 돌려받는다.
function patientsApp(fake: FakePool) {
  return makeRouterApp((a) => {
    a.use(requestIdMiddleware());
    a.use('/api/patients', createPatientsRouter(fake.pool));
  });
}

// 인증만 통과하고 라우트 쿼리 handler는 테스트가 덧붙인다(넣지 않은 쿼리는 미매치 오류 → fake.unmatched).
function authedFake(...handlers: QueryHandler[]): FakePool {
  return createFakePool({ handlers: [authSessionHandler(), ...handlers] });
}

/** 오류 경로 테스트용: 실패 원인 handler가 실제로 응답했는지(expect 수를 바꾸지 않도록 throw로). */
function assertHandled(fake: FakePool, name: string): void {
  if (fake.callsTo(name).length === 0) throw new Error(`handler ${name} was never called`);
}

// ---- 목록(GET /api/patients) handler ----
interface ListDb {
  /** scope=<doctorId> 검증 쿼리(SELECT 1 FROM patient_records … LIMIT 1) 결과. 생략하면 handler 없음 — 검증 쿼리가 나가면 미매치. */
  scopeCheck?: unknown[];
  items: unknown[];
  /** 필터(scope) 조건이 붙은 COUNT. */
  total: string;
  /** 담당의 미배정 COUNT. */
  unassigned: string;
  /** 조직 전체 COUNT. */
  org: string;
}

// COUNT 세 문장은 Promise.all로 나가므로 순서가 아니라 WHERE 조건으로 고른다. scope가 all/__unassigned__이면
// 필터 COUNT가 조직/미배정 COUNT와 같은 SQL이 되므로 같은 답을 받는다(실제 DB와 같이).
function listHandlers(db: ListDb): QueryHandler[] {
  const handlers: QueryHandler[] = [];
  if (db.scopeCheck) {
    handlers.push({ name: 'patients.scopeCheck', match: /SELECT\s+1\s+FROM\s+patient_records/, reply: { rows: db.scopeCheck } });
  }
  handlers.push(
    { name: 'patients.list', match: /FROM\s+patient_records[\s\S]*ORDER\s+BY\s+updated_at/, reply: { rows: db.items } },
    {
      name: 'patients.count.unassigned',
      match: /COUNT\(\*\)[\s\S]*FROM\s+patient_records[\s\S]*assigned_doctor_user_id\s+IS\s+NULL/,
      reply: { rows: [{ total: db.unassigned }] },
    },
    {
      name: 'patients.count.filtered',
      match: /COUNT\(\*\)[\s\S]*FROM\s+patient_records[\s\S]*(assigned_doctor_user_id\s*=|FALSE)/,
      reply: { rows: [{ total: db.total }] },
    },
    { name: 'patients.count.org', match: /COUNT\(\*\)[\s\S]*FROM\s+patient_records/, reply: { rows: [{ total: db.org }] } },
  );
  return handlers;
}

const doctorCountsHandler = (rows: unknown[]): QueryHandler =>
  ({ name: 'patients.doctorCounts', match: /FROM\s+patient_records\s+pr\b[\s\S]*GROUP\s+BY/, reply: { rows } });

// GET /:id 단건 조회(잠금 없음).
const readHandler = (rows: unknown[]): QueryHandler =>
  ({ name: 'patients.read', match: (sql) => /FROM\s+patient_records/.test(sql) && !/FOR\s+UPDATE/.test(sql), reply: { rows } });

// ---- 락 경로 handler ----
// 원래 makeClientSetup의 순서 큐(BEGIN/anchor/…/COMMIT)를 SQL로 고르는 handler로 옮긴 것. BEGIN/COMMIT/ROLLBACK은
// fakePool 기본 처리(기록만) — 트랜잭션 결과는 fake.transactions에 남는다.
interface LockDb {
  /** requirePatientAccess 미들웨어(pool, patient_records 조회) 결과. withAccessCheck: {} = 담당의 USER_ID. */
  access?: unknown[];
  /** 트랜잭션 안 앵커(patient_records … FOR UPDATE) 결과. */
  anchor?: unknown[];
  /** acquireLock UPSERT(INSERT INTO patient_locks … ON CONFLICT … WHERE) RETURNING. */
  acquire?: unknown[];
  /** forceLock UPSERT(조건 없는 덮어쓰기) RETURNING. */
  force?: unknown[];
  /** renewLock UPDATE patient_locks … RETURNING. */
  renew?: unknown[];
  /** peekLock SELECT … FROM patient_locks. */
  peek?: unknown[];
  /** releaseLock DELETE FROM patient_locks. */
  release?: unknown[];
}

function lockHandlers(db: LockDb): QueryHandler[] {
  const h: QueryHandler[] = [];
  if (db.anchor) h.push({ name: 'patients.anchor', match: /FROM\s+patient_records[\s\S]*FOR\s+UPDATE/, reply: { rows: db.anchor } });
  if (db.access) {
    h.push({ name: 'patients.access', via: 'pool', match: (sql) => /FROM\s+patient_records/.test(sql) && !/FOR\s+UPDATE/.test(sql), reply: { rows: db.access } });
  }
  if (db.acquire) h.push({ name: 'locks.acquire', match: /INSERT\s+INTO\s+patient_locks[\s\S]*DO\s+UPDATE[\s\S]*\bWHERE\b/, reply: { rows: db.acquire } });
  if (db.force) {
    h.push({ name: 'locks.force', match: (sql) => /INSERT\s+INTO\s+patient_locks/.test(sql) && !/\bWHERE\b/.test(sql), reply: { rows: db.force } });
  }
  if (db.renew) h.push({ name: 'locks.renew', match: /UPDATE\s+patient_locks/, reply: { rows: db.renew } });
  if (db.peek) h.push({ name: 'locks.peek', match: /SELECT[\s\S]*FROM\s+patient_locks/, reply: { rows: db.peek } });
  if (db.release) h.push({ name: 'locks.release', match: /DELETE\s+FROM\s+patient_locks/, reply: { rows: db.release } });
  return h;
}

function lockFake(db: LockDb): FakePool {
  return authedFake(...lockHandlers(db));
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const PAT_ID  = '11111111-1111-1111-1111-111111111111';
const PERSON_ID = '99999999-9999-9999-9999-999999999999';
const ORG_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const IDEMP_KEY = 'idem-key-0000-0000-0000-000000000001';

const NOW       = new Date('2024-06-01T10:00:00Z');
const LATER     = new Date('2024-06-01T11:00:00Z');

const SHARED = {
  name: 'Kim', patientNo: 'P001', birthDate: '1980-01-01',
  injuryDate: '2024-01-01', evaluationDate: '2024-06-01', diagnoses: [{ code: 'M54.5' }],
  jobs: [{ jobName: '사무직' }],
};

const VALID_DATA = {
  shared:        SHARED,
  modules:       {},
  activeModules: ['knee'],
};

const CREATE_BODY = { id: PAT_ID, phase: 'evaluation', data: VALID_DATA };

const DOCTOR_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ADMIN_ID  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const PAT_ROW: Record<string, unknown> = {
  id:              PAT_ID,
  organization_id: ORG_ID,
  patient_person_id: PERSON_ID,
  owner_user_id:   USER_ID,
  assigned_doctor_user_id: USER_ID,
  name:            'Kim',
  patient_no:      'P001',
  birth_date:      '1980-01-01',
  injury_date:     '2024-01-01',
  evaluation_date: '2024-06-01',
  active_modules:  ['knee'],
  diagnoses_codes: ['M54.5'],
  jobs_names:      ['사무직'],
  revision:        1,
  created_at:      NOW,
  updated_at:      NOW,
  payload:         { id: PAT_ID, phase: 'evaluation', createdAt: NOW.toISOString(), data: VALID_DATA },
  completion_status: 'draft',
  server_observed_modules_complete_at: null,
  completion_source: null,
  completion_client_build_version: null,
  completion_client_schema_version: null,
  server_verified_modules_complete_at: null,
  completion_verification_engine_version: null,
};

// ---------------------------------------------------------------------------
// GET /api/patients
// ---------------------------------------------------------------------------
describe('GET /api/patients', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = createFakePool({ handlers: [authSessionHandler({ revoked: true })] });
    const res = await request(patientsApp(fake)).get('/api/patients');
    expect(res.status).toBe(401);
    fake.assertNoUnmatched();
  });

  it('returns 403 for superadmin (null org)', async () => {
    const fake = authedFake();
    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('answers a DB failure with the 500 envelope carrying the request id (central error handler, S1)', async () => {
    const fake = authedFake({ name: 'patients.dbDown', match: /FROM\s+patient_records/, reply: new Error('connection terminated') });
    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-Request-Id', 'req-p1-07');
    expect(res.status).toBe(500);
    expect(res.headers['x-request-id']).toBe('req-p1-07');
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error', requestId: 'req-p1-07' });
    fake.assertNoUnmatched();
    assertHandled(fake, 'patients.dbDown');
  });

  it('returns 200 with items and total', async () => {
    const fake = authedFake(...listHandlers({ items: [PAT_ROW], total: '1', unassigned: '0', org: '1' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.orgPatientCount).toBe(1);
    expect(res.body.items[0].id).toBe(PAT_ID);
    expect(res.body.items[0].sync.serverId).toBe(PAT_ID);
    expect(res.body.items[0].sync.syncStatus).toBe('synced');

    const itemsCall = fake.callsTo('patients.list')[0];
    expect(itemsCall.sql).toContain('assigned_doctor_user_id');
    expect(itemsCall.params).toContain(USER_ID);
  });

  it('includes top-level updatedAt and createdAt on each item', async () => {
    const fake = authedFake(...listHandlers({ items: [PAT_ROW], total: '1', unassigned: '0', org: '1' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.updatedAt).toBe(NOW.toISOString());
    expect(item.createdAt).toBe(NOW.toISOString());
  });

  it('overrides stale payload updatedAt with DB updated_at', async () => {
    const stalePayloadRow = {
      ...PAT_ROW,
      updated_at: LATER,
      payload: {
        ...(PAT_ROW.payload as Record<string, unknown>),
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    };
    const fake = authedFake(...listHandlers({ items: [stalePayloadRow], total: '1', unassigned: '0', org: '1' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].updatedAt).toBe(LATER.toISOString());
  });

  it('preserves payload createdAt when present, falls back to DB created_at when missing', async () => {
    const payloadCreatedAt = '2023-12-15T08:30:00.000Z';
    const withPayloadCreatedAt = {
      ...PAT_ROW,
      payload: {
        ...(PAT_ROW.payload as Record<string, unknown>),
        createdAt: payloadCreatedAt,
      },
    };
    const { createdAt: _omit, ...payloadWithoutCreatedAt } = PAT_ROW.payload as Record<string, unknown>;
    const noPayloadCreatedAt = {
      ...PAT_ROW,
      id: '22222222-2222-2222-2222-222222222222',
      payload: payloadWithoutCreatedAt,
    };
    const fake = authedFake(...listHandlers({ items: [withPayloadCreatedAt, noPayloadCreatedAt], total: '2', unassigned: '0', org: '2' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].createdAt).toBe(payloadCreatedAt);
    expect(res.body.items[1].createdAt).toBe(NOW.toISOString());
  });

  it('defaults admin patient list scope to all', async () => {
    const fake = authedFake(...listHandlers({ items: [PAT_ROW], total: '1', unassigned: '0', org: '1' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const itemsCall = fake.callsTo('patients.list')[0];
    expect(itemsCall.sql).not.toMatch(/AND\s+assigned_doctor_user_id\s*=/);
    expect(itemsCall.params).toEqual([ORG_ID, 20, 0]);
  });

  it('allows admin to explicitly request mine scope', async () => {
    const fake = authedFake(...listHandlers({ items: [], total: '0', unassigned: '0', org: '0' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients?scope=mine')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const itemsCall = fake.callsTo('patients.list')[0];
    expect(itemsCall.sql).toContain('assigned_doctor_user_id');
    expect(itemsCall.params).toContain(ADMIN_ID);
  });

  it('returns 200 with empty result', async () => {
    const fake = authedFake(...listHandlers({ items: [], total: '0', unassigned: '0', org: '0' }));
    const res = await request(patientsApp(fake))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
    expect(res.body.unassignedCount).toBe(0);
    expect(res.body.orgPatientCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/patients — scope 확장 (특정 의사 / 미배정 / invalid)
// ---------------------------------------------------------------------------
describe('GET /api/patients — scope 확장', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('scope=<doctorId> (담당 환자 보유) → 그 의사로 필터', async () => {
    const fake = authedFake(...listHandlers({
      scopeCheck: [{ '?column?': 1 }],                     // scope 검증: 담당 환자 있음
      items: [PAT_ROW], total: '1', unassigned: '0', org: '5',
    }));

    const res = await request(patientsApp(fake))
      .get(`/api/patients?scope=${DOCTOR_ID}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // 검증 쿼리가 assigned_doctor_user_id로 조회됐는지
    const validateCall = fake.callsTo('patients.scopeCheck')[0];
    expect(validateCall.sql).toContain('assigned_doctor_user_id');
    expect(validateCall.params).toEqual([ORG_ID, DOCTOR_ID]);
    // items 쿼리가 해당 의사로 필터됐는지
    const itemsCall = fake.callsTo('patients.list')[0];
    expect(itemsCall.sql).toContain('assigned_doctor_user_id');
    expect(itemsCall.params).toContain(DOCTOR_ID);
  });

  it('scope=<doctorId> (담당 환자 없음) → invalid, 전체로 fallback 안 함 (빈 결과)', async () => {
    const fake = authedFake(...listHandlers({
      scopeCheck: [],                                      // scope 검증: 담당 환자 없음 → invalid
      items: [], total: '0', unassigned: '0', org: '5',
    }));

    const res = await request(patientsApp(fake))
      .get(`/api/patients?scope=${DOCTOR_ID}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    const itemsCall = fake.callsTo('patients.list')[0];
    expect(itemsCall.sql).toContain('FALSE');
    // 전체(all)로 새지 않았음: assigned 필터도 아니고 조건 없음도 아님
    expect(itemsCall.sql).not.toMatch(/AND\s+assigned_doctor_user_id\s*=/);
  });

  it('scope=__unassigned__ → assigned NULL 필터 (검증 쿼리 없음)', async () => {
    // scopeCheck handler를 두지 않는다 — 검증 쿼리가 나가면 미매치 오류(→ 500)로 실패한다.
    const fake = authedFake(...listHandlers({ items: [], total: '0', unassigned: '3', org: '5' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients?scope=__unassigned__')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // 검증 쿼리 없이 바로 items (scopeCheck handler 없음 + 미매치 없음으로 확인)
    fake.assertNoUnmatched();
    const itemsCall = fake.callsTo('patients.list')[0];
    expect(itemsCall.sql).toContain('assigned_doctor_user_id IS NULL');
  });

  it('scope=아무문자열(비-UUID) → invalid, FALSE 조건 (전체 fallback 금지)', async () => {
    // 비-UUID는 검증 쿼리 없이 invalid — scopeCheck handler를 두지 않는다.
    const fake = authedFake(...listHandlers({ items: [], total: '0', unassigned: '0', org: '5' }));

    const res = await request(patientsApp(fake))
      .get('/api/patients?scope=not-a-scope')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    fake.assertNoUnmatched();
    const itemsCall = fake.callsTo('patients.list')[0];
    expect(itemsCall.sql).toContain('FALSE');
  });
});

// ---------------------------------------------------------------------------
// GET /api/patients/doctor-counts — 의사별 환자 수 명부
// ---------------------------------------------------------------------------
describe('GET /api/patients/doctor-counts', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('/:id 라우트에 먹히지 않고 명부를 반환 (라우트 순서)', async () => {
    // readHandler를 두지 않는다 — getPatient(:id)로 갔다면 미매치 오류가 된다.
    const fake = authedFake(doctorCountsHandler([
      { user_id: USER_ID, name: 'Dr. Kim', count: 5 },
      { user_id: null,    name: null,      count: 3 },
    ]));

    const res = await request(patientsApp(fake))
      .get('/api/patients/doctor-counts')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // getPatient(:id)였다면 doctors 필드가 없고 404였을 것
    expect(Array.isArray(res.body.doctors)).toBe(true);
    expect(res.body.doctors).toEqual([{ userId: USER_ID, name: 'Dr. Kim', count: 5 }]);
    expect(res.body.unassignedCount).toBe(3);
  });

  it('count 내림차순 정렬, 미배정은 doctors에서 분리', async () => {
    const fake = authedFake(doctorCountsHandler([
      { user_id: 'A', name: '박철수', count: 2 },
      { user_id: 'B', name: '이영희', count: 9 },
      { user_id: null, name: null, count: 4 },
    ]));

    const res = await request(patientsApp(fake))
      .get('/api/patients/doctor-counts')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.doctors.map((d: { userId: string }) => d.userId)).toEqual(['B', 'A']);
    expect(res.body.unassignedCount).toBe(4);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const fake = authedFake();
    const res = await request(patientsApp(fake))
      .get('/api/patients/doctor-counts')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });
});

// ---------------------------------------------------------------------------
// GET /api/patients/:id
// ---------------------------------------------------------------------------
describe('GET /api/patients/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 404 when patient not found', async () => {
    const fake = authedFake(readHandler([]));
    const res = await request(patientsApp(fake))
      .get(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
    fake.assertNoUnmatched();
    assertHandled(fake, 'patients.read');
  });

  it('returns 200 with full patient response', async () => {
    const fake = authedFake(readHandler([PAT_ROW]));
    const res = await request(patientsApp(fake))
      .get(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PAT_ID);
    expect(res.body.sync.revision).toBe(1);
  });

  it('GET /:id 응답에도 top-level updatedAt/createdAt이 포함된다', async () => {
    const fake = authedFake(readHandler([PAT_ROW]));
    const res = await request(patientsApp(fake))
      .get(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe(NOW.toISOString());
    expect(res.body.createdAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// POST /api/patients
// ---------------------------------------------------------------------------
describe('POST /api/patients', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when Idempotency-Key is missing', async () => {
    const fake = authedFake();
    const res = await request(patientsApp(fake))
      .post('/api/patients')
      .set(authHeaders(orgToken()))
      .send(CREATE_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    fake.assertNoUnmatched();
  });

  it('returns 400 when body is invalid', async () => {
    // Body validation happens before any DB call (idempotency slot not reserved)
    const fake = authedFake();
    const res = await request(patientsApp(fake))
      .post('/api/patients')
      .set(authHeaders(orgToken()))
      .set('idempotency-key', IDEMP_KEY)
      .send({ phase: 'evaluation' }); // missing data
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    fake.assertNoUnmatched();
  });

  it('returns 400 when patient name is missing', async () => {
    // Name check happens before any DB call (idempotency slot not reserved)
    const fake = authedFake();
    const noName = { ...CREATE_BODY, data: { ...VALID_DATA, shared: { ...SHARED, name: '' } } };
    const res = await request(patientsApp(fake))
      .post('/api/patients')
      .set(authHeaders(orgToken()))
      .set('idempotency-key', IDEMP_KEY)
      .send(noName);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    fake.assertNoUnmatched();
  });

  // PR0-A: 신규 환자도 생성 시점에 이미 모든 모듈이 완료돼 있을 수 있다 — PATCH 경로에만
  // 완료 추적을 넣으면 이후 수정이 없는 한 완료시각이 영구히 비게 된다(§Context).
  describe('완료시각 추적 (modulesCompleteObserved)', () => {

    it('modulesCompleteObserved=true인데 버전 필드가 없으면 400을 반환한다', async () => {
      const fake = authedFake();
      const res = await request(patientsApp(fake))
        .post('/api/patients')
        .set(authHeaders(orgToken()))
        .set('idempotency-key', IDEMP_KEY)
        .send({ ...CREATE_BODY, modulesCompleteObserved: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_BODY');
      fake.assertNoUnmatched();
    });
  });
});

// ---------------------------------------------------------------------------
// 환자 단위 TTL lease lock 엔드포인트
// ---------------------------------------------------------------------------
const CLIENT_INSTANCE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const LOCK_ROW = {
  patient_id: PAT_ID,
  client_instance_id: CLIENT_INSTANCE_ID,
  user_id: USER_ID,
  holder_name: 'Dr. Kim',
  acquired_at: NOW,
  expires_at: LATER,
};
// 원래 withAccessCheck: {} — 미들웨어 조회가 담당의 USER_ID(= 기본 caller)를 돌려준다.
const ACCESS_OK = [{ assigned_doctor_user_id: USER_ID }];

describe('POST /api/patients/:id/lock', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('토큰 없음 + force 없음 → acquire, 잠겨있지 않으면 200 + leaseToken 발급', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }],
      acquire: [LOCK_ROW],  // acquireLock INSERT...RETURNING
    });
    const res = await request(patientsApp(fake))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(200);
    expect(typeof res.body.leaseToken).toBe('string');
    expect(res.body.ttlMs).toBeTypeOf('number');
    // holder 정보 외 내부 식별자가 응답에 노출되지 않아야 한다.
    expect(res.body).not.toHaveProperty('clientInstanceId');
    expect(res.body).not.toHaveProperty('userId');
  });

  it('다른 클라이언트가 살아있는 락을 쥐고 있으면 423 + holder 정보', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }],
      acquire: [],          // acquireLock UPSERT — WHERE 불만족(다른 세션이 보유)
      peek: [LOCK_ROW],     // peekLock (heldBy 조회)
    });
    const res = await request(patientsApp(fake))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('LOCK_HELD');
    expect(res.body.holder.holderName).toBe('Dr. Kim');
    expect(res.body.holder).not.toHaveProperty('leaseToken');
    fake.assertNoUnmatched();
    assertHandled(fake, 'locks.peek');
    fake.assertAllReleased();
  });

  it('X-Lock-Token 헤더가 있으면 renew — 토큰을 회전시키지 않고 expires_at만 반환', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }],
      renew: [{ expires_at: LATER }],  // renewLock UPDATE...RETURNING
    });
    const res = await request(patientsApp(fake))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .set('x-lock-token', 'sometoken')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.leaseToken).toBeUndefined(); // renew는 토큰을 새로 주지 않는다
    expect(res.body.expiresAt).toBe(LATER.toISOString());
  });

  it('renew인데 토큰이 유효하지 않으면 423 LOCK_LOST', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }],
      renew: [],            // renewLock UPDATE — 0 rows
    });
    const res = await request(patientsApp(fake))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .set('x-lock-token', 'expired-or-wrong')
      .send({});
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('LOCK_LOST');
    fake.assertNoUnmatched();
    assertHandled(fake, 'locks.renew');
    fake.assertAllReleased();
  });

  it('force=true면 다른 클라이언트가 보유 중이어도 항상 200 + 새 leaseToken', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }],
      peek: [LOCK_ROW],     // peekLock — 감사 로그용 이전 보유자 조회
      force: [LOCK_ROW],    // forceLock INSERT...RETURNING — 항상 성공
    });
    const res = await request(patientsApp(fake))
      .post(`/api/patients/${PAT_ID}/lock?force=true`)
      .set(authHeaders(orgToken()))
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(200);
    expect(typeof res.body.leaseToken).toBe('string');
    // 감사 로그는 새로 획득한 사람이 아니라 "밀려난 이전 보유자"를 기록해야 의미가 있다.
    expect(writeAuditLog).toHaveBeenCalledWith(
      fake.pool,
      expect.objectContaining({
        action: 'patient_lock_takeover',
        extra: expect.objectContaining({ previousHolderName: 'Dr. Kim' }),
      })
    );
  });

  it('환자가 없거나 삭제됐으면 404', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [],           // anchor — 존재하지 않음
    });
    const res = await request(patientsApp(fake))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
    fake.assertNoUnmatched();
    assertHandled(fake, 'patients.anchor');
    fake.assertAllReleased();
  });

  // TOCTOU 재검증(2라운드 외부 리뷰 반영) — assignedDoctorOrAdmin 미들웨어는 여기서 host가
  // 여전히 담당의(USER_ID)라고 통과시켰지만(access: ACCESS_OK), 그 직후 트랜잭션 안에서
  // 앵커가 실제로 조회한 담당의는 다른 사람이다(미들웨어 확인과 앵커 획득 사이에 재배정된
  // 상황을 흉내). assertAssignedOrAdmin이 이를 잡아 403을 반환해야 한다.
  it('미들웨어 통과 후 트랜잭션 안에서 담당의가 이미 바뀌었으면 403(TOCTOU 재검증)', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [{ id: PAT_ID, assigned_doctor_user_id: 'other-doctor-id' }], // anchor — 재배정된 담당의
    });
    const res = await request(patientsApp(fake))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
    assertHandled(fake, 'patients.access');
    assertHandled(fake, 'patients.anchor');
    fake.assertAllReleased();
  });
});

describe('DELETE /api/patients/:id/lock', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('토큰 없이 호출하면 DB 접근 없이 204 no-op', async () => {
    const fake = lockFake({ access: ACCESS_OK }); // middleware
    const res = await request(patientsApp(fake))
      .delete(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()));
    expect(res.status).toBe(204);
    expect(fake.connected).toBe(0);
  });

  it('토큰이 일치하면 204, patient_locks에서 삭제', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [{ id: PAT_ID }],
      release: [],          // releaseLock DELETE
    });
    const res = await request(patientsApp(fake))
      .delete(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .set('x-lock-token', 'mytoken');
    expect(res.status).toBe(204);
    const deleteCall = fake.calls.find(
      (c) => c.via === 'client' && /DELETE\s+FROM\s+patient_locks/.test(c.sql)
    );
    expect(deleteCall).toBeDefined();
  });

  it('환자가 없어도(anchor 실패) 204 no-op으로 처리', async () => {
    const fake = lockFake({
      access: ACCESS_OK,
      anchor: [],           // anchor — 존재하지 않음 → PatientLockTargetNotFoundError
    });
    const res = await request(patientsApp(fake))
      .delete(`/api/patients/${PAT_ID}/lock`)
      .set(authHeaders(orgToken()))
      .set('x-lock-token', 'mytoken');
    expect(res.status).toBe(204);
    fake.assertNoUnmatched();
  });
});

describe('GET /api/patients/:id/lock', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // access handler를 두지 않는다 — 미들웨어 조회가 나가면 미매치 오류(→ 500)로 실패한다.
  it('잠겨있지 않으면 { lock: null } — assignedDoctorOrAdmin 미들웨어 없이 auth만으로 조회', async () => {
    const fake = lockFake({ peek: [] }); // peekLock — 살아있는 락 없음
    const res = await request(patientsApp(fake))
      .get(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.lock).toBeNull();
    fake.assertNoUnmatched();
  });

  it('잠겨있으면 holder 정보만 반환(내부 식별자 미노출)', async () => {
    const fake = lockFake({ peek: [LOCK_ROW] });
    const res = await request(patientsApp(fake))
      .get(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.lock).toEqual({
      holderName: 'Dr. Kim',
      acquiredAt: NOW.toISOString(),
      expiresAt:  LATER.toISOString(),
    });
  });
});

// ---------------------------------------------------------------------------
// 생년월일 서버 검증 (INVALID_BIRTH_DATE)
// 클라이언트를 우회한 요청도 막아야 한다 — CreateBody.data.shared가
// z.record(z.unknown())이라 zod는 아무 값이나 통과시킨다.
// ---------------------------------------------------------------------------
describe('생년월일 서버 검증', () => {
  const withBirthDate = (birthDate: string) => ({
    ...VALID_DATA,
    shared: { ...SHARED, birthDate },
  });

  // 인증만 통과 — 라우트 쿼리 handler 없음(DB를 건드리면 미매치).
  function authOnly(): FakePool {
    return authedFake();
  }

  function postWith(fake: FakePool, data: unknown) {
    return request(patientsApp(fake))
      .post('/api/patients')
      .set(authHeaders(orgToken()))
      .set('idempotency-key', IDEMP_KEY)
      .send({ ...CREATE_BODY, data });
  }

  it('POST: 실제 사고 값 4110-02-12를 400으로 거부하고 DB를 건드리지 않는다', async () => {
    const fake = authOnly();

    const res = await postWith(fake, withBirthDate('4110-02-12'));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BIRTH_DATE');
    expect(res.body.fields[0]).toMatchObject({ field: 'birthDate', reason: 'future' });
    // idempotency 슬롯 예약조차 하지 않아야 한다
    expect(fake.connected).toBe(0);
    fake.assertNoUnmatched();
  });

  it('POST: 실재하지 않는 날짜(2월 30일)를 거부한다', async () => {
    const fake = authOnly();
    const res = await postWith(fake, withBirthDate('1980-02-30'));
    expect(res.status).toBe(400);
    expect(res.body.fields[0].reason).toBe('not_a_calendar_date');
    fake.assertNoUnmatched();
  });

  it('POST: 1900 이전을 거부한다', async () => {
    const fake = authOnly();
    const res = await postWith(fake, withBirthDate('1899-12-31'));
    expect(res.status).toBe(400);
    expect(res.body.fields[0].reason).toBe('too_old');
    fake.assertNoUnmatched();
  });

  it('POST: 응답에 생년월일 값 자체를 되싣지 않는다 (PHI)', async () => {
    const fake = authOnly();
    const res = await postWith(fake, withBirthDate('4110-02-12'));
    expect(JSON.stringify(res.body)).not.toContain('4110-02-12');
    fake.assertNoUnmatched();
  });

});

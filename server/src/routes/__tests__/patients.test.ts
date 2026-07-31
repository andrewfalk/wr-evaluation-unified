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
    cors: { origins: [] },
    auth: {
      accessTokenTtl:     900,
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
    // 'off'가 기본값 — 기존 PATCH/DELETE/assignment 테스트들이 락 게이트 쿼리를 추가로
    // 목킹하지 않아도 되도록. 락 게이팅 자체를 검증하는 테스트는 이 값을 'enforce'로 덮어쓴다.
    lockEnforcementMode: 'off',
  },
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:   vi.fn(),
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createPatientsRouter } from '../patients';
import { generateAccessToken } from '../../auth/tokens';
import { writeAuditLog } from '../../middleware/audit';
import config from '../../config';

// 실제 config.ts의 반환 타입은 Object.freeze로 readonly로 추론되지만, 이 목(mock)은 얼려있지
// 않은 평범한 객체다 — 테스트에서 lockEnforcementMode를 바꿔치기 하기 위한 타입 우회 헬퍼.
function setLockEnforcementMode(mode: 'off' | 'observe' | 'enforce'): void {
  (config as unknown as { lockEnforcementMode: string }).lockEnforcementMode = mode;
}
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function orgToken(): string {
  return generateAccessToken({
    sub: USER_ID, sessionId: 'sess-1', orgId: ORG_ID,
    role: 'doctor', name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function superToken(): string {
  return generateAccessToken({
    sub: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    sessionId: 'sess-2', orgId: null,
    role: 'admin', name: 'Superadmin', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function adminToken(): string {
  return generateAccessToken({
    sub: ADMIN_ID, sessionId: 'sess-3', orgId: ORG_ID,
    role: 'admin', name: 'Admin User', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/patients', createPatientsRouter(pool));
  return app;
}

// first call = auth middleware session check; rest = route queries
function wireQueries(pool: Pool, ...results: { rows: unknown[]; rowCount?: number }[]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
  for (const r of results) {
    mock.mockResolvedValueOnce(r);
  }
}

// Routes that use pool.connect() + client.query() (POST, DELETE, PATCH) need this helper.
// Auth middleware still goes through pool.query (first call); all subsequent
// queries go through the dedicated client returned by pool.connect().
//
// PATCH/DELETE /:id 는 assignedDoctorOrAdmin 미들웨어가 추가로 pool.query를 호출하므로
// withAccessCheck 옵션으로 미들웨어 SELECT mock도 끼워준다.
// withAccessCheck.assigned === undefined 이면 USER_ID (테스트의 기본 caller가 owner)
function makeClientSetup(
  pool: Pool,
  ...args:
    | [...clientResults: { rows: unknown[]; rowCount?: number }[]]
    | [{ withAccessCheck: { assigned?: string | null } }, ...clientResults: { rows: unknown[]; rowCount?: number }[]]
): ReturnType<typeof vi.fn> {
  let withAccess: { assigned?: string | null } | null = null;
  let clientResults: { rows: unknown[]; rowCount?: number }[];
  if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null && 'withAccessCheck' in args[0]) {
    withAccess = (args[0] as { withAccessCheck: { assigned?: string | null } }).withAccessCheck;
    clientResults = args.slice(1) as { rows: unknown[]; rowCount?: number }[];
  } else {
    clientResults = args as { rows: unknown[]; rowCount?: number }[];
  }

  const clientMock = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
  if (withAccess) {
    const assigned = withAccess.assigned === undefined ? USER_ID : withAccess.assigned;
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ assigned_doctor_user_id: assigned }],
    });
  }
  const cq = clientMock.query as ReturnType<typeof vi.fn>;
  for (const r of clientResults) cq.mockResolvedValueOnce(r);
  return cq;
}

// PATCH/DELETE /:id에서 assignedDoctorOrAdmin 미들웨어가 환자를 찾지 못하게 만든다.
// auth 1번 + 미들웨어 SELECT 1번(빈 결과) = 미들웨어가 404 반환 → handler 호출 X.
function setupMiddlewareNotFound(pool: Pool) {
  (pool.query as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // auth
    .mockResolvedValueOnce({ rows: [] });             // middleware: not found
}

// 미들웨어가 403을 반환하게 만든다 (다른 의사가 담당).
function setupMiddlewareForbidden(pool: Pool, otherUserId: string = DOCTOR_ID) {
  (pool.query as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
    .mockResolvedValueOnce({ rows: [{ assigned_doctor_user_id: otherUserId }] });
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
};

// ---------------------------------------------------------------------------
// GET /api/patients
// ---------------------------------------------------------------------------
describe('GET /api/patients', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool)).get('/api/patients');
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with items and total', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [PAT_ROW] });        // items (Promise.all first)
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count (Promise.all second)
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // unassignedCount (Promise.all third)
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] }); // orgPatientCount (Promise.all fourth)

    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.orgPatientCount).toBe(1);
    expect(res.body.items[0].id).toBe(PAT_ID);
    expect(res.body.items[0].sync.serverId).toBe(PAT_ID);
    expect(res.body.items[0].sync.syncStatus).toBe('synced');

    const itemsCall = mock.mock.calls[1] as unknown[];
    expect(itemsCall[0] as string).toContain('assigned_doctor_user_id');
    expect(itemsCall[1] as unknown[]).toContain(USER_ID);
  });

  it('includes top-level updatedAt and createdAt on each item', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    mock.mockResolvedValueOnce({ rows: [PAT_ROW] });
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.updatedAt).toBe(NOW.toISOString());
    expect(item.createdAt).toBe(NOW.toISOString());
  });

  it('overrides stale payload updatedAt with DB updated_at', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    const stalePayloadRow = {
      ...PAT_ROW,
      updated_at: LATER,
      payload: {
        ...(PAT_ROW.payload as Record<string, unknown>),
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    };
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    mock.mockResolvedValueOnce({ rows: [stalePayloadRow] });
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].updatedAt).toBe(LATER.toISOString());
  });

  it('preserves payload createdAt when present, falls back to DB created_at when missing', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
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
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    mock.mockResolvedValueOnce({ rows: [withPayloadCreatedAt, noPayloadCreatedAt] });
    mock.mockResolvedValueOnce({ rows: [{ total: '2' }] });
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mock.mockResolvedValueOnce({ rows: [{ total: '2' }] });

    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].createdAt).toBe(payloadCreatedAt);
    expect(res.body.items[1].createdAt).toBe(NOW.toISOString());
  });

  it('defaults admin patient list scope to all', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [PAT_ROW] });        // items
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // unassignedCount
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] }); // orgPatientCount

    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const itemsCall = mock.mock.calls[1] as unknown[];
    expect(itemsCall[0] as string).not.toMatch(/AND\s+assigned_doctor_user_id\s*=/);
    expect(itemsCall[1] as unknown[]).toEqual([ORG_ID, 20, 0]);
  });

  it('allows admin to explicitly request mine scope', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] });              // items
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // count
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // unassignedCount
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // orgPatientCount

    const res = await request(makeApp(pool))
      .get('/api/patients?scope=mine')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const itemsCall = mock.mock.calls[1] as unknown[];
    expect(itemsCall[0] as string).toContain('assigned_doctor_user_id');
    expect(itemsCall[1] as unknown[]).toContain(ADMIN_ID);
  });

  it('returns 200 with empty result', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    mock.mockResolvedValueOnce({ rows: [] });
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // count
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // unassignedCount
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // orgPatientCount
    const res = await request(makeApp(pool))
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
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });   // auth
    mock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // scope 검증: 담당 환자 있음
    mock.mockResolvedValueOnce({ rows: [PAT_ROW] });          // items
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] });   // count
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] });   // unassignedCount
    mock.mockResolvedValueOnce({ rows: [{ total: '5' }] });   // orgPatientCount

    const res = await request(makeApp(pool))
      .get(`/api/patients?scope=${DOCTOR_ID}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // 검증 쿼리가 assigned_doctor_user_id로 조회됐는지
    const validateCall = mock.mock.calls[1] as unknown[];
    expect(validateCall[0] as string).toContain('assigned_doctor_user_id');
    expect(validateCall[1] as unknown[]).toEqual([ORG_ID, DOCTOR_ID]);
    // items 쿼리가 해당 의사로 필터됐는지
    const itemsCall = mock.mock.calls[2] as unknown[];
    expect(itemsCall[0] as string).toContain('assigned_doctor_user_id');
    expect(itemsCall[1] as unknown[]).toContain(DOCTOR_ID);
  });

  it('scope=<doctorId> (담당 환자 없음) → invalid, 전체로 fallback 안 함 (빈 결과)', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });   // auth
    mock.mockResolvedValueOnce({ rows: [] });                // scope 검증: 담당 환자 없음 → invalid
    mock.mockResolvedValueOnce({ rows: [] });                // items
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] });  // count
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] });  // unassignedCount
    mock.mockResolvedValueOnce({ rows: [{ total: '5' }] });  // orgPatientCount

    const res = await request(makeApp(pool))
      .get(`/api/patients?scope=${DOCTOR_ID}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    const itemsCall = mock.mock.calls[2] as unknown[];
    expect(itemsCall[0] as string).toContain('FALSE');
    // 전체(all)로 새지 않았음: assigned 필터도 아니고 조건 없음도 아님
    expect(itemsCall[0] as string).not.toMatch(/AND\s+assigned_doctor_user_id\s*=/);
  });

  it('scope=__unassigned__ → assigned NULL 필터 (검증 쿼리 없음)', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });  // auth
    mock.mockResolvedValueOnce({ rows: [] });               // items
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // count
    mock.mockResolvedValueOnce({ rows: [{ total: '3' }] }); // unassignedCount
    mock.mockResolvedValueOnce({ rows: [{ total: '5' }] }); // orgPatientCount

    const res = await request(makeApp(pool))
      .get('/api/patients?scope=__unassigned__')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // 검증 쿼리 없이 바로 items가 두 번째 호출
    const itemsCall = mock.mock.calls[1] as unknown[];
    expect(itemsCall[0] as string).toContain('assigned_doctor_user_id IS NULL');
  });

  it('scope=아무문자열(비-UUID) → invalid, FALSE 조건 (전체 fallback 금지)', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });  // auth
    mock.mockResolvedValueOnce({ rows: [] });               // items
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // count
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // unassignedCount
    mock.mockResolvedValueOnce({ rows: [{ total: '5' }] }); // orgPatientCount

    const res = await request(makeApp(pool))
      .get('/api/patients?scope=not-a-scope')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    const itemsCall = mock.mock.calls[1] as unknown[];
    expect(itemsCall[0] as string).toContain('FALSE');
  });
});

// ---------------------------------------------------------------------------
// GET /api/patients/doctor-counts — 의사별 환자 수 명부
// ---------------------------------------------------------------------------
describe('GET /api/patients/doctor-counts', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('/:id 라우트에 먹히지 않고 명부를 반환 (라우트 순서)', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [
      { user_id: USER_ID, name: 'Dr. Kim', count: 5 },
      { user_id: null,    name: null,      count: 3 },
    ] });

    const res = await request(makeApp(pool))
      .get('/api/patients/doctor-counts')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    // getPatient(:id)였다면 doctors 필드가 없고 404였을 것
    expect(Array.isArray(res.body.doctors)).toBe(true);
    expect(res.body.doctors).toEqual([{ userId: USER_ID, name: 'Dr. Kim', count: 5 }]);
    expect(res.body.unassignedCount).toBe(3);
  });

  it('count 내림차순 정렬, 미배정은 doctors에서 분리', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [
      { user_id: 'A', name: '박철수', count: 2 },
      { user_id: 'B', name: '이영희', count: 9 },
      { user_id: null, name: null, count: 4 },
    ] });

    const res = await request(makeApp(pool))
      .get('/api/patients/doctor-counts')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.doctors.map((d: { userId: string }) => d.userId)).toEqual(['B', 'A']);
    expect(res.body.unassignedCount).toBe(4);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/patients/doctor-counts')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/patients/:id
// ---------------------------------------------------------------------------
describe('GET /api/patients/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 404 when patient not found', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .get(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('returns 200 with full patient response', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [PAT_ROW] });
    const res = await request(makeApp(pool))
      .get(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PAT_ID);
    expect(res.body.sync.revision).toBe(1);
  });

  it('GET /:id 응답에도 top-level updatedAt/createdAt이 포함된다', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [PAT_ROW] });
    const res = await request(makeApp(pool))
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
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(CREATE_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 400 when body is invalid', async () => {
    // Body validation happens before any DB call (idempotency slot not reserved)
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send({ phase: 'evaluation' }); // missing data
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when patient name is missing', async () => {
    // Name check happens before any DB call (idempotency slot not reserved)
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    const noName = { ...CREATE_BODY, data: { ...VALID_DATA, shared: { ...SHARED, name: '' } } };
    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(noName);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
  });

  it('returns 201 on first call and commits idempotency slot', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [] },                           // SELECT patient_persons by patient_no
      { rows: [{ id: PERSON_ID }] },          // INSERT patient_persons
      { rows: [] },                           // INSERT patient_records
      { rows: [PAT_ROW] },                    // SELECT after INSERT
      { rows: [] },                           // UPDATE slot to status=201
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PAT_ID);
    expect(res.body.sync.revision).toBe(1);

    // Verify slot was finalized via UPDATE (not a fresh INSERT)
    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE idempotency_keys')
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as unknown[])[0]).toBe(IDEMP_KEY);
    expect((updateCall![1] as unknown[])[1]).toBe(USER_ID);
    expect((updateCall![1] as unknown[])[2]).toBe(201);
  });

  it('allows same patient number for another injury/evaluation record', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, // existing person
      { rows: [] },                           // UPDATE existing person
      { rows: [] },                           // INSERT patient_records
      { rows: [PAT_ROW] },                    // SELECT after INSERT
      { rows: [] },                           // UPDATE slot to status=201
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PAT_ID);
    const insertRecordCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(insertRecordCall).toBeDefined();
    expect((insertRecordCall![1] as unknown[])[2]).toBe(PERSON_ID);
  });

  it('returns a warning when patient number and birth date match but name differs', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [{ id: PERSON_ID, name: 'Old Name', birth_date: '1980-01-01' }] }, // existing person
      { rows: [] },                           // UPDATE existing person
      { rows: [] },                           // INSERT patient_records
      { rows: [PAT_ROW] },                    // SELECT after INSERT
      { rows: [] },                           // UPDATE slot to status=201
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.sync.warnings).toEqual([
      expect.objectContaining({
        code: 'PATIENT_NAME_MISMATCH',
        existingName: 'Old Name',
        incomingName: 'Kim',
      }),
    ]);
  });

  it('returns 409 when patient number matches a different birth date', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [{ id: PERSON_ID, birth_date: '1970-01-01' }] }, // identity conflict
    );
    cq.mockResolvedValueOnce({ rows: [] });   // ROLLBACK (in catch)

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATIENT_IDENTITY_CONFLICT');

    // Verify ROLLBACK was called — this atomically releases the slot
    const rollbackCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).trim() === 'ROLLBACK'
    );
    expect(rollbackCall).toBeDefined();
  });

  it('returns cached response on replay (slot status > 0)', async () => {
    const cachedBody = { id: PAT_ID, sync: { serverId: PAT_ID, revision: 1, syncStatus: 'synced', lastSyncedAt: NOW.toISOString() } };
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                                                  // BEGIN
      { rows: [] },                                                  // DELETE expired
      { rows: [], rowCount: 0 },                                     // INSERT slot (lost — DO NOTHING)
      { rows: [{ status: 201, body: cachedBody }] },                 // SELECT existing (completed)
      { rows: [] },                                                  // ROLLBACK
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PAT_ID);
    // pool.query: 1 (auth); client.query: 5 (BEGIN + DELETE + INSERT + SELECT + ROLLBACK)
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(cq.mock.calls.length).toBe(5);
  });

  it('returns 409 IDEMPOTENCY_IN_PROGRESS when concurrent request holds the slot', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },                                                  // BEGIN
      { rows: [] },                                                  // DELETE expired
      { rows: [], rowCount: 0 },                                     // INSERT slot (lost)
      { rows: [{ status: 0, body: null }] },                         // SELECT existing (pending)
      { rows: [] },                                                  // ROLLBACK
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/patients/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/patients/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when If-Match header is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // auth
      .mockResolvedValueOnce({ rows: [{ assigned_doctor_user_id: USER_ID }] }); // middleware
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ phase: 'evaluation' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IF_MATCH_REQUIRED');
  });

  it('returns 400 when If-Match is not a positive integer', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // auth
      .mockResolvedValueOnce({ rows: [{ assigned_doctor_user_id: USER_ID }] }); // middleware
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', 'abc')
      .send({ phase: 'evaluation' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IF_MATCH');
  });

  it('returns 404 when patient not found (middleware short-circuits)', async () => {
    const pool = makePool();
    setupMiddlewareNotFound(pool);
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('returns 409 when If-Match revision does not match current', async () => {
    const staleRow = { ...PAT_ROW, revision: 2 }; // server is at rev 2
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },          // BEGIN
      { rows: [staleRow] },  // SELECT returns rev 2
      { rows: [] },          // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1') // client thinks rev 1
      .send({ data: VALID_DATA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.currentRevision).toBe(2);
  });

  it('returns 409 on concurrent modification (UPDATE returns 0 rows)', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1 matches)
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, // person lookup
      { rows: [] }, // person update
      { rows: [] }, // UPDATE RETURNING (race -> 0 rows)
      { rows: [] }, // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('returns 200 with updated patient on success', async () => {
    const updatedRow = { ...PAT_ROW, revision: 2, updated_at: LATER };
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1)
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, // person lookup
      { rows: [] }, // person update
      { rows: [updatedRow] }, // UPDATE RETURNING
      { rows: [] }, // COMMIT
    );

    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PAT_ID);
    expect(res.body.sync.revision).toBe(2);
    expect(res.body.sync.lastSyncedAt).toBe(LATER.toISOString());
  });

  it('returns a warning on patch when patient number and birth date match but name differs', async () => {
    const updatedRow = { ...PAT_ROW, revision: 2, updated_at: LATER };
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1)
      { rows: [{ id: PERSON_ID, name: 'Old Name', birth_date: '1980-01-01' }] }, // person lookup
      { rows: [] }, // person update
      { rows: [updatedRow] }, // UPDATE RETURNING
      { rows: [] }, // COMMIT
    );

    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });

    expect(res.status).toBe(200);
    expect(res.body.sync.warnings).toEqual([
      expect.objectContaining({
        code: 'PATIENT_NAME_MISMATCH',
        existingName: 'Old Name',
        incomingName: 'Kim',
      }),
    ]);
  });

  it('returns 409 when patch would link to a patient number with different birth date', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1)
      { rows: [{ id: PERSON_ID, birth_date: '1970-01-01' }] }, // identity conflict
      { rows: [] }, // ROLLBACK
    );

    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATIENT_IDENTITY_CONFLICT');
  });

  it('preserves existing payload when only phase is updated', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] },
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] },
      { rows: [] },
      { rows: [{ ...PAT_ROW, revision: 2, updated_at: LATER }] },
      { rows: [] }, // COMMIT
    );

    await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ phase: 'intake' });

    // Check the UPDATE query payload includes updated phase
    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE patient_records')
    );
    expect(updateCall).toBeDefined();
    const payload = JSON.parse((updateCall![1] as unknown[])[11] as string) as Record<string, unknown>;
    expect(payload['phase']).toBe('intake');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/patients/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/patients/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when revision query param is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // auth
      .mockResolvedValueOnce({ rows: [{ assigned_doctor_user_id: USER_ID }] }); // middleware
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REVISION_REQUIRED');
  });

  // DELETE uses pool.connect() + client.query() for atomicity (soft-delete + snapshot redact).
  // Happy-path client queries: BEGIN → UPDATE patient → UPDATE workspaces → COMMIT
  // Error-path: BEGIN → UPDATE patient (rowCount=0) → SELECT → ROLLBACK

  it('returns 404 when patient does not exist (middleware short-circuits)', async () => {
    const pool = makePool();
    setupMiddlewareNotFound(pool);
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('returns 409 when revision does not match', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },                                                    // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] },    // lockPatientAnchor
      { rows: [], rowCount: 0 },                                       // UPDATE patient (no match)
      { rows: [{ revision: 3, deleted_at: null }] },                   // SELECT → rev 3
      { rows: [] },                                                    // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.currentRevision).toBe(3);
  });

  it('returns 204 and redacts snapshot on successful soft-delete', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },                                                    // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] },    // lockPatientAnchor
      { rows: [], rowCount: 1 },              // UPDATE patient (soft-delete succeeds)
      { rows: [] },                           // UPDATE workspaces (snapshot redaction)
      { rows: [] },                           // DELETE patient_locks (cleanup)
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    // Verify the snapshot redaction UPDATE was issued.
    // The WHERE uses an EXISTS + jsonb_array_elements scan (not patient_ids @>)
    // so legacy/migration-incomplete workspaces are covered too.
    const redactCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE workspaces')
    );
    expect(redactCall).toBeDefined();
    const redactSql = redactCall![0] as string;
    expect(redactSql).toContain('EXISTS');
    expect(redactSql).not.toContain('patient_ids @>');
    expect((redactCall![1] as unknown[])[1]).toBe(PAT_ID); // $2 = patient id
  });

  it('issues soft-delete UPDATE with correct id, org, and revision', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },                                                    // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] },    // lockPatientAnchor
      { rows: [], rowCount: 1 },              // UPDATE patient
      { rows: [] },                           // UPDATE workspaces
      { rows: [] },                           // DELETE patient_locks (cleanup)
      { rows: [] },                           // COMMIT
    );

    await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=2`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);

    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SET deleted_at')
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as unknown[])[0]).toBe(PAT_ID); // $1 = id
    expect((updateCall![1] as unknown[])[1]).toBe(ORG_ID); // $2 = org
    expect((updateCall![1] as unknown[])[2]).toBe(2);      // $3 = revision
  });
});

// ---------------------------------------------------------------------------
// 권한 정책: assignedDoctorOrAdmin 미들웨어 (PATCH/DELETE)
// ---------------------------------------------------------------------------
describe('PATCH /api/patients/:id — 권한 정책', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('담당 의사면 200', async () => {
    const updatedRow = { ...PAT_ROW, revision: 2, updated_at: LATER };
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: { assigned: USER_ID } },
      { rows: [] }, { rows: [PAT_ROW] },
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, { rows: [] },
      { rows: [updatedRow] }, { rows: [] },
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN).set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(200);
  });

  it('다른 의사(assigned 다름)면 403, handler 호출 안 됨', async () => {
    const pool = makePool();
    setupMiddlewareForbidden(pool, DOCTOR_ID);
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`) // USER_ID
      .set('x-csrf-token', CSRF_TOKEN).set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    // connect() 호출되지 않았어야 함 (handler 미진입)
    expect((pool.connect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('admin이면 assigned 무관 200, 미들웨어가 DB 조회 없이 통과', async () => {
    const updatedRow = { ...PAT_ROW, revision: 2, updated_at: LATER };
    const pool = makePool();
    // admin은 미들웨어가 즉시 통과하므로 withAccessCheck 없음 — auth + client.query만
    makeClientSetup(pool,
      { rows: [] }, { rows: [PAT_ROW] },
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, { rows: [] },
      { rows: [updatedRow] }, { rows: [] },
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN).set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(200);
    // pool.query는 auth 1번만 (미들웨어 SELECT 없음)
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('admin이라도 다른 org 환자는 404 (handler의 org 가드)', async () => {
    const pool = makePool();
    // admin 미들웨어 통과 → handler에서 다른 org → SELECT empty → ROLLBACK
    makeClientSetup(pool,
      { rows: [] },     // BEGIN
      { rows: [] },     // SELECT empty (다른 org라 못 찾음)
      { rows: [] },     // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN).set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('미배정 환자(assigned NULL) + 일반 의사는 403', async () => {
    const pool = makePool();
    setupMiddlewareForbidden(pool, null as unknown as string);
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN).set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(403);
  });

  it('일반 의사가 존재하지 않는 환자(같은 org)에 PATCH → 404 (미들웨어 차단)', async () => {
    const pool = makePool();
    setupMiddlewareNotFound(pool);
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN).set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/patients/:id — 권한 정책', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('담당 의사면 204', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: { assigned: USER_ID } },
      { rows: [] },
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] }, // lockPatientAnchor
      { rows: [], rowCount: 1 }, { rows: [] }, { rows: [] }, { rows: [] },
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(204);
  });

  it('다른 의사면 403, handler 호출 안 됨', async () => {
    const pool = makePool();
    setupMiddlewareForbidden(pool, DOCTOR_ID);
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(403);
    expect((pool.connect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('admin이면 204, 미들웨어가 DB 조회 없이 통과', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: DOCTOR_ID }] }, // lockPatientAnchor — admin은 담당의 무관 통과
      { rows: [], rowCount: 1 }, { rows: [] }, { rows: [] }, { rows: [] },
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(204);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('admin이라도 다른 org 환자 → 404', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },                  // BEGIN
      { rows: [] },                  // lockPatientAnchor — 다른 org라 못 찾음(PatientLockTargetNotFoundError)
      { rows: [] },                  // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
  });

  it('미배정 환자 + 일반 의사 → 403', async () => {
    const pool = makePool();
    setupMiddlewareForbidden(pool, null as unknown as string);
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(403);
  });

  it('일반 의사 + 존재하지 않는 환자 → 404 (미들웨어 차단)', async () => {
    const pool = makePool();
    setupMiddlewareNotFound(pool);
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/patients/:id/assignment
// ---------------------------------------------------------------------------
// assignPatient는 (a) 유저 검증까지는 pool.query, (b) 이후 전체(앵커/락체크/조회/UPDATE)는
// pool.connect()가 반환하는 client.query로 진행하는 트랜잭션이다. userLookupResult가 null이면
// assignedUserId:null 요청(유저 조회 자체를 안 함)을 뜻한다.
function assignClientSetup(
  pool: Pool,
  userLookupResult: { rows: unknown[] } | null,
  ...clientResults: { rows: unknown[]; rowCount?: number }[]
): ReturnType<typeof vi.fn> {
  const clientMock = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);
  const pq = pool.query as ReturnType<typeof vi.fn>;
  pq.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
  if (userLookupResult) pq.mockResolvedValueOnce(userLookupResult);
  const cq = clientMock.query as ReturnType<typeof vi.fn>;
  for (const r of clientResults) cq.mockResolvedValueOnce(r);
  return cq;
}

describe('POST /api/patients/:id/assignment', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin users', async () => {
    const pool = makePool();
    wireQueries(pool); // auth only
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${orgToken()}`) // role: doctor
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(403);
  });

  it('returns 400 when body is invalid', async () => {
    const pool = makePool();
    wireQueries(pool);
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 404 when target user is not found in org', async () => {
    const pool = makePool();
    wireQueries(pool,
      { rows: [] }, // user lookup empty
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('returns 422 when target user exists but is not a doctor', async () => {
    const pool = makePool();
    wireQueries(pool,
      { rows: [{ id: DOCTOR_ID, role: 'nurse', name: 'Nurse Park' }] }, // user exists, wrong role
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TARGET_NOT_A_DOCTOR');
  });

  it('returns 404 when patient not found', async () => {
    const pool = makePool();
    assignClientSetup(pool,
      { rows: [{ id: DOCTOR_ID, role: 'doctor', name: 'Dr. Lee' }] }, // user ok
      { rows: [] },             // BEGIN
      { rows: [] },             // oldRows SELECT — patient not found
      { rows: [] },             // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('returns 200 and records previous/new doctor names in audit log', async () => {
    const pool = makePool();
    assignClientSetup(pool,
      { rows: [{ id: DOCTOR_ID, role: 'doctor', name: 'Dr. Lee' }] },
      { rows: [] },                                                                     // BEGIN
      { rows: [{ assigned_doctor_user_id: USER_ID, previous_doctor_name: 'Dr. Kim' }] }, // oldRows
      { rows: [{ id: PAT_ID, revision: 2 }] },                                           // UPDATE
      { rows: [] },                                                                     // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(200);
    expect(res.body.patientId).toBe(PAT_ID);
    expect(res.body.assignedUserId).toBe(DOCTOR_ID);
    expect(res.body.revision).toBe(2);
    expect(writeAuditLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        action: 'patient_assignment_change',
        extra:  {
          previousDoctorUserId: USER_ID,
          previousDoctorName:   'Dr. Kim',
          assignedUserId:       DOCTOR_ID,
          newDoctorName:        'Dr. Lee',
          forcedLockHolder:     null,
        },
      })
    );
  });

  it('accepts null assignedUserId to unassign a patient', async () => {
    const pool = makePool();
    assignClientSetup(pool,
      null, // no user lookup (assignedUserId is null, so user verification is skipped)
      { rows: [] },                                                                       // BEGIN
      { rows: [{ assigned_doctor_user_id: DOCTOR_ID, previous_doctor_name: 'Dr. Kim' }] }, // oldRows
      { rows: [{ id: PAT_ID, revision: 3 }] },                                             // UPDATE
      { rows: [] },                                                                       // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: null });
    expect(res.status).toBe(200);
    expect(res.body.assignedUserId).toBeNull();
    expect(res.body.revision).toBe(3);
    expect(writeAuditLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        action: 'patient_assignment_change',
        extra:  expect.objectContaining({
          assignedUserId: null,
          newDoctorName:  null,
        }),
      })
    );
  });

  it('uses assigned_doctor_user_id (not owner_user_id) for the update', async () => {
    const pool = makePool();
    const cq = assignClientSetup(pool,
      { rows: [{ id: DOCTOR_ID, role: 'doctor', name: 'Dr. Lee' }] },
      { rows: [] },                                                        // BEGIN
      { rows: [{ assigned_doctor_user_id: null, previous_doctor_name: null }] }, // oldRows
      { rows: [{ id: PAT_ID, revision: 2 }] },                             // UPDATE
      { rows: [] },                                                        // COMMIT
    );

    await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });

    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE patient_records')
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![0] as string)).toMatch(/assigned_doctor_user_id/);
    expect((updateCall![0] as string)).not.toMatch(/SET owner_user_id/);
    expect((updateCall![0] as string)).toMatch(/jsonb_set/);
  });

  // ---------------------------------------------------------------------------
  // 락 게이팅(enforce 모드) — 일반 재배정과 force 재배정 둘 다 앵커+락 확인을 거친다.
  // ---------------------------------------------------------------------------
  describe('락 게이팅 (lockEnforcementMode=enforce)', () => {
    beforeEach(() => { setLockEnforcementMode('enforce'); });
    afterEach(() => { setLockEnforcementMode('off'); });

    it('활성 락이 있으면 일반(non-force) 재배정은 423', async () => {
      const pool = makePool();
      const cq = assignClientSetup(pool,
        null,
        { rows: [] },                    // BEGIN
        { rows: [{ id: PAT_ID }] },      // lockPatientAnchor
        { rows: [{                       // checkLockForWrite — 활성 락 있음
            patient_id: PAT_ID, client_instance_id: 'ci', user_id: DOCTOR_ID,
            holder_name: 'Dr. Lee', acquired_at: NOW, expires_at: LATER, lease_token_hash: 'h',
          }] },
        { rows: [] },                    // ROLLBACK
      );
      const res = await request(makeApp(pool))
        .post(`/api/patients/${PAT_ID}/assignment`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .set('x-csrf-token', CSRF_TOKEN)
        .send({ assignedUserId: null });
      expect(res.status).toBe(423);
      expect(res.body.code).toBe('LOCK_HELD');
      void cq;
    });

    it('force=true면 활성 락을 폐기하고 재배정을 진행, patient_assignment_force로 감사 기록', async () => {
      const pool = makePool();
      assignClientSetup(pool,
        null,
        { rows: [] },                    // BEGIN
        { rows: [{ id: PAT_ID }] },      // lockPatientAnchor
        { rows: [{                       // checkLockForWrite — 활성 락 있음
            patient_id: PAT_ID, client_instance_id: 'ci', user_id: DOCTOR_ID,
            holder_name: 'Dr. Lee', acquired_at: NOW, expires_at: LATER, lease_token_hash: 'h',
          }] },
        { rows: [] },                    // deleteLockForPatient
        { rows: [{ assigned_doctor_user_id: null, previous_doctor_name: null }] }, // oldRows
        { rows: [{ id: PAT_ID, revision: 2 }] }, // UPDATE
        { rows: [] },                    // COMMIT
      );
      const res = await request(makeApp(pool))
        .post(`/api/patients/${PAT_ID}/assignment?force=true`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .set('x-csrf-token', CSRF_TOKEN)
        .send({ assignedUserId: null });
      expect(res.status).toBe(200);
      expect(writeAuditLog).toHaveBeenCalledWith(
        pool,
        expect.objectContaining({
          action: 'patient_assignment_force',
          extra:  expect.objectContaining({ forcedLockHolder: 'Dr. Lee' }),
        })
      );
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

describe('POST /api/patients/:id/lock', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('토큰 없음 + force 없음 → acquire, 잠겨있지 않으면 200 + leaseToken 발급', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },          // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] }, // anchor
      { rows: [LOCK_ROW] },  // acquireLock INSERT...RETURNING
      { rows: [] },          // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(200);
    expect(typeof res.body.leaseToken).toBe('string');
    expect(res.body.ttlMs).toBeTypeOf('number');
    // holder 정보 외 내부 식별자가 응답에 노출되지 않아야 한다.
    expect(res.body).not.toHaveProperty('clientInstanceId');
    expect(res.body).not.toHaveProperty('userId');
  });

  it('다른 클라이언트가 살아있는 락을 쥐고 있으면 423 + holder 정보', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },              // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] }, // anchor
      { rows: [] },              // acquireLock UPSERT — WHERE 불만족(다른 세션이 보유)
      { rows: [LOCK_ROW] },      // peekLock (heldBy 조회)
      { rows: [] },              // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('LOCK_HELD');
    expect(res.body.holder.holderName).toBe('Dr. Kim');
    expect(res.body.holder).not.toHaveProperty('leaseToken');
  });

  it('X-Lock-Token 헤더가 있으면 renew — 토큰을 회전시키지 않고 expires_at만 반환', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },                              // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] },                // anchor
      { rows: [{ expires_at: LATER }] },         // renewLock UPDATE...RETURNING
      { rows: [] },                              // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('x-lock-token', 'sometoken')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.leaseToken).toBeUndefined(); // renew는 토큰을 새로 주지 않는다
    expect(res.body.expiresAt).toBe(LATER.toISOString());
  });

  it('renew인데 토큰이 유효하지 않으면 423 LOCK_LOST', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },                // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] },  // anchor
      { rows: [] },                // renewLock UPDATE — 0 rows
      { rows: [] },                // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('x-lock-token', 'expired-or-wrong')
      .send({});
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('LOCK_LOST');
  });

  it('force=true면 다른 클라이언트가 보유 중이어도 항상 200 + 새 leaseToken', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },              // BEGIN
      { rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] }, // anchor
      { rows: [LOCK_ROW] },      // peekLock — 감사 로그용 이전 보유자 조회
      { rows: [LOCK_ROW] },      // forceLock INSERT...RETURNING — 항상 성공
      { rows: [] },              // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/lock?force=true`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(200);
    expect(typeof res.body.leaseToken).toBe('string');
    // 감사 로그는 새로 획득한 사람이 아니라 "밀려난 이전 보유자"를 기록해야 의미가 있다.
    expect(writeAuditLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        action: 'patient_lock_takeover',
        extra: expect.objectContaining({ previousHolderName: 'Dr. Kim' }),
      })
    );
  });

  it('환자가 없거나 삭제됐으면 404', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] }, // BEGIN
      { rows: [] }, // anchor — 존재하지 않음
      { rows: [] }, // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clientInstanceId: CLIENT_INSTANCE_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });
});

describe('DELETE /api/patients/:id/lock', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('토큰 없이 호출하면 DB 접근 없이 204 no-op', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // auth
      .mockResolvedValueOnce({ rows: [{ assigned_doctor_user_id: USER_ID }] }); // middleware
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(204);
    expect((pool.connect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('토큰이 일치하면 204, patient_locks에서 삭제', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },             // BEGIN
      { rows: [{ id: PAT_ID }] }, // anchor
      { rows: [] },             // releaseLock DELETE
      { rows: [] },             // COMMIT
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('x-lock-token', 'mytoken');
    expect(res.status).toBe(204);
    const deleteCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE FROM patient_locks')
    );
    expect(deleteCall).toBeDefined();
  });

  it('환자가 없어도(anchor 실패) 204 no-op으로 처리', async () => {
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] }, // BEGIN
      { rows: [] }, // anchor — 존재하지 않음 → PatientLockTargetNotFoundError
      { rows: [] }, // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('x-lock-token', 'mytoken');
    expect(res.status).toBe(204);
  });
});

describe('GET /api/patients/:id/lock', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('잠겨있지 않으면 { lock: null } — assignedDoctorOrAdmin 미들웨어 없이 auth만으로 조회', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] }); // peekLock — 살아있는 락 없음
    const res = await request(makeApp(pool))
      .get(`/api/patients/${PAT_ID}/lock`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.lock).toBeNull();
  });

  it('잠겨있으면 holder 정보만 반환(내부 식별자 미노출)', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [LOCK_ROW] });
    const res = await request(makeApp(pool))
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

describe('PATCH /api/patients/:id — 락 게이팅 (lockEnforcementMode=enforce)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLockEnforcementMode('enforce');
  });
  afterEach(() => { setLockEnforcementMode('off'); });

  it('다른 클라이언트가 활성 락을 쥐고 있으면 423, UPDATE는 시도되지 않는다', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },          // BEGIN
      { rows: [PAT_ROW] },   // SELECT (FOR UPDATE) — revision 1 일치
      { rows: [{             // checkLockForWrite — 활성 락 있음, 토큰 미제출
          patient_id: PAT_ID, client_instance_id: 'ci', user_id: DOCTOR_ID,
          holder_name: 'Dr. Lee', acquired_at: NOW, expires_at: LATER, lease_token_hash: 'h',
        }] },
      { rows: [] },          // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('LOCK_HELD');
    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SET') && (c[0] as string).includes('revision')
    );
    expect(updateCall).toBeUndefined();
  });

  it('본인 토큰이 일치하면 정상 통과(200)', async () => {
    const updatedRow = { ...PAT_ROW, revision: 2, updated_at: LATER };
    const pool = makePool();
    makeClientSetup(pool, { withAccessCheck: {} },
      { rows: [] },        // BEGIN
      { rows: [PAT_ROW] }, // SELECT
      { rows: [{           // checkLockForWrite — 본인 토큰과 일치
          patient_id: PAT_ID, client_instance_id: 'ci', user_id: USER_ID,
          holder_name: 'Dr. Kim', acquired_at: NOW, expires_at: LATER,
          lease_token_hash: crypto.createHash('sha256').update('my-token').digest('hex'),
        }] },
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, // person lookup
      { rows: [] },        // person update
      { rows: [updatedRow] }, // UPDATE RETURNING
      { rows: [] },        // COMMIT
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .set('x-lock-token', 'my-token')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(200);
  });
});

import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', () => ({
  default: {
    env: 'test',
    cors: { origins: [] },
    auth: {
      accessTokenTtl: 900,
      accessTokenSecret: 'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
  },
}));

const availabilityState = { available: true };
vi.mock('../../statsWorkbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: availabilityState.available, reason: null, checkedAt: null }),
}));

const writeAuditLogStrict = vi.fn().mockResolvedValue(undefined);
vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
  writeAuditLogStrict: (...args: unknown[]) => writeAuditLogStrict(...args),
}));

import { createStatsRouter } from '../stats';
import { generateAccessToken } from '../../auth/tokens';
import { __resetDifferencingGuardForTests, computeQueryFamilyDigest } from '../../statsDifferencingGuard';
import { StatsAnalysisRecipeSchema } from '@wr/contracts';

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CSRF_TOKEN = 'ok';
const CSRF_HASH = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

function orgToken(): string {
  return generateAccessToken({
    sub: USER_ID, sessionId: 'sess-1', orgId: ORG_ID,
    role: 'doctor', name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/stats', createStatsRouter(pool));
  return app;
}

function wireAuthAndCapability(
  pool: Pool,
  capability: { has_default: boolean; has_grant: boolean } = { has_default: true, has_grant: false },
): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth session check
  mock.mockResolvedValueOnce({ rows: [capability] }); // requireCapability
}

const SNAPSHOT_AS_OF = new Date('2024-01-01T00:00:00.000Z');

function patientRow(id: string, personId: string, assignedDoctorUserId: string | null = null) {
  return {
    id,
    patient_person_id: personId,
    assigned_doctor_user_id: assignedDoctorUserId,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    payload: { data: { shared: {}, modules: {}, activeModules: [] } },
  };
}

function manyDistinctPersons(n: number) {
  return Array.from({ length: n }, (_, i) => patientRow(`case-${i}`, `person-${i}`));
}

// Routes/stats.ts의 readSnapshot()이 pool.connect()로 얻은 client에 BEGIN → clock_timestamp
// → SELECT patient_records → COMMIT 4개를 순서대로 호출한다.
function wireSnapshot(pool: Pool, patientRecordRows: unknown[]): void {
  const clientMock = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);
  const cq = clientMock.query as ReturnType<typeof vi.fn>;
  cq.mockResolvedValueOnce({ rows: [] }); // BEGIN
  cq.mockResolvedValueOnce({ rows: [{ snapshot_as_of: SNAPSHOT_AS_OF }] }); // clock_timestamp
  cq.mockResolvedValueOnce({ rows: patientRecordRows }); // SELECT patient_records
  cq.mockResolvedValueOnce({ rows: [] }); // COMMIT
}

const BASE_BODY = {
  grain: 'case',
  variableKeys: ['knee.relatedness.max'],
  filters: [],
  analysisPurpose: 'association',
  formulaPolicies: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  writeAuditLogStrict.mockResolvedValue(undefined);
  availabilityState.available = true;
  __resetDifferencingGuardForTests();
});

describe('requireCapability 게이트(기존 미들웨어 재사용 확인)', () => {
  it('워크벤치 런타임 unavailable이면 404', async () => {
    availabilityState.available = false;
    const pool = makePool();
    // auth 미들웨어는 requireCapability보다 먼저 실행되고 availability와 무관하게 항상
    // 세션 검증 쿼리를 날린다 — 404는 그 다음 단계(requireCapability)에서 나온다.
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool)).get('/api/stats/catalog').set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    // requireCapability는 availability 확인 후 즉시 반환 — capability 조회 쿼리(2번째 호출)는
    // 발생하지 않는다.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('stats.view capability가 없으면 403 + 감사(stats_access_denied — requireCapability 자체 동작)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool, { has_default: false, has_grant: false });
    const res = await request(makeApp(pool)).get('/api/stats/catalog').set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /catalog', () => {
  it('200 + 7개 변수, 감사 로그를 남기지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool)).get('/api/stats/catalog').set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.variables).toHaveLength(7);
    expect(res.body.supportedGrains).toEqual(['case']);
    expect(res.body.unsupportedGrains).toHaveLength(6);
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });
});

describe('POST /preview — 레시피 검증', () => {
  it('grain=person은 400 GRAIN_NOT_YET_SUPPORTED을 반환하고 DB에 접근하지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ ...BASE_BODY, grain: 'person' });
    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { code: string }) => e.code === 'GRAIN_NOT_YET_SUPPORTED')).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('POST /preview — 소수 셀 억제', () => {
  it('personCount<10이면 전체 게이트로 억제되고 필드 구조는 유지된 채 값만 null이다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(5));
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      personCount: null, caseCount: null, observationCount: null,
      suppressed: true, minimumCohort: 10, reasonCode: 'MIN_COHORT_NOT_MET',
    });
    expect(res.body.estimability.missingRatesByVariable).toEqual({ 'knee.relatedness.max': null });
    expect(res.body.estimability.completeCaseN).toBeNull();
  });

  it('한 사람이 사례 12건을 가지면 personCount=1이라 억제된다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const rows = Array.from({ length: 12 }, (_, i) => patientRow(`case-${i}`, 'person-solo'));
    wireSnapshot(pool, rows);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(true);
    expect(res.body.counts.reasonCode).toBe('MIN_COHORT_NOT_MET');
  });

  it('personCount≥10이면 억제되지 않고 실제 값을 반환한다(knee 비활성 → missingRate=1)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(false);
    expect(res.body.counts.personCount).toBe(12);
    expect(res.body.counts.caseCount).toBe(12);
    expect(res.body.estimability.missingRatesByVariable['knee.relatedness.max']).toBe(1);
    expect(res.body.runManifest.recipeDigest).toEqual(expect.any(String));
    expect(res.body.runManifest.resultDigest).toEqual(expect.any(String));
    expect(res.body.availableMethods).toEqual([]);
  });

  it('personCount≥10인데 differencing 예산만 초과하면 reasonCode=DIFFERENCING_RATE_LIMIT(전체 게이트와 별개)', async () => {
    const recipe = StatsAnalysisRecipeSchema.parse(BASE_BODY);
    const family = computeQueryFamilyDigest(recipe);
    const { checkAndRecordDifferencing } = await import('../../statsDifferencingGuard');
    for (let i = 0; i < 35; i++) checkAndRecordDifferencing(ORG_ID, USER_ID, recipe, family);

    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(true);
    expect(res.body.counts.reasonCode).toBe('DIFFERENCING_RATE_LIMIT');
    expect(res.body.counts.personCount).toBeNull();
  });
});

describe('POST /preview — 감사 로그', () => {
  it('extra에 필터 값 없이 키/연산자/개수만 남고, analysisRunId·reasonCode를 포함한다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    const body = {
      ...BASE_BODY,
      filters: [{ key: 'knee.relatedness.max', operator: 'gt', value: 42 }],
    };
    await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(body);

    expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
    const [, entry] = writeAuditLogStrict.mock.calls[0];
    expect(entry.action).toBe('stats_preview');
    expect(entry.extra).toMatchObject({
      filterKeys: ['knee.relatedness.max'],
      filterOperators: ['gt'],
      filterCount: 1,
    });
    expect(entry.extra.analysisRunId).toEqual(expect.any(String));
    expect('reasonCode' in entry.extra).toBe(true);
    // 필터 "값"(42) 자체를 실을 수 있는 필드가 구조적으로 없어야 한다 — digest 문자열은
    // 우연히 "42"라는 부분 문자열을 포함할 수 있으므로 단순 문자열 검색은 오탐을 낸다.
    expect(Object.keys(entry.extra)).not.toEqual(expect.arrayContaining(['filterValues', 'values', 'value']));
    expect(entry.extra.filters).toBeUndefined();
  });

  it('감사 기록이 실패하면 /preview 요청 전체가 500으로 실패한다', async () => {
    writeAuditLogStrict.mockRejectedValueOnce(new Error('audit insert failed'));
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(res.status).toBe(500);
  });
});

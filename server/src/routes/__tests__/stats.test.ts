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
    stats: {
      python: 'python',
      scriptsDir: '/fake/scripts',
      timeoutMs: 30000,
      killGraceMs: 2000,
      maxConcurrency: 1,
      maxConcurrentAnalyzeRequests: 4,
      stdoutMaxBytes: 10 * 1024 * 1024,
      stderrMaxBytes: 64 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      resultTtlHours: 168,
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

// PR1 — /analyze 테스트는 실제 Python을 spawn하지 않는다. 에러 클래스(instanceof 분기에
// 쓰임)는 실물 그대로 두고 runStatsEngine만 mock한다.
const runStatsEngine = vi.fn();
vi.mock('../../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../statsEngine')>();
  return { ...actual, runStatsEngine: (...args: unknown[]) => runStatsEngine(...args) };
});

import { createStatsRouter } from '../stats';
import { generateAccessToken } from '../../auth/tokens';
import { __resetDifferencingGuardForTests, computeQueryFamilyDigest } from '../../statsDifferencingGuard';
import { __resetInFlightForTests } from '../../statsAnalyzeInFlight';
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
  __resetInFlightForTests();
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

// ---------------------------------------------------------------------------
// PR1 — POST /analyze. 계획서 pr1-giggly-treehouse.md §4/§5/§9 참고.
// ---------------------------------------------------------------------------
const FAKE_RAW_ENGINE_RESULT = {
  continuous: [{
    variableKey: 'knee.relatedness.max', n: 12, mean: 50, sd: 10, median: 50,
    q1: 40, q3: 60, iqr: 20, skewness: 0.1, kurtosis: -0.2, min: 20, max: 80, nullReasons: {},
  }],
  discrete: [],
};

function fakeManifest(outcome: 'succeeded' | 'failed') {
  return {
    analysisRunId: '99999999-9999-4999-8999-999999999999',
    snapshotAsOf: SNAPSHOT_AS_OF.toISOString(),
    recipeDigest: 'recipe-digest', sourceDigest: 'source-digest',
    ...(outcome === 'succeeded' ? { resultDigest: 'result-digest' } : {}),
    catalogVersion: 'v1', extractorVersion: 'v1', migrationVersion: 'v1',
    formulaPolicies: {}, estimabilityPolicyVersion: 'v0-preview-counts',
    engineVersion: 'v1-python-descriptive', serializerVersion: 'v1',
    outcome,
  };
}

const FAKE_ANALYZE_RESULT = {
  continuous: [{
    variableKey: 'knee.relatedness.max', kind: 'continuous', suppressed: false,
    n: 12, missingCount: 0, missingPatterns: [],
    mean: 50, sd: 10, median: 50, q1: 40, q3: 60, iqr: 20, skewness: 0.1, kurtosis: -0.2,
    min: 20, max: 80, nullReasons: {},
  }],
  discrete: [],
};

// cache miss → runStatsEngine 호출 → write 트랜잭션(BEGIN/DELETE/INSERT RETURNING/COMMIT).
function wireAnalyzeCacheMissSuccess(pool: Pool): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT
  const writeClient = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
  const wq = writeClient.query as ReturnType<typeof vi.fn>;
  wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
  wq.mockResolvedValueOnce({ rowCount: 0 }); // DELETE expired
  wq.mockResolvedValueOnce({ rows: [{ id: 'run-1', manifest: fakeManifest('succeeded'), result: FAKE_ANALYZE_RESULT }] }); // INSERT RETURNING
  wq.mockResolvedValueOnce({ rows: [] }); // COMMIT
}

// cache hit — cache-check SELECT만으로 끝나고 write 트랜잭션 없음.
function wireAnalyzeCacheHit(pool: Pool): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    rows: [{ manifest: fakeManifest('succeeded'), result: FAKE_ANALYZE_RESULT }],
  });
}

// "실행 전 거부"(denied) 경로 — stats_runs 행은 안 쓰지만 감사는 여전히
// withWriteTransaction(BEGIN+COMMIT)으로 감싸인다(writeAuditLogStrict 자체는 mock이라
// client.query를 거치지 않음).
function wireAuditOnlyWriteTransaction(pool: Pool): void {
  const writeClient = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
  const wq = writeClient.query as ReturnType<typeof vi.fn>;
  wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
  wq.mockResolvedValueOnce({ rows: [] }); // COMMIT
}

describe('POST /analyze — capability·rate limit', () => {
  it('stats.regression capability가 없으면 403(별도 grant 없이 default_all_roles=true라 보통은 통과)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool, { has_default: false, has_grant: false });
    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(res.status).toBe(403);
    expect(runStatsEngine).not.toHaveBeenCalled();
  });

  it('CSRF 토큰 없이 보내면 403이고 DB에 접근하지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .send(BASE_BODY);
    expect(res.status).toBe(403);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('POST /analyze — 요청 단위 억제(코호트 미달)는 caching과 무관하게 매번 새로 처리된다', () => {
  it('personCount<10이면 result가 전부 suppressed:true이고 감사 outcome은 denied다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(5));
    // 요청단위 억제도 stats_runs(cacheable=false)에 INSERT한다 — BEGIN+INSERT+COMMIT.
    const writeClient = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
    const wq = writeClient.query as ReturnType<typeof vi.fn>;
    wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
    wq.mockResolvedValueOnce({ rows: [] }); // INSERT stats_runs(cacheable=false)
    wq.mockResolvedValueOnce({ rows: [] }); // COMMIT
    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.result.continuous[0]).toEqual({
      variableKey: 'knee.relatedness.max', kind: 'continuous', suppressed: true,
    });
    expect(runStatsEngine).not.toHaveBeenCalled();
    const entry = writeAuditLogStrict.mock.calls[0][1];
    expect(entry.action).toBe('stats_analyze');
    expect(entry.outcome).toBe('denied');
  });
});

describe('POST /analyze — 정상 경로(4차 검토 §1 회귀 방지: 응답에 result가 실제로 담기는지)', () => {
  it('생성자(캐시 miss) — 200 + {runManifest, result} 둘 다 응답에 있고 DB에 저장+감사가 원자적으로 남는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    runStatsEngine.mockResolvedValueOnce(FAKE_RAW_ENGINE_RESULT);
    wireAnalyzeCacheMissSuccess(pool);

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.runManifest).toBeDefined();
    expect(res.body.runManifest.outcome).toBeUndefined(); // toPublicRunManifest가 제거
    expect(res.body.result).toEqual(FAKE_ANALYZE_RESULT);

    const entry = writeAuditLogStrict.mock.calls[0][1];
    expect(entry.action).toBe('stats_analyze');
    expect(entry.outcome).toBe('success');
  });

  it('DB 캐시 hit — Python을 호출하지 않고 기존 manifest/result를 그대로 반환한다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    wireAnalyzeCacheHit(pool);

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(FAKE_ANALYZE_RESULT);
    expect(runStatsEngine).not.toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalledTimes(1); // snapshot 트랜잭션뿐 — write 트랜잭션 없음

    const entry = writeAuditLogStrict.mock.calls[0][1];
    expect(entry.outcome).toBe('success');
    expect(entry.extra.cached).toBe(true);
  });

  it('Python 실패(TimeoutError) — 500 + failed 저장 + failure 감사, 원시 에러 상세는 응답에 없다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT

    const { StatsEngineTimeoutError } = await import('../../statsEngine');
    runStatsEngine.mockRejectedValueOnce(new StatsEngineTimeoutError());

    const writeClient = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
    const wq = writeClient.query as ReturnType<typeof vi.fn>;
    wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
    wq.mockResolvedValueOnce({ rows: [] }); // INSERT failed row
    wq.mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('TIMEOUT');
    expect(res.body.error).toBe('Analysis timed out.'); // 고정 메시지 — err.message 아님
    expect(JSON.stringify(res.body)).not.toMatch(/stack|Error:/);

    const entry = writeAuditLogStrict.mock.calls[0][1];
    expect(entry.outcome).toBe('failure');
    expect(entry.extra.errorCode).toBe('TIMEOUT');
  });

  it('8차 검토 §1 핵심 — 원시 에러 메시지(spawn 경로·DB 상세 등)가 HTTP 응답에 새어나가지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT

    const { StatsEngineProcessError } = await import('../../statsEngine');
    const sensitiveDetail = 'ENOENT: spawn C:\\opt\\stats-venv\\bin\\python /internal/scripts/analyze.py failed, DB connection string leaked here';
    runStatsEngine.mockRejectedValueOnce(new StatsEngineProcessError('PROCESS_ERROR', sensitiveDetail));

    const writeClient = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
    const wq = writeClient.query as ReturnType<typeof vi.fn>;
    wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
    wq.mockResolvedValueOnce({ rows: [] }); // INSERT failed row
    wq.mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('PROCESS_ERROR');
    expect(res.body.error).toBe('Analysis engine failed to complete.');
    expect(JSON.stringify(res.body)).not.toContain('ENOENT');
    expect(JSON.stringify(res.body)).not.toContain('stats-venv');
    expect(JSON.stringify(res.body)).not.toContain('leaked');
  });

  it('ENGINE_BUSY — stats_runs 행을 만들지 않고 denied 감사만 남긴다(429)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT

    const { StatsEngineBusyError } = await import('../../statsEngine');
    runStatsEngine.mockRejectedValueOnce(new StatsEngineBusyError());
    wireAuditOnlyWriteTransaction(pool);

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ENGINE_BUSY');
    // snapshot 트랜잭션 + 감사전용 트랜잭션(stats_runs INSERT는 없음, §5 표) — 2회.
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('9차 검토 §1 핵심 — 가드A(REQUEST_CAPACITY_EXCEEDED) 감사 실패는 429가 아니라 500으로 승격된다', async () => {
    const { __setActiveAnalyzeRequestsForTests } = await import('../../statsAnalyzeHandler');
    __setActiveAnalyzeRequestsForTests(4); // config.stats.maxConcurrentAnalyzeRequests(4)에 도달
    try {
      const pool = makePool();
      // 가드A는 auth→requireCapability→rateLimit→csrf를 전부 통과한 뒤 핸들러 최상단에서
      // 걸린다 — auth/capability는 여전히 정상 통과해야 한다.
      wireAuthAndCapability(pool);
      writeAuditLogStrict.mockRejectedValueOnce(new Error('audit db down'));

      const res = await request(makeApp(pool))
        .post('/api/stats/analyze')
        .set('Authorization', `Bearer ${orgToken()}`)
        .set('X-CSRF-Token', CSRF_TOKEN)
        .send(BASE_BODY);

      // 감사가 실패했으니 429(REQUEST_CAPACITY_EXCEEDED)가 아니라 500이어야 한다 — 이전
      // 판은 .catch(() => {})로 감사 실패를 삼키고 그대로 429를 내보냈다(기록 없이).
      expect(res.status).toBe(500);
      expect(res.body.code).not.toBe('REQUEST_CAPACITY_EXCEEDED');
      // 시도된 감사 호출 자체는 있어야 한다(REQUEST_CAPACITY_EXCEEDED 사유로) — 그 호출이
      // 실패했기 때문에 429가 아니라 500이 된 것이지, 애초에 감사를 안 시도한 게 아니다.
      const attempted = writeAuditLogStrict.mock.calls[0][1];
      expect(attempted.extra.reasonCode).toBe('REQUEST_CAPACITY_EXCEEDED');
    } finally {
      __setActiveAnalyzeRequestsForTests(0);
    }
  });

  it('감사 INSERT가 실패하면 같은 트랜잭션의 stats_runs INSERT도 롤백되고 500을 반환한다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    runStatsEngine.mockResolvedValueOnce(FAKE_RAW_ENGINE_RESULT);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT

    const writeClient = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
    const wq = writeClient.query as ReturnType<typeof vi.fn>;
    wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
    wq.mockResolvedValueOnce({ rowCount: 0 }); // DELETE expired
    wq.mockResolvedValueOnce({ rows: [{ id: 'run-1', manifest: fakeManifest('succeeded'), result: FAKE_ANALYZE_RESULT }] }); // INSERT RETURNING
    wq.mockResolvedValueOnce({ rows: [] }); // ROLLBACK (호출됨)

    writeAuditLogStrict.mockRejectedValueOnce(new Error('audit insert failed'));

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(500);
    expect(wq.mock.calls.some((c: unknown[]) => String(c[0]).startsWith('ROLLBACK'))).toBe(true);
    expect(wq.mock.calls.some((c: unknown[]) => String(c[0]) === 'COMMIT')).toBe(false);
  });
});

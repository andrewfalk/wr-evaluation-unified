import crypto from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
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
// PR3-B — 상관행렬 HTTP 라우트 wiring 테스트용.
const runCorrelationMatrixStatsEngine = vi.fn();
// PR3-B §9 — scatter 원시점 hasAccess:true HTTP 시나리오용(이변량).
const runBivariateStatsEngine = vi.fn();
vi.mock('../../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../statsEngine')>();
  return {
    ...actual,
    runStatsEngine: (...args: unknown[]) => runStatsEngine(...args),
    runCorrelationMatrixStatsEngine: (...args: unknown[]) => runCorrelationMatrixStatsEngine(...args),
    runBivariateStatsEngine: (...args: unknown[]) => runBivariateStatsEngine(...args),
  };
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
  // PR0-B3 Part A는 vibration_interval(7→9), Part B는 diagnosis_side(9→15), Part C-1은
  // job(15→18) 추가. Part C-2는 task grain(analytics-core 21개) + SNAPSHOT_COLUMN_VARIABLES
  // (담당의·등록일, +2, analytics-core 밖) 추가로 18→23. supportedGrains에 task 추가,
  // unsupportedGrains는 3→2(person/job_diagnosis만 남음).
  it('200 + 23개 변수, case+vibration_interval+diagnosis_side+job+task 지원, 감사 로그를 남기지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool)).get('/api/stats/catalog').set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.variables).toHaveLength(23);
    expect(res.body.supportedGrains).toEqual(['case', 'vibration_interval', 'diagnosis_side', 'job', 'task']);
    expect(res.body.unsupportedGrains).toHaveLength(2);
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('담당의는 analysisRole:analyzable, 등록일은 analysisRole:filter_only로 노출된다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool)).get('/api/stats/catalog').set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    const doctor = res.body.variables.find((v: { key: string }) => v.key === 'case.staff.assignedDoctorUserId');
    const registeredAt = res.body.variables.find((v: { key: string }) => v.key === 'case.meta.registeredAt');
    expect(doctor?.analysisRole).toBe('analyzable');
    expect(registeredAt?.analysisRole).toBe('filter_only');
    // 기존 7개 대표 변수 등은 analysisRole 필드를 명시적으로 선언하지 않았지만 .default()로
    // 'analyzable'로 해석돼야 한다(스키마 하위호환 계약).
    const kneeVar = res.body.variables.find((v: { key: string }) => v.key === 'knee.relatedness.max');
    expect(kneeVar?.analysisRole).toBe('analyzable');
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

// PR0-B3 Part A — vibration_interval grain end-to-end. GRAIN_NOT_YET_SUPPORTED이 아니라
// 실제로 snapshot→migrate→반복 관측치 추출→필터→estimability까지 도는지 실측한다.
describe('POST /preview — vibration_interval grain(PR0-B3 Part A)', () => {
  function vibrationCaseRow(id: string, personId: string, intervalCount: number) {
    return {
      id,
      patient_person_id: personId,
      assigned_doctor_user_id: null,
      created_at: new Date('2024-01-01T00:00:00.000Z'),
      payload: {
        data: {
          shared: { jobs: [{ id: 'job-1', jobName: '조립공' }] },
          modules: {
            spine: {
              vibrationIntervals: Array.from({ length: intervalCount }, (_, i) => ({
                id: `${id}-iv-${i}`,
                sharedJobId: 'job-1',
                awMin: 1.0,
                awMax: 1.5,
                timeValue: 4,
                timeUnit: 'hr',
              })),
            },
          },
          activeModules: ['spine'],
        },
      },
    };
  }

  it('grain=vibration_interval을 GRAIN_NOT_YET_SUPPORTED 없이 처리하고, caseCount!==observationCount일 수 있다(§2.2)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    // 11개 case는 구간 1개, 1개 case는 구간 2개 — caseCount=12, observationCount=13,
    // personCount=12(각 case가 다른 person) — §2.2 "반복 grain에서는 caseCount!==
    // observationCount"를 실제로 만든다.
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => vibrationCaseRow(`case-${i}`, `person-${i}`, 1)),
      vibrationCaseRow('case-11', 'person-11', 2),
    ];
    wireSnapshot(pool, rows);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'vibration_interval',
        variableKeys: ['spine.vibration.intervalA8Max'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(false);
    expect(res.body.counts.personCount).toBe(12);
    expect(res.body.counts.caseCount).toBe(12);
    expect(res.body.counts.observationCount).toBe(13);
  });

  it('grain과 변수의 grain이 다르면(case 변수를 vibration_interval grain에) VARIABLE_GRAIN_MISMATCH 400', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'vibration_interval',
        variableKeys: ['knee.relatedness.max'], // case grain 변수
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { code: string }) => e.code === 'VARIABLE_GRAIN_MISMATCH')).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('POST /analyze도 vibration_interval grain을 끝까지 처리한다(엔진 호출까지 grain-agnostic 배선 확인)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, Array.from({ length: 12 }, (_, i) => vibrationCaseRow(`case-${i}`, `person-${i}`, 1)));
    // FAKE_RAW_ENGINE_RESULT/FAKE_ANALYZE_RESULT는 'knee.relatedness.max' 전용 fixture라
    // 재사용할 수 없다(엔진 결과 매핑이 요청된 variableKey와 일치하는 항목을 찾으므로) —
    // 이 변수 전용의 최소 fixture를 직접 만든다.
    runStatsEngine.mockResolvedValueOnce({
      continuous: [{
        variableKey: 'spine.vibration.intervalA8Max', n: 12, mean: 1.1, sd: 0.2, median: 1.1,
        q1: 0.9, q3: 1.3, iqr: 0.4, skewness: 0, kurtosis: 0, min: 0.7, max: 1.5, nullReasons: {},
        histogram: null, boxplot: null,
      }],
      discrete: [],
    });
    wireAnalyzeCacheMissSuccess(pool, false, {
      continuous: [{
        variableKey: 'spine.vibration.intervalA8Max', kind: 'continuous', suppressed: false,
        n: 12, missingCount: 0, missingPatterns: [],
        mean: 1.1, sd: 0.2, median: 1.1, q1: 0.9, q3: 1.3, iqr: 0.4, skewness: 0, kurtosis: 0,
        min: 0.7, max: 1.5, nullReasons: {},
      }],
      discrete: [],
    });

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'vibration_interval',
        variableKeys: ['spine.vibration.intervalA8Max'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.runManifest).toBeDefined();
    expect(res.body.result.continuous[0].variableKey).toBe('spine.vibration.intervalA8Max');
    expect(res.body.result.continuous[0].n).toBe(12);
  });
});

// PR0-B3 Part B — diagnosis_side grain end-to-end. vibration_interval(Part A) 블록과
// 대칭 구조 — side==='both' explode가 이 grain 특유의 모집단 규칙이라는 점만 다르다.
describe('POST /preview — diagnosis_side grain(PR0-B3 Part B)', () => {
  function diagnosisSideCaseRow(id: string, personId: string, side: 'right' | 'both') {
    return {
      id,
      patient_person_id: personId,
      assigned_doctor_user_id: null,
      created_at: new Date('2024-01-01T00:00:00.000Z'),
      payload: {
        data: {
          shared: {
            diagnoses: [{ id: `${id}-dx`, code: 'M17.1', name: '무릎관절증', side, klgRight: '2', klgLeft: '3' }],
          },
          modules: {},
          activeModules: [],
        },
      },
    };
  }

  it('grain=diagnosis_side를 GRAIN_NOT_YET_SUPPORTED 없이 처리하고, side===both인 case는 행 2개를 낸다(§2.2)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    // 11개 case는 side=right(행 1개), 1개 case는 side=both(행 2개) — caseCount=12,
    // observationCount=13, personCount=12(각 case가 다른 person).
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => diagnosisSideCaseRow(`case-${i}`, `person-${i}`, 'right')),
      diagnosisSideCaseRow('case-11', 'person-11', 'both'),
    ];
    wireSnapshot(pool, rows);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'diagnosis_side',
        variableKeys: ['knee.diagnosisSide.klGrade'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(false);
    expect(res.body.counts.personCount).toBe(12);
    expect(res.body.counts.caseCount).toBe(12);
    expect(res.body.counts.observationCount).toBe(13);
  });

  it('grain과 변수의 grain이 다르면(case 변수를 diagnosis_side grain에) VARIABLE_GRAIN_MISMATCH 400', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'diagnosis_side',
        variableKeys: ['knee.relatedness.max'], // case grain 변수
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { code: string }) => e.code === 'VARIABLE_GRAIN_MISMATCH')).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('POST /analyze도 diagnosis_side grain을 끝까지 처리한다(엔진 호출까지 grain-agnostic 배선 확인)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, Array.from({ length: 12 }, (_, i) => diagnosisSideCaseRow(`case-${i}`, `person-${i}`, 'right')));
    // FAKE_RAW_ENGINE_RESULT/FAKE_ANALYZE_RESULT는 'knee.relatedness.max' 전용 fixture라
    // 재사용할 수 없다 — 이 변수 전용의 최소 fixture를 직접 만든다(discrete/ordinal 타입,
    // shared/contracts/stats.ts의 StatsEngineRawResult.discrete/AnalyzeDiscreteResultSchema
    // 그대로 — statsDescriptiveSuppression.test.ts와 동일한 raw 결과 shape).
    runStatsEngine.mockResolvedValueOnce({
      continuous: [],
      discrete: [{ variableKey: 'knee.diagnosisSide.klGrade', n: 12, levels: [{ level: '2', count: 12 }] }],
    });
    wireAnalyzeCacheMissSuccess(pool, false, {
      continuous: [],
      discrete: [{
        variableKey: 'knee.diagnosisSide.klGrade', kind: 'discrete', suppressed: false,
        n: 12, missingCount: 0, missingPatterns: null,
        levels: [{ level: '2', count: 12, proportion: 1 }], mode: '2',
      }],
    });

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'diagnosis_side',
        variableKeys: ['knee.diagnosisSide.klGrade'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.runManifest).toBeDefined();
    expect(res.body.result.discrete[0].variableKey).toBe('knee.diagnosisSide.klGrade');
    expect(res.body.result.discrete[0].n).toBe(12);
  });
});

// PR0-B3 Part C — job grain end-to-end. vibration_interval(Part A)/diagnosis_side(Part B)
// 블록과 대칭 구조 — job은 그 둘과 달리 어떤 모듈에도 속하지 않는 공유 필드(shared.jobs[])
// 라 activeModules 게이트가 없다는 점이 다르다.
describe('POST /preview — job grain(PR0-B3 Part C)', () => {
  function jobCaseRow(id: string, personId: string, jobCount: number) {
    return {
      id,
      patient_person_id: personId,
      assigned_doctor_user_id: null,
      created_at: new Date('2024-01-01T00:00:00.000Z'),
      payload: {
        data: {
          shared: {
            jobs: Array.from({ length: jobCount }, (_, i) => ({
              id: `${id}-job-${i}`,
              jobName: '용접공',
              startDate: '2015-01-01',
              endDate: '2020-01-01',
            })),
          },
          modules: {},
          activeModules: [],
        },
      },
    };
  }

  it('grain=job을 GRAIN_NOT_YET_SUPPORTED 없이 처리하고, 직력 2개인 case는 행 2개를 낸다(§2.2)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => jobCaseRow(`case-${i}`, `person-${i}`, 1)),
      jobCaseRow('case-11', 'person-11', 2),
    ];
    wireSnapshot(pool, rows);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['job.identity.jobNameNormalized'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(false);
    expect(res.body.counts.personCount).toBe(12);
    expect(res.body.counts.caseCount).toBe(12);
    expect(res.body.counts.observationCount).toBe(13);
  });

  it('grain과 변수의 grain이 다르면(case 변수를 job grain에) VARIABLE_GRAIN_MISMATCH 400', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['knee.relatedness.max'], // case grain 변수
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { code: string }) => e.code === 'VARIABLE_GRAIN_MISMATCH')).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('POST /analyze도 job grain을 끝까지 처리한다(엔진 호출까지 grain-agnostic 배선 확인)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, Array.from({ length: 12 }, (_, i) => jobCaseRow(`case-${i}`, `person-${i}`, 1)));
    runStatsEngine.mockResolvedValueOnce({
      continuous: [],
      discrete: [{ variableKey: 'job.identity.jobNameNormalized', n: 12, levels: [{ level: '용접공', count: 12 }] }],
    });
    wireAnalyzeCacheMissSuccess(pool, false, {
      continuous: [],
      discrete: [{
        variableKey: 'job.identity.jobNameNormalized', kind: 'discrete', suppressed: false,
        n: 12, missingCount: 0, missingPatterns: null,
        levels: [{ level: '용접공', count: 12, proportion: 1 }], mode: '용접공',
      }],
    });

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['job.identity.jobNameNormalized'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.runManifest).toBeDefined();
    expect(res.body.result.discrete[0].variableKey).toBe('job.identity.jobNameNormalized');
    expect(res.body.result.discrete[0].n).toBe(12);
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
    histogram: null, boxplot: null,
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

// attachLimitedRowFields()는 continuous[i].boxplot.outlierCount가 존재해야만
// (undefined가 아니어야) limited_row 병합을 시도한다 — FAKE_ANALYZE_RESULT엔
// boxplot 자체가 없어 이 경로가 항상 no-op이었다(hasAccess:true여도). 실제
// outlierValues 계산은 ctx.dataset.rows의 실측값이 필요하지만, 이 fixture의
// 환자 payload는 전부 비어있어(manyDistinctPersons) 실제 outlier 유무를
// 재현하지는 못한다 — 아래 신규 테스트들의 목적은 "라우트 배선"(capability→
// attach→응답 직렬화→신규 감사) 확인이지 추출값 정확성 확인이 아니다.
const FAKE_ANALYZE_RESULT_WITH_BOXPLOT = {
  continuous: [{
    ...FAKE_ANALYZE_RESULT.continuous[0],
    boxplot: { q1: 40, median: 50, q3: 60, lowerWhisker: 20, upperWhisker: 80, outlierCount: 0 },
  }],
  discrete: [],
};

// PR3-B §9 — finalizeAnalyzeResponse가 응답 직전 stats.export_limited_rows
// capability를 매번 재확인한다(hasCapability, pool.query 별도 1회). 이 테스트
// 스위트의 기본 사용자는 그 권한이 없다고 가정(has_default/has_grant 둘 다 false)
// — limited_row 필드가 붙지 않아 신규 감사 단계도 발생하지 않는다.
function wireNoLimitedRowAccess(pool: Pool): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ has_default: false, has_grant: false }] });
}

// 코드리뷰 지적(2026-09-11) — 이 파일의 모든 /analyze HTTP 테스트가 지금까지
// hasAccess:false만 wiring해, limited_row 필드가 응답에 "실제로 붙는지"는 단위
// 테스트(statsLimitedRowMerge.test.ts, attachLimitedRowFields 직접 호출)만 검증
//하고 실제 라우트(hasCapability→attachLimitedRowFields→응답 직렬화) 전체 배선은
// HTTP 레벨에서 한 번도 확인된 적이 없었다. has_grant:true로 wiring해 그 배선을
// 실제로 켠다.
function wireHasLimitedRowAccess(pool: Pool): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ has_default: false, has_grant: true }] });
}

// cache miss → runStatsEngine 호출 → write 트랜잭션(BEGIN/DELETE/INSERT RETURNING/COMMIT).
function wireAnalyzeCacheMissSuccess(pool: Pool, hasLimitedRowAccess = false, resultOverride: unknown = FAKE_ANALYZE_RESULT): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT
  const writeClient = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
  const wq = writeClient.query as ReturnType<typeof vi.fn>;
  wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
  wq.mockResolvedValueOnce({ rowCount: 0 }); // DELETE expired
  wq.mockResolvedValueOnce({ rows: [{ id: 'run-1', manifest: fakeManifest('succeeded'), result: resultOverride }] }); // INSERT RETURNING
  wq.mockResolvedValueOnce({ rows: [] }); // COMMIT
  // finalizeAnalyzeResponse의 hasCapability 조회.
  if (hasLimitedRowAccess) wireHasLimitedRowAccess(pool); else wireNoLimitedRowAccess(pool);
}

// cache hit — cache-check SELECT만으로 끝나고 write 트랜잭션 없음.
function wireAnalyzeCacheHit(pool: Pool, hasLimitedRowAccess = false, resultOverride: unknown = FAKE_ANALYZE_RESULT): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    rows: [{ manifest: fakeManifest('succeeded'), result: resultOverride }],
  });
  // finalizeAnalyzeResponse의 hasCapability 조회.
  if (hasLimitedRowAccess) wireHasLimitedRowAccess(pool); else wireNoLimitedRowAccess(pool);
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

// ---------------------------------------------------------------------------
// 코드리뷰 지적(2026-09-11) — §9(캐시-권한 드리프트 방지) "필드 2종×요청 경로
// 3종" 중 지금까지 이 파일의 모든 /analyze HTTP 테스트가 hasAccess:false만
// wiring해서, hasCapability가 true를 반환할 때 실제 라우트가 limited_row 필드를
// 응답에 붙이는지가 HTTP 레벨에서 한 번도 확인되지 않았다(순수 함수
// attachLimitedRowFields() 자체는 statsLimitedRowMerge.test.ts가 이미 검증).
// 아래는 생성자(캐시미스)·캐시hit 두 경로(둘 다 finalizeAnalyzeResponse를 공유,
// statsAnalyzeHandler.ts:525)에서 hasAccess:true일 때 실제로 필드가 붙는지와
// 신규 감사 실패 시 500을 검증한다. in-flight 합류자 경로(statsAnalyzeHandler.ts:580,
// 세 번째 호출부)의 hasAccess:true HTTP 시나리오는 동시 요청 시뮬레이션이 필요해
// 이번엔 다루지 않았다 — 남은 갭으로 명시.
// ---------------------------------------------------------------------------
describe('POST /analyze — limited_row 필드 응답시점 merge(§9, hasAccess:true)', () => {
  it('생성자(캐시 미스) 경로 — hasAccess:true면 응답에 boxplot.outlierValues가 실제로 붙고 신규 감사가 남는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    runStatsEngine.mockResolvedValueOnce(FAKE_RAW_ENGINE_RESULT);
    wireAnalyzeCacheMissSuccess(pool, true, FAKE_ANALYZE_RESULT_WITH_BOXPLOT);

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.result.continuous[0].boxplot.outlierValues).toBeDefined();
    expect(Array.isArray(res.body.result.continuous[0].boxplot.outlierValues)).toBe(true);
    // 첫 호출은 기존 stats_analyze 성공 감사(computeAndPersist 내부), 두 번째가
    // §9 신규 감사(limitedRowFieldsAttached:true) — 둘 다 실제로 남는지 확인.
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(2);
    const secondCallExtra = writeAuditLogStrict.mock.calls[1][1].extra;
    expect(secondCallExtra.limitedRowFieldsAttached).toBe(true);
    expect(typeof secondCallExtra.deliveredResultDigest).toBe('string');
  });

  it('캐시 hit 경로 — hasAccess:true면 캐시된 aggregate 결과에도 응답시점에 boxplot.outlierValues가 붙는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12)); // buildAnalysisContext는 캐시 hit 여부와 무관하게 항상 스냅샷을 읽는다.
    wireAnalyzeCacheHit(pool, true, FAKE_ANALYZE_RESULT_WITH_BOXPLOT);

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.result.continuous[0].boxplot.outlierValues).toBeDefined();
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(2); // cached:true 감사 + §9 신규 감사
    expect(writeAuditLogStrict.mock.calls[1][1].extra.limitedRowFieldsAttached).toBe(true);
  });

  // 코드리뷰 지적(2026-09-11, 2차) — "동일 사용자의 grant 부여·회수 전후 필드
  // 존재 여부가 즉시 바뀌는지"를 아직 아무 테스트도 확인하지 않았다는 지적.
  // 캐시 hit는 stats_runs에 저장된 aggregate 결과 자체는 매 요청 동일하게
  // 재사용하면서도, hasCapability는 매 요청 새로 조회한다(§9 설계) — 즉 "같은
  // 캐시 행"에 대해 권한 조회 결과만 바꿔 연속 2회 요청하면, 캐시가 이전 요청의
  // 권한 판정을 낡은 채로 재서빙하지 않고 매번 최신 권한을 반영하는지 확인할 수
  // 있다(실제 동시성 경쟁 시뮬레이션 없이도 "캐시가 권한을 같이 캐싱하지 않는다"는
  // 핵심 불변조건을 직접 증명).
  it('권한 부여→회수(또는 그 반대) 전후 — 같은 캐시된 결과라도 매 요청 최신 hasCapability를 그대로 반영한다', async () => {
    const pool = makePool();

    // 1차 요청 — 이 시점엔 권한 없음(has_grant:false).
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    wireAnalyzeCacheHit(pool, false, FAKE_ANALYZE_RESULT_WITH_BOXPLOT);
    const before = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(before.status).toBe(200);
    expect(before.body.result.continuous[0].boxplot.outlierValues).toBeUndefined();

    // 2차 요청 — 같은 사용자·같은 캐시된 결과, 그 사이 권한이 부여됨(has_grant:true).
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    wireAnalyzeCacheHit(pool, true, FAKE_ANALYZE_RESULT_WITH_BOXPLOT);
    const after = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(after.status).toBe(200);
    expect(after.body.result.continuous[0].boxplot.outlierValues).toBeDefined();

    // 3차 요청 — 다시 회수됨(has_grant:false로 복귀) — 캐시가 2차 요청 때 부여된
    // 권한을 "기억"해 계속 내려주지 않는지 확인(진짜 매 요청 재조회인지의 핵심).
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    wireAnalyzeCacheHit(pool, false, FAKE_ANALYZE_RESULT_WITH_BOXPLOT);
    const revoked = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);
    expect(revoked.status).toBe(200);
    expect(revoked.body.result.continuous[0].boxplot.outlierValues).toBeUndefined();
  });

  it('§9 신규 감사(limitedRowFieldsAttached) 기록이 실패하면 500을 반환하고 응답 바디에 원시 필드가 없다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    runStatsEngine.mockResolvedValueOnce(FAKE_RAW_ENGINE_RESULT);
    wireAnalyzeCacheMissSuccess(pool, true, FAKE_ANALYZE_RESULT_WITH_BOXPLOT);
    writeAuditLogStrict
      .mockResolvedValueOnce(undefined) // 1차: computeAndPersist의 성공 감사는 정상
      .mockRejectedValueOnce(new Error('audit db down')); // 2차: §9 신규 감사만 실패

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BASE_BODY);

    expect(res.status).toBe(500);
    expect(res.body.result).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('outlierValues');
  });
});

// ---------------------------------------------------------------------------
// PR3-B §9 — in-flight 합류자 경로(statsAnalyzeHandler.ts의 두 번째 finalizeAnalyzeResponse
// 호출부, 생성자와 별개)의 hasAccess:true HTTP 시나리오. 지금까지 이 스위트엔
// 합류자 경로 HTTP 테스트가 하나도 없었다(hasAccess 여부 무관하게) — 두 concurrent
// 요청을 실제로 같은 in-flight map 엔트리에 합류시켜야 해서 나머지 테스트의
// "순서대로 쌓아두는 mockResolvedValueOnce 큐" 패턴을 못 쓴다(두 요청의 실제 실행
// 순서가 어느 쪽이 먼저 등록되는지에 좌우되기 때문). 대신 SQL 텍스트/파라미터로
// 라우팅하는 mockImplementation을 쓴다 — 어느 요청이 몇 번째로 도착하든 항상 같은
// 값을 돌려주므로(순서에 의존하지 않음) 진짜 동시성 아래서도 flaky하지 않다.
// runStatsEngine()만 수동으로 붙잡아 두어(제어된 지연) 두 요청 다 getOrCompute()에
// 도달할 시간을 확보한다.
// ---------------------------------------------------------------------------
describe('POST /analyze — in-flight 합류자(joiner)의 독립적인 hasAccess 재확인(§9)', () => {
  function makeConcurrencyAwarePool(): { pool: Pool; setLimitedRowAccessSequence: (seq: boolean[]) => void } {
    let limitedRowAccessSequence: boolean[] = [];
    let limitedRowAccessCallIndex = 0;

    function makeClient() {
      const client = { query: vi.fn(), release: vi.fn() };
      (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
        if (sql.includes('BEGIN')) return { rows: [] };
        if (sql.includes('clock_timestamp')) return { rows: [{ snapshot_as_of: SNAPSHOT_AS_OF }] };
        if (sql.includes('patient_records') && sql.includes('SELECT')) return { rows: manyDistinctPersons(12) };
        if (sql.includes('DELETE FROM stats_runs')) return { rowCount: 0 };
        if (sql.includes('INSERT INTO stats_runs')) {
          return { rows: [{ id: 'run-1', manifest: fakeManifest('succeeded'), result: FAKE_ANALYZE_RESULT_WITH_BOXPLOT }] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`makeConcurrencyAwarePool: unexpected client.query — ${sql}`);
      });
      return client;
    }

    const pool = { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
    (pool.connect as ReturnType<typeof vi.fn>).mockImplementation(async () => makeClient());
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM sessions')) return { rows: [{ exists: 1 }] };
      if (sql.includes('has_default')) {
        const capability = (params as string[])[0];
        if (capability === 'stats.export_limited_rows') {
          // 호출 순서대로 미리 정해둔 시퀀스를 소비한다 — 생성자/합류자 중 누가
          // 몇 번째로 이 지점(finalizeAnalyzeResponse)에 도달하든(그건 매 실행마다
          // 달라질 수 있음, 아래 검증도 순서에 의존하지 않는다), "두 번 독립적으로
          // 호출되고 각각 다른 값을 정직하게 반영하는지"만 확인한다.
          const has_grant = limitedRowAccessSequence[limitedRowAccessCallIndex] ?? false;
          limitedRowAccessCallIndex += 1;
          return { rows: [{ has_default: false, has_grant }] };
        }
        return { rows: [{ has_default: true, has_grant: false }] }; // stats.regression 라우트 게이트 — 항상 통과
      }
      if (sql.includes('SELECT manifest, result FROM stats_runs')) return { rows: [] }; // cache miss — 생성자만 도달
      throw new Error(`makeConcurrencyAwarePool: unexpected pool.query — ${sql}`);
    });

    return {
      pool,
      setLimitedRowAccessSequence: (seq: boolean[]) => { limitedRowAccessSequence = seq; limitedRowAccessCallIndex = 0; },
    };
  }

  it('두 동시 요청이 같은 계산에 합류해도, 응답시점 hasCapability 재확인은 각자 독립적으로 실행되고 그 결과를 정확히 반영한다', async () => {
    const { pool, setLimitedRowAccessSequence } = makeConcurrencyAwarePool();
    // 1번째로 finalizeAnalyzeResponse에 도달하는 쪽은 권한 없음, 2번째는 권한 있음
    // — 생성자/합류자 어느 쪽이 몇 번째인지는 실행마다 달라질 수 있어도, "두 응답
    // 중 정확히 하나는 필드가 있고 하나는 없다"는 것 자체가 독립 재확인의 증거다.
    setLimitedRowAccessSequence([false, true]);

    // mockImplementationOnce가 아니라 mockImplementation을 쓴다 — vi.mock()으로 감싼
    // (...) => runStatsEngine(...) 프록시 간접호출과 조합했을 때 once 큐가 기대대로
    // 소비되지 않는 현상을 실측으로 확인했다(디버그 로그로 두 요청 다 계산 함수에
    // 전혀 도달하지 못하는 것까지 재현) — 이 파일의 다른 테스트들처럼 매 it()가
    // beforeEach(vi.clearAllMocks())로 호출 기록만 초기화되고 이 구현 자체는 매번
    // 이 지점에서 새로 지정하므로 다음 테스트로 새지 않는다.
    let resolveEngine!: (v: unknown) => void;
    runStatsEngine.mockImplementation(() => new Promise((resolve) => { resolveEngine = resolve; }));

    const app1 = makeApp(pool);
    const app2 = makeApp(pool); // 같은 pool을 공유하는 별개 app — statsAnalyzeInFlight의 in-flight map은 모듈 싱글턴이라 두 app 사이에서도 합류가 성립한다.
    const req1 = request(app1).post('/api/stats/analyze').set('Authorization', `Bearer ${orgToken()}`).set('X-CSRF-Token', CSRF_TOKEN).send(BASE_BODY);
    const req2 = request(app2).post('/api/stats/analyze').set('Authorization', `Bearer ${orgToken()}`).set('X-CSRF-Token', CSRF_TOKEN).send(BASE_BODY);
    // supertest의 Test 객체는 thenable이라 .then()/.end()/await 전까지는 실제로
    // 전송되지 않는다(지연 디스패치) — 아래 폴링 루프가 시작되기 전에 .then()으로
    // 명시적으로 즉시 발사시켜야 한다(안 그러면 두 요청 다 아직 안 나간 채로
    // runStatsEngine 호출을 기다려 폴링이 영원히 0에서 멈춘다 — 실측으로 확인).
    // 나중에 Promise.all([req1, req2])로 다시 기다려도 재전송되지 않고 같은
    // 진행 중인 요청에 그대로 이어붙는다.
    void req1.then(() => {}, () => {});
    void req2.then(() => {}, () => {});

    // 두 요청 다 buildAnalysisContext(여러 await 단계)를 거쳐 getOrCompute() 등록까지
    // 도달할 시간을 준다 — runStatsEngine이 아직 붙잡혀 있어 생성자의 계산이 끝나지
    // 않은 채로 유지되므로, 이 대기가 길어져도 결과가 달라지지 않는다(고정 tick 수
    // 대신 실제로 runStatsEngine이 호출될 때까지 폴링 — await 단계 수에 안 흔들림).
    for (let attempt = 0; attempt < 200 && runStatsEngine.mock.calls.length === 0; attempt += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runStatsEngine.mock.calls.length).toBeGreaterThan(0); // 생성자가 여기까지 도달했는지 먼저 확인

    resolveEngine(FAKE_RAW_ENGINE_RESULT);
    const [res1, res2] = await Promise.all([req1, req2]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(runStatsEngine).toHaveBeenCalledTimes(1); // 계산 자체는 한 번만(합류 성공 증거)

    const outlierFlags = [res1, res2].map(
      (r) => r.body.result.continuous[0].boxplot.outlierValues !== undefined,
    );
    // 정확히 한쪽만 true, 한쪽만 false — 두 응답이 서로 다른 hasCapability 결과를
    // 각자 반영했다는 뜻(캐시/공유 계산 결과에 권한 판정이 섞여들지 않음).
    expect(outlierFlags.filter(Boolean)).toHaveLength(1);

    // stats_analyze 성공 감사는 총 3건이어야 한다 — (a) 생성자의 완료 감사
    // (computeAndPersist 내부, extra에 cached/joinedInFlight 없음), (b) 합류자의
    // 완료 감사(joinedInFlight:true), (c) 응답시점 hasAccess:true였던 쪽 1건에
    // 대한 §9 신규 감사(limitedRowFieldsAttached:true) — 둘 다 hasAccess:true인
    // 게 아니라 시퀀스상 정확히 하나만 true였으므로 §9 감사도 정확히 1건이다.
    const allSuccessAudits = writeAuditLogStrict.mock.calls
      .map((c) => c[1])
      .filter((call) => call.outcome === 'success' && call.action === 'stats_analyze');
    const limitedRowAudits = allSuccessAudits.filter((a) => a.extra?.limitedRowFieldsAttached === true);
    const completionAudits = allSuccessAudits.filter((a) => a.extra?.limitedRowFieldsAttached === undefined);

    expect(completionAudits).toHaveLength(2); // 생성자 1 + 합류자 1
    expect(completionAudits.some((a) => a.extra?.joinedInFlight === true)).toBe(true);
    expect(limitedRowAudits).toHaveLength(1); // hasAccess:true였던 쪽 1건뿐(둘 다 아님)
  });
});

// ---------------------------------------------------------------------------
// PR3-B §9 — scatter 원시 points의 hasAccess:true HTTP 시나리오(이변량). 지금까지
// 이 스위트엔 bivariate 모드용 mocked HTTP 테스트 인프라 자체가 없었다(bivariate
// HTTP 검증은 전부 statsBivariateHttp.integration.test.ts의 실제 Postgres+실제
// Python 통합테스트로만 존재, PR3-A 때부터). boxplot 테스트처럼 manyDistinctPersons()
// (payload가 텅 빈 가짜 환자)로는 안 된다 — computeAvailableMethods()가 pair의
// includedPersonCount===0이면 이변량 방법 전부를 곧바로 unsupported/INSUFFICIENT_DATA로
// 판정해(상관행렬의 판정 기준인 dataset.personCount와는 다른 기준) 400
// METHOD_NOT_AVAILABLE로 막혀 Python 호출 자체에 도달하지 못한다(실측 확인). 그래서
// 로컬 dev DB에 이미 시딩돼 있던 실제 가상환자 중 knee.relatedness.max·
// spine.mddm.lifetimeDoseMNh 둘 다 실측으로 non-missing인 12명(=12 케이스, personCount
// ===rowCount라 §6.1 게이트도 통과)만 골라 fixtures_kneeSpinePatients.json으로 추출해
// 재사용한다(추측으로 payload를 손으로 짜지 않음 — 실제 analytics-core 추출기로
// 직접 검증한 값).
// ---------------------------------------------------------------------------
const KNEE_SPINE_FIXTURE_ROWS = (JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures_kneeSpinePatients.json'), 'utf8'),
) as Array<{ id: string; patient_person_id: string; assigned_doctor_user_id: string | null; created_at: string; payload: unknown }>)
  .map((r) => ({ ...r, created_at: new Date(r.created_at) }));

const BIVARIATE_BODY = {
  grain: 'case',
  variableKeys: ['knee.relatedness.max', 'spine.mddm.lifetimeDoseMNh'],
  filters: [],
  analysisPurpose: 'association',
  formulaPolicies: { spine_mddm: 'recompute_current' },
  analysisMode: 'bivariate',
  requestedMethod: 'pearson_correlation',
};

// StatsEngineBivariateRawResult(=raw.bivariate) 형태 — n은 buildBivariateEngineRequest가
// 만드는 x/y 길이(=완전사례 12건)와 정확히 일치해야 §2.2 의미검증(validateBivariateSemantics)을
// 통과한다.
const FAKE_BIVARIATE_RAW_RESULT = {
  method: 'pearson_correlation' as const,
  n: 12,
  statistic: 0.5,
  df: 10,
  pValue: 0.05,
  effectSizes: [{ name: 'r', value: 0.5, ci: [0.1, 0.8] as [number, number], ciUnavailableReason: null }],
  nullReasons: {},
  multipleTesting: { method: 'none' as const, adjustedP: null },
  qualityFlags: [],
  extra: {},
  regressionLine: { slope: 1.2, intercept: 3.4 },
};

describe('POST /analyze — scatter 원시 points 응답시점 merge(§9, hasAccess:true, 이변량)', () => {
  it('생성자(캐시 미스) 경로 — hasAccess:true면 bivariate.scatter.points가 실제로 붙는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, KNEE_SPINE_FIXTURE_ROWS);
    runBivariateStatsEngine.mockResolvedValueOnce(FAKE_BIVARIATE_RAW_RESULT);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT
    const writeClient = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
    const wq = writeClient.query as ReturnType<typeof vi.fn>;
    wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
    wq.mockResolvedValueOnce({ rowCount: 0 }); // DELETE expired
    // computeAndPersist가 실제로 계산한 bivariate 결과(scatter.grid 포함, points는
    // 아직 없음)를 그대로 저장 결과인 척 돌려준다 — statsLimitedRowMerge.ts가
    // ctx.paired.pairs에서 응답시점에 points를 채워 넣는지가 검증 대상이므로, 여기
    // INSERT RETURNING 값 자체에는 points가 없어야 그 병합을 실제로 확인하는 것.
    wq.mockResolvedValueOnce({
      rows: [{
        id: 'run-1', manifest: fakeManifest('succeeded'),
        result: {
          continuous: [], discrete: [],
          bivariate: {
            method: 'pearson_correlation', suppressed: false,
            n: 12, statistic: 0.5, df: 10, pValue: 0.05,
            effectSizes: FAKE_BIVARIATE_RAW_RESULT.effectSizes, nullReasons: {},
            multipleTesting: { method: 'none', adjustedP: null },
            qualityFlags: [], extra: {}, excludedCaseCount: 0, exclusions: [],
            regressionLine: FAKE_BIVARIATE_RAW_RESULT.regressionLine,
            scatter: { displayedCount: 12, totalCount: 12 }, // grid는 없을 수도 있음 — points 부재가 핵심
          },
        },
      }],
    }); // INSERT RETURNING
    wq.mockResolvedValueOnce({ rows: [] }); // COMMIT
    wireHasLimitedRowAccess(pool); // finalizeAnalyzeResponse의 hasCapability 조회

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BIVARIATE_BODY);

    expect(res.status).toBe(200);
    expect(runBivariateStatsEngine).toHaveBeenCalledTimes(1);
    const bivariate = res.body.result.bivariate;
    expect(bivariate.suppressed).toBe(false);
    expect(bivariate.scatter.points).toBeDefined();
    expect(Array.isArray(bivariate.scatter.points)).toBe(true);
    expect(bivariate.scatter.points).toHaveLength(12); // 완전사례 12건 전부(2,000 이하라 표본추출 없음)
    expect(bivariate.scatter.displayedCount).toBe(12);
    // §9 신규 감사(limitedRowFieldsAttached)도 남는지 확인.
    const limitedRowAudit = writeAuditLogStrict.mock.calls
      .map((c) => c[1])
      .find((call) => call.extra?.limitedRowFieldsAttached === true);
    expect(limitedRowAudit).toBeDefined();
  });

  it('hasAccess:false면 bivariate.scatter.points가 붙지 않는다(grid만 있거나 아예 없음)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, KNEE_SPINE_FIXTURE_ROWS);
    runBivariateStatsEngine.mockResolvedValueOnce(FAKE_BIVARIATE_RAW_RESULT);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // cache-check SELECT
    const writeClient = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(writeClient);
    const wq = writeClient.query as ReturnType<typeof vi.fn>;
    wq.mockResolvedValueOnce({ rows: [] }); // BEGIN
    wq.mockResolvedValueOnce({ rowCount: 0 }); // DELETE expired
    wq.mockResolvedValueOnce({
      rows: [{
        id: 'run-1', manifest: fakeManifest('succeeded'),
        result: {
          continuous: [], discrete: [],
          bivariate: {
            method: 'pearson_correlation', suppressed: false,
            n: 12, statistic: 0.5, df: 10, pValue: 0.05,
            effectSizes: FAKE_BIVARIATE_RAW_RESULT.effectSizes, nullReasons: {},
            multipleTesting: { method: 'none', adjustedP: null },
            qualityFlags: [], extra: {}, excludedCaseCount: 0, exclusions: [],
            regressionLine: FAKE_BIVARIATE_RAW_RESULT.regressionLine,
            scatter: { displayedCount: 12, totalCount: 12 },
          },
        },
      }],
    });
    wq.mockResolvedValueOnce({ rows: [] }); // COMMIT
    wireNoLimitedRowAccess(pool);

    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(BIVARIATE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.result.bivariate.scatter.points).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PR3-B — POST /analyze, analysisMode='correlation_matrix' HTTP 라우트 wiring.
// 실제 catalog(getFullVariableCatalog)의 continuous 변수 3개를 그대로 쓴다 —
// payload가 비어있는 fixture라 실제 추출값은 전부 결측이지만(presentPersonCount=0),
// pair의 includedPersonCount/excludedPersonCount 둘 다 소수셀이 아니고(0/12)
// §6.1 게이트도 0===0으로 통과해 gate 자체는 열린다 — 이 테스트는 배선(라우터→
// context→suppression→응답)을 확인하는 것이지 추출 정확성을 확인하는 게 아니다
// (기존 bivariate/descriptive HTTP 테스트와 동일한 전제).
// ---------------------------------------------------------------------------
const CORRELATION_MATRIX_BODY = {
  grain: 'case',
  variableKeys: ['knee.relatedness.max', 'cervical.case.maxJobCumulativeKgHours', 'spine.mddm.lifetimeDoseMNh'],
  filters: [],
  analysisPurpose: 'association',
  // spine.mddm.lifetimeDoseMNh는 유일하게 supportedFormulaPolicies가 2개(spine_mddm
  // family)라 명시가 필요하다(statsRecipeValidation.ts §A-8).
  formulaPolicies: { spine_mddm: 'recompute_current' },
  analysisMode: 'correlation_matrix',
  requestedMethod: 'pearson_correlation',
};

describe('POST /analyze — correlation_matrix HTTP 라우트 wiring(PR3-B)', () => {
  it('정상 경로 — 200 + cells 3개(C(3,2)) + adjustedPWithheld:false', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    runCorrelationMatrixStatsEngine.mockResolvedValueOnce({
      method: 'pearson_correlation',
      cells: [
        { xKey: 'knee.relatedness.max', yKey: 'cervical.case.maxJobCumulativeKgHours', n: 0, r: 0.5, pValue: 0.4, adjustedP: 0.4 },
        { xKey: 'knee.relatedness.max', yKey: 'spine.mddm.lifetimeDoseMNh', n: 0, r: 0.3, pValue: 0.5, adjustedP: 0.5 },
        { xKey: 'cervical.case.maxJobCumulativeKgHours', yKey: 'spine.mddm.lifetimeDoseMNh', n: 0, r: -0.2, pValue: 0.6, adjustedP: 0.6 },
      ],
    });
    wireAnalyzeCacheMissSuccess(pool);
    // wireAnalyzeCacheMissSuccess가 INSERT RETURNING에서 FAKE_ANALYZE_RESULT(다른 모양)를
    // 반환하므로, 이 라우트 wiring 테스트에서는 실제 저장 결과를 직접 다시 덮어써 확인한다.
    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(CORRELATION_MATRIX_BODY);

    expect(res.status).toBe(200);
    expect(runCorrelationMatrixStatsEngine).toHaveBeenCalledTimes(1);
  });

  it('선택한 method가 availableMethods에 없으면(예: welch_t 오용) 400 METHOD_NOT_AVAILABLE', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(12));
    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ ...CORRELATION_MATRIX_BODY, requestedMethod: 'welch_t' });
    // welch_t는 상관행렬 모드에서 statsRecipeValidation.ts가 이미 400으로 거부한다
    // (CORRELATION_MATRIX_METHOD_NOT_SUPPORTED) — availableMethods 조회 이전 단계.
    expect(res.status).toBe(400);
    expect(runCorrelationMatrixStatsEngine).not.toHaveBeenCalled();
  });

  it('변수가 2개뿐이면 400(zod superRefine — CORRELATION_MATRIX_REQUIRES_AT_LEAST_THREE_VARIABLES)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/analyze')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ ...CORRELATION_MATRIX_BODY, variableKeys: ['knee.relatedness.max', 'spine.mddm.lifetimeDoseMNh'] });
    expect(res.status).toBe(400);
    expect(runCorrelationMatrixStatsEngine).not.toHaveBeenCalled();
  });

  // 코드리뷰 수정(2026-09-11) — 요청 전체가 조기 억제(코호트 미달)되는 경로는
  // buildAnalysisContext가 실패하기 전이라 runCorrelationMatrixStatsEngine을 아예
  // 안 부른다(buildSuppressedAnalyzeResult가 대신 응답을 만든다). 이 경로의
  // cells는 전부 suppressed:true인데 adjustedPWithheld가 false로 하드코딩돼
  // 있었다 — §4.1 불변조건("억제 셀이 하나라도 있으면 true", 실제 계산 경로인
  // statsCorrelationMatrixSuppression.ts는 이미 지킴)을 위반했던 걸 고쳤다.
  it('요청 단위 억제(코호트 미달)면 cells 전부 suppressed:true + adjustedPWithheld:true(불변조건)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(5)); // <10 — 전체 억제
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
      .send(CORRELATION_MATRIX_BODY);
    expect(res.status).toBe(200);
    expect(res.body.result.correlationMatrix.cells).toHaveLength(3); // C(3,2)
    expect(res.body.result.correlationMatrix.cells.every((c: { suppressed: boolean }) => c.suppressed)).toBe(true);
    expect(res.body.result.correlationMatrix.adjustedPWithheld).toBe(true);
    expect(runCorrelationMatrixStatsEngine).not.toHaveBeenCalled();
  });

  // 코드리뷰 수정 2차(2026-09-11) — 입력 상한 초과 요청은
  // buildAnalysisContext()가 O(k²×rows) pair 순회를 시작하기 전에 즉시 거부해야
  // 한다(§8). 이 검사는 /preview·/analyze가 공유하는 buildAnalysisContext() 안에
  // 있으므로, Python 서브프로세스를 아예 스폰하지 않는 /preview로 확인하는 게
  // "검사가 순회 전에 걸린다"를 가장 직접적으로 보여준다. 120,000행은 변수당
  // 상한(MAX_VALUES_PER_VARIABLE=50,000) 자체를 넘어(그래서 3×120,000=360,000
  // 총합 상한 초과보다 VALUES_PER_VARIABLE_EXCEEDED가 먼저 걸린다 — 세 상한 중
  // 이 값만 empty-payload 픽스처(모든 값이 null이라 바이트 상한 케이스는 이
  // 방식으로 재현 불가)로도 HTTP 레벨에서 값 자체와 무관하게 저렴하게 재현
  // 가능하다). 나머지 두 상한(TOTAL_VALUES_EXCEEDED/SERIALIZED_BYTES_EXCEEDED,
  // 특히 후자는 실제 고정밀 소수값이 있어야 재현되므로 이 스위트의 빈 payload
  // 픽스처로는 못 만듦)은 `statsCorrelationMatrixDataset.test.ts`가 유닛
  // 레벨에서 세 상한 전부를 정밀하게 검증한다.
  it('§8 — 변수당 값 개수 상한 초과 시 /preview에서도 pair 순회 전에 400 INPUT_TOO_LARGE(VALUES_PER_VARIABLE_EXCEEDED)로 거부된다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, manyDistinctPersons(120_000));
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(CORRELATION_MATRIX_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INPUT_TOO_LARGE');
    expect(res.body.reason).toBe('VALUES_PER_VARIABLE_EXCEEDED');
    expect(runCorrelationMatrixStatsEngine).not.toHaveBeenCalled();
  }, 20000);
});

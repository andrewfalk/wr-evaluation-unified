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
// PR3-B — 상관행렬 HTTP 라우트 wiring 테스트용.
const runCorrelationMatrixStatsEngine = vi.fn();
vi.mock('../../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../statsEngine')>();
  return {
    ...actual,
    runStatsEngine: (...args: unknown[]) => runStatsEngine(...args),
    runCorrelationMatrixStatsEngine: (...args: unknown[]) => runCorrelationMatrixStatsEngine(...args),
  };
});

import { createStatsRouter } from '../stats';
import { generateAccessToken } from '../../auth/tokens';
import { __resetDifferencingGuardForTests, computeQueryFamilyDigest } from '../../statsDifferencingGuard';
import { __resetInFlightForTests } from '../../statsAnalyzeInFlight';
import { StatsAnalysisRecipeSchema } from '@wr/contracts';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';

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
  // grain 단순화(PR0-B4 개정, person grain 삭제 후속) — case/job/disease 3개 전부
  // 지원한다(unsupportedGrains는 빈 배열). analytics-core 카탈로그 개수를 직접
  // import해서 대조한다(매 슬라이스 하드코딩 갱신 방지 — analytics-core 쪽 정확한
  // 개수는 coverage/pr0B4FieldMapping.ts fixture가 이미 고정한다).
  it('200 + 정확한 변수 개수, case+job+disease 전부 지원, 감사 로그를 남기지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool)).get('/api/stats/catalog').set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.variables).toHaveLength(getFullVariableCatalog().length + 2);
    expect(res.body.supportedGrains).toEqual(['case', 'job', 'disease']);
    expect(res.body.unsupportedGrains).toHaveLength(0);
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
  // person grain 삭제 후속 — 'person'은 이제 StatsAnalysisRecipeSchema의 zod enum
  // 자체에 없으므로, validateRecipe(SUPPORTED_GRAINS 로직)에 도달하기도 전에 zod
  // parse 단계에서 먼저 거부된다(statsAnalysisContext.ts:72, code: 'INVALID_RECIPE').
  // 단순 삭제 대신 이 실제 거부 경로를 HTTP 레벨로 확인한다(리뷰 권장 지적).
  it('grain=person은 이제 유효한 스키마 값이 아니라 400 INVALID_RECIPE로 거부되고 DB에 접근하지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ ...BASE_BODY, grain: 'person' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RECIPE');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

// PR0-B3 Part B(PR0-B4 개정 — diagnosis_side→disease rename) — disease grain end-to-end.
// side==='both' explode가 이 grain 특유의 모집단 규칙이라는 점이 핵심 확인 대상이다.
describe('POST /preview — disease grain(PR0-B3 Part B, PR0-B4 rename)', () => {
  function diseaseCaseRow(id: string, personId: string, side: 'right' | 'both') {
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

  it('grain=disease를 GRAIN_NOT_YET_SUPPORTED 없이 처리하고, side===both인 case는 행 2개를 낸다(§2.2, 상병×측 단위)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    // 11개 case는 side=right(행 1개), 1개 case는 side=both(행 2개) — caseCount=12,
    // observationCount=13, personCount=12(각 case가 다른 person).
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => diseaseCaseRow(`case-${i}`, `person-${i}`, 'right')),
      diseaseCaseRow('case-11', 'person-11', 'both'),
    ];
    wireSnapshot(pool, rows);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'disease',
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

  it('grain과 변수의 grain이 다르고 브로드캐스트 대상도 아니면(quasi_identifier 변수를 disease grain에) VARIABLE_GRAIN_MISMATCH 400', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'disease',
        variableKeys: ['job.rollup.longestTenureJobNameNormalized'], // case grain, quasi_identifier — 브로드캐스트 제외
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { code: string }) => e.code === 'VARIABLE_GRAIN_MISMATCH')).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  // PR4-B1 — admission 도입으로 이 테스트의 pool.query mock 시퀀스가 더 이상 실제
  // 흐름을 재현하지 못해 깨졌다. 실제 Postgres+Python으로 disease grain analyze가
  // 끝까지 처리되는지는 statsDescriptiveHttp.integration.test.ts로 옮겨 다시 증명한다.
});

// PR0-B3 Part C — job grain end-to-end. disease(Part B) 블록과 대칭 구조 — job은 어떤
// 모듈에도 속하지 않는 공유 필드(shared.jobs[])라 activeModules 게이트가 없다는 점이 다르다.
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

  it('grain과 변수의 grain이 다르고 브로드캐스트 대상도 아니면(quasi_identifier 변수를 job grain에) VARIABLE_GRAIN_MISMATCH 400', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['job.rollup.longestTenureJobNameNormalized'], // case grain, quasi_identifier — 브로드캐스트 제외
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(400);
    expect(res.body.errors.some((e: { code: string }) => e.code === 'VARIABLE_GRAIN_MISMATCH')).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('브로드캐스트 안전 case 변수(knee.relatedness.max)는 job grain에서도 허용된다(공통변수 브로드캐스트)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, Array.from({ length: 12 }, (_, i) => jobCaseRow(`case-${i}`, `person-${i}`, 1)));
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['knee.relatedness.max'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(false);
  });

  // PR4-B1 — 위 disease grain과 동일한 이유로 깨져 statsDescriptiveHttp.integration.test.ts로 옮김.
});

// 리뷰 지적 — statsDatasetBuilder.broadcast.test.ts의 단위테스트는 엔진에 들어가는 값
// 배열과 personCount 숫자까지만 확인했지, 실제 /analyze 응답(suppressed·억제된 레벨)과
// 이변량 REPEATED_MEASURES_NOT_ALIGNED까지는 실제 파이프라인으로 검증하지 않았다.
// 여기서는 실제 HTTP 라우트 + 실제 프로덕션 코드(buildAnalysisContext→buildDataset→
// computeAvailableMethods/computeDescriptiveSuppression)로 그 지적을 메운다 — 이 파일의
// 기존 관례대로 DB(snapshot)와 Python subprocess(runStatsEngine)만 mock한다.
describe('POST /preview·POST /analyze — 공통변수 브로드캐스트 통합 검증(계획 §5 Tier-3 등가 fixture)', () => {
  const WELD_JOB = { id: 'job-1', jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01' };

  function genderedJobCaseRow(id: string, personId: string, gender: 'male' | 'female', jobCount: number) {
    return {
      id,
      patient_person_id: personId,
      assigned_doctor_user_id: null,
      created_at: new Date('2024-01-01T00:00:00.000Z'),
      payload: {
        data: {
          shared: {
            gender,
            jobs: Array.from({ length: jobCount }, (_, i) => ({ ...WELD_JOB, id: `${id}-job-${i}` })),
          },
          modules: {},
          activeModules: [],
        },
      },
    };
  }

  it('남성 10명(job 3개씩)·여성 10명(job 1개씩) — /preview counts가 personCount=20/caseCount=20/observationCount=40, 억제 없음', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => genderedJobCaseRow(`male-case-${i}`, `male-person-${i}`, 'male', 3)),
      ...Array.from({ length: 10 }, (_, i) => genderedJobCaseRow(`female-case-${i}`, `female-person-${i}`, 'female', 1)),
    ];
    wireSnapshot(pool, rows);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['patient.identity.gender'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ suppressed: false, personCount: 20, caseCount: 20, observationCount: 40 });
  });

  // PR4-B1 — admission 도입으로 이 테스트의 pool.query mock 시퀀스(BEGIN→DELETE→INSERT
  // RETURNING→COMMIT 단일 트랜잭션 흉내)가 더 이상 실제 흐름과 맞지 않아 깨졌다. 실제
  // Postgres+Python으로 브로드캐스트 analyze가 30:10 결과를 내는지는
  // statsDescriptiveHttp.integration.test.ts로 옮겨 다시 증명한다.

  it('대조군 — 1명이 job 20개를 가지면 observationCount=20이어도 personCount=1이라 /preview 전체가 MIN_COHORT_NOT_MET으로 억제된다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireSnapshot(pool, [genderedJobCaseRow('solo-case', 'solo-person', 'male', 20)]);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['patient.identity.gender'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
      });
    expect(res.status).toBe(200);
    expect(res.body.counts.suppressed).toBe(true);
    expect(res.body.counts.reasonCode).toBe('MIN_COHORT_NOT_MET');
    expect(res.body.counts.personCount).toBeNull();
  });

  it('브로드캐스트로 personCount≠observationCount가 되면(job 3개인 사람들 섞임) 이변량 추론 검정이 REPEATED_MEASURES_NOT_ALIGNED로 차단된다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => genderedJobCaseRow(`male-case-${i}`, `male-person-${i}`, 'male', 3)),
      ...Array.from({ length: 10 }, (_, i) => genderedJobCaseRow(`female-case-${i}`, `female-person-${i}`, 'female', 1)),
    ];
    wireSnapshot(pool, rows);
    const res = await request(makeApp(pool))
      .post('/api/stats/preview')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({
        grain: 'job',
        variableKeys: ['patient.identity.gender', 'job.identity.tenureYears'],
        filters: [],
        analysisPurpose: 'association',
        formulaPolicies: {},
        analysisMode: 'bivariate',
      });
    expect(res.status).toBe(200);
    expect(res.body.counts.personCount).toBe(20);
    expect(res.body.counts.observationCount).toBe(40);
    expect(res.body.availableMethods.length).toBeGreaterThan(0);
    for (const method of res.body.availableMethods) {
      if (method.status === 'available') continue;
      expect(['REPEATED_MEASURES_NOT_ALIGNED', 'PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING']).toContain(method.reasonCode);
    }
    expect(res.body.availableMethods.some((m: { reasonCode: string }) => m.reasonCode === 'REPEATED_MEASURES_NOT_ALIGNED')).toBe(true);
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
//
// PR4-B1 — 이 구간에 있던 FAKE_RAW_ENGINE_RESULT/FAKE_ANALYZE_RESULT/fakeManifest/
// wireAnalyzeCacheMissSuccess/wireAnalyzeCacheHit/wireHasLimitedRowAccess/
// wireNoLimitedRowAccess/wireAuditOnlyWriteTransaction은 전부 admission 도입 전
// "단일 트랜잭션" 응답 흐름을 흉내내던 헬퍼였다 — 그 헬퍼를 쓰던 테스트가 모두
// statsDescriptiveHttp.integration.test.ts 등 실제 Postgres+Python 통합테스트로
// 옮겨가면서 이 파일 안에서는 더 이상 쓰는 곳이 없어져 삭제했다.
// ---------------------------------------------------------------------------
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
  // PR4-B1 — 이 describe의 "생성자(캐시 miss)/DB 캐시 hit/Python TimeoutError/8차 검토
  // 원시 에러 메시지 스크러빙" 4개 테스트는 admission(§A) 도입으로 pool.query 순서가
  // 완전히 바뀌어(advisory lock×2+캐시확인+합류확인+quota확인+INSERT가 admission
  // 트랜잭션, 상태전이+감사는 워커의 finishRun 트랜잭션으로 분리) mock 시퀀스를 더
  // 이상 재현할 수 없다. 그 관찰가능한 동작은 여전히 유효하므로 실제 Postgres+실제
  // Python+실제 워커로 statsDescriptiveHttp.integration.test.ts에서 다시 증명한다.
  //
  // "ENGINE_BUSY — stats_runs 행을 만들지 않고 denied 감사만 남긴다(429)" 테스트는
  // 전제 자체가 사라졌다 — 새 아키텍처에서 엔진 BUSY는 워커 내부에서 attempt()가
  // requeueOrFinish로 조용히 재큐잉할 뿐 클라이언트에 429로 노출되지 않는다(admission의
  // 429는 이제 USER/ORG_CONCURRENCY_LIMIT·HOURLY_LIMIT뿐이고 엔진 슬롯 자체와는 무관).
  // 그 재큐잉 보장은 statsRunsQueue.integration.test.ts의 requeueOrFinish 테스트가
  // 대신 증명한다.
  //
  // "감사 INSERT가 실패하면 같은 트랜잭션의 stats_runs INSERT도 롤백되고 500을
  // 반환한다" 테스트도 구현 위치가 옮겨갔다 — 그 원자성은 이제 finishRun의
  // writeTerminalOutcome(상태전이+감사를 한 트랜잭션)이 담당하며,
  // statsRunsQueue.integration.test.ts의 "감사 INSERT가 실패하면 같은 트랜잭션의 상태
  // UPDATE도 롤백된다" 테스트가 실제 Postgres로 이를 증명한다.

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
});

// PR4-B1 — 아래 세 describe 블록("limited_row 필드 응답시점 merge", "in-flight 합류자의
// 독립적인 hasCapability 재확인", "scatter 원시 points 응답시점 merge")은 admission
// 도입으로 pool.query/pool.connect mock 시퀀스가 더 이상 실제 흐름을 재현하지 못해
// 전부 깨졌다. 관찰가능한 동작(hasAccess:true일 때 boxplot.outlierValues·
// bivariate.scatter.points가 붙는지, 권한 부여/회수가 캐시와 무관하게 매 요청
// 반영되는지, §9 신규 감사 실패 시 500)은 statsDescriptiveHttp.integration.test.ts와
// statsBivariateHttp.integration.test.ts로 옮겨 실제 Postgres+Python으로 다시
// 증명한다. "in-flight 합류자(같은 사용자의 동시 중복 요청)마다 hasCapability가
// 독립적으로 재확인되는지"는 실제 admission 타이밍(두 요청이 정확히 캐시확인~합류확인
// 사이에 겹쳐야 함)을 인위적 지연 없이 재현하기 어려워 남은 갭으로 명시한다 —
// admission의 join 분기 자체(§A)는 statsRunAdmission.ts 코드 구조상 join된 요청도
// 각자 별도로 finalizeAnalyzeResponse를 호출하므로 hasCapability 재확인이 공유되지
// 않는다는 것은 구조적으로 보장되지만, 이 시나리오의 HTTP 레벨 실측 증명은 아직 없다.

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
  // PR4-B1 — "정상 경로 200 + cells 3개"·"요청 단위 억제면 cells 전부 suppressed"
  // 두 테스트는 admission 도입으로 pool.query mock 시퀀스가 깨져
  // statsCorrelationMatrixHttp.integration.test.ts로 옮겨 실제 Postgres+Python으로
  // 다시 증명한다(이 둘은 계산 경로를 실제로 타므로 admission 영향을 받지만, 아래
  // METHOD_NOT_AVAILABLE·변수개수 부족·입력상한 3개는 admission 이전에 거부되는
  // 400 경로라 영향이 없어 그대로 남겨둔다).
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

// PR3-A 계획서(pr3-swift-waterfall.md) §검증 계획 "실데이터 HTTP 통합테스트" —
// 코드리뷰(2026-09-12)가 지적한 잔여 갭: 지금까지 이변량의 공개통제·카탈로그 로직은
// 전부 순수함수 단위테스트(statsBivariateDisclosureGate.test.ts 등)로만 검증됐고,
// 실제 Postgres에 저장된 실제 환자 payload → snapshot → dataset → POST /preview·
// /analyze라는 진짜 HTTP 경로는 한 번도 실행되지 않았다 — "공개통제 함수 자체의
// 검증"과 "실제 API 경로의 검증"은 다른 것이라는 지적을 그대로 반영한다.
//
// statsSnapshot.integration.test.ts/statsAnalyze.integration.test.ts와 동일한 패턴
// (TEST_DATABASE_URL 없으면 전체 skip, 자체 fixture 생성/정리)이지만, 이 파일은
// 추가로 실제 Express 라우터(createStatsRouter)를 supertest로 띄우고 실제 Python
// 서브프로세스(services/stats-engine/.venv, config.ts의 STATS_ENGINE_PYTHON 기본
// 경로 해석을 그대로 사용 — mock 없음)까지 전부 실행한다.
//
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/__tests__/statsBivariateHttp.integration.test.ts
//
// 실데이터 소스: packages/analytics-core/__tests__/modules/{knee,shoulder,elbow,wrist,spine}
// /extractors.test.ts가 이미 검증해 둔 "정상 계산에 도달하는" 최소 payload를 그대로
// 재사용한다(계산 로직 자체의 정확성은 그 테스트들과 Python 단위테스트가 이미 검증 —
// 여기서는 파이프라인 배선만 본다).
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createStatsRouter } from '../routes/stats';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-bivariate-csrf';

// ---------------------------------------------------------------------------
// 실데이터 payload 조각 — 각 extractors.test.ts의 baseCase/COMPLETE_ENTRY/
// lowRiskEntry를 그대로 옮김(§주석 위 참고). 변수명도 원본 그대로 유지해 대조하기
// 쉽게 했다.
// ---------------------------------------------------------------------------

// knee.relatedness.max(continuous) — packages/analytics-core/__tests__/modules/knee/
// extractors.test.ts "순서 7". age>30(birthDate 1980 + injuryDate 2020) + job 1건이면
// 정상 계산된다.
//
// calculatePhysicalBurden(derived.ts)은 weight/squatting을 4개의 이산 구간(경도/
// 중등도하/중등도상/고도)으로 분류하는 계단함수다 — 실측 디버깅(1000~1550 vs
// 3000~3550 범위로 그룹당 12명을 만들었더니 그룹 내부가 전부 같은 구간에 떨어져
// value가 그룹마다 상수(50/83.3)로 나와 CONSTANT_VARIABLE로 조용히 억제됐다)로
// 확인했다. 그룹 내부에도 분산이 있어야 하므로, 각 그룹 안에서 인접한 두 구간을
// 번갈아 쓴다(burdenBin으로 명시 선택 — 임의의 weight/squatting을 더 촘촘히
// 찍는 방식은 계단함수라 재현성이 낮다).
const KNEE_BURDEN_BINS = {
  low: [500, 10] as const,     // 경도(minScore1/maxScore2)
  lowMid: [500, 90] as const,  // 중등도하(2/4) — W<2000 && T>=60
  highMid: [3500, 90] as const, // 중등도상(3/6) — W>=3000 && T>=60(<120)
  high: [3500, 130] as const,  // 고도(6/9) — W>=3000 && T>=120
};
function kneeModule(bin: keyof typeof KNEE_BURDEN_BINS) {
  const [weight, squatting] = KNEE_BURDEN_BINS[bin];
  return { jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: String(weight), squatting: String(squatting) }], jobExtras: [] };
}

// shoulder.exposure.anyExceeded(boolean) — extractors.test.ts "순서 4". 5년(2015~2020)*
// 250일/년 * overheadHours > 3600 누적시간 한도면 true.
function shoulderModule(exceeded: boolean) {
  return { jobExtras: [{ sharedJobId: 'job-1', overheadHours: exceeded ? '3' : '0.1' }] };
}
const SHOULDER_JOB = { id: 'job-1', startDate: '2015-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };

// elbow.assessment.burdenGradeMax(ordinal) — extractors.test.ts COMPLETE_ENTRY(고도)/
// lowRiskEntry(부담 작업 아님). ELBOW_BURDEN_GRADE_ORDER의 양끝 2개 레벨만 실사용 —
// 중간 2개 레벨(경도/중등도)은 riskFactorCount 임계값을 정확히 맞추는 손계산이 필요해
// 이 통합테스트 범위에서는 제외한다(순수 pipeline 배선 검증이 목적이라 2레벨로도
// ordinal 타입 처리 자체는 충분히 검증됨 — 4레벨 전부는 fixture 단위테스트
// statsMethodCatalog.test.ts가 이미 커버).
const ELBOW_COMPLETE_ENTRY = {
  diagnosisId: 'dx-elbow', selectedBkType: 'BK2101', bkSelectionMode: 'manual',
  direct_anatomic_link: 'yes', exposure_types: ['repetition'], main_task_name: '문제 작업',
  repetition_level: 'frequent', daily_exposure_hours: '4', shift_share_percent: '50',
  days_per_week: '5', work_pattern: 'continuous', rest_distribution: 'insufficient',
  bk2101_cycle_seconds: '0.3', bk2101_monotony: 'yes', static_holding_level: 'frequent',
  bk2101_forced_dorsal_extension: 'yes', bk2101_prosupination: 'no',
};
const ELBOW_LOW_RISK_ENTRY = {
  diagnosisId: 'dx-elbow', selectedBkType: 'BK2105', bkSelectionMode: 'manual',
  main_task_name: '문제 작업', direct_anatomic_link: 'yes', exposure_types: ['repetition'],
  repetition_level: 'occasional', daily_exposure_hours: '0.1', shift_share_percent: '1',
  days_per_week: '1', work_pattern: 'intermittent', rest_distribution: 'adequate',
  direct_pressure_level: 'none', bk2105_elbow_leaning: 'no',
};
function elbowModule(highBurden: boolean) {
  return {
    jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [highBurden ? ELBOW_COMPLETE_ENTRY : ELBOW_LOW_RISK_ENTRY] }],
    temporalSequence: { recent_task_change: 'none', improves_with_rest: highBurden ? 'no' : 'yes' },
  };
}

// wrist.assessment.burdenGradeMax(ordinal) — extractors.test.ts와 동일 패턴, 별도
// diagnosisId(dx-wrist)로 elbow와 한 patient 안에 공존시킨다.
const WRIST_COMPLETE_ENTRY = {
  diagnosisId: 'dx-wrist', selectedBkType: 'BK2101', bkSelectionMode: 'manual',
  direct_anatomic_link: 'yes', exposure_types: ['repetition'], main_task_name: '문제 작업',
  repetition_level: 'frequent', daily_exposure_hours: '4', shift_share_percent: '50',
  days_per_week: '5', work_pattern: 'continuous', rest_distribution: 'insufficient',
  bk2101_cycle_seconds: '0.3', bk2101_monotony: 'yes', static_holding_level: 'frequent',
  bk2101_forced_dorsal_extension: 'yes', bk2101_prosupination: 'no',
};
const WRIST_LOW_RISK_ENTRY = {
  diagnosisId: 'dx-wrist', selectedBkType: 'BK2106', bkSelectionMode: 'manual',
  main_task_name: '문제 작업', direct_anatomic_link: 'yes', exposure_types: ['repetition'],
  repetition_level: 'occasional', daily_exposure_hours: '0.1', shift_share_percent: '1',
  days_per_week: '1', work_pattern: 'intermittent', rest_distribution: 'adequate',
  direct_pressure_level: 'none', static_holding_level: 'occasional',
};
function wristModule(highBurden: boolean) {
  return {
    jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [highBurden ? WRIST_COMPLETE_ENTRY : WRIST_LOW_RISK_ENTRY] }],
    temporalSequence: { recent_task_change: 'none', improves_with_rest: highBurden ? 'no' : 'yes' },
  };
}

// spine.mddm.lifetimeDoseMNh(continuous) — extractors.test.ts "순서 4"(HEAVY_TASK).
// weight를 달리해 그룹 내부 분산을 만든다.
function spineModule(taskWeight: number) {
  return {
    mddmStatus: 'present', formulaVersion: 'v5.1.3',
    tasks: [{ sharedJobId: 'job-1', name: '중량물 취급', posture: 'G3', weight: taskWeight, frequency: 80, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.0 }],
  };
}

describe.skipIf(!TEST_DB_URL)('이변량 분석 — 실데이터 HTTP 통합(POST /preview, POST /analyze)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;
  let accessToken: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_bivariateHttp_org__'],
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_bivariateHttp_user_${Date.now()}__`, 'x', 'Test Doctor', orgId],
    );
    userId = user.rows[0].id;

    // 로그인 플로를 거치지 않고 auth 미들웨어가 요구하는 정확한 형태로 세션 행을
    // 직접 만든다(§middleware/auth.ts: sessions JOIN users, invalidated_at IS NULL,
    // expires_at > now()) — routes/__tests__/stats.test.ts는 이 부분을 mock했지만
        // 여기선 실제 DB 왕복을 검증해야 하므로 진짜 행을 넣는다.
    const sessionId = crypto.randomUUID();
    const csrfHash = hashToken(CSRF_TOKEN);
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, family_id)
       VALUES ($1,$2,$3,$4, now() + interval '1 day', $5)`,
      [sessionId, userId, hashToken(generateToken()), csrfHash, crypto.randomUUID()],
    );
    accessToken = generateAccessToken({
      sub: userId, sessionId, orgId, role: 'doctor', name: 'Test Doctor',
      mustChangePassword: false, csrfHash,
    }).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  // 각 it()이 자기만의 환자 집합을 쓴다고 가정하고 personCount를 정확한 값으로
  // 단언한다 — 이전 케이스의 환자가 남아 있으면 이후 케이스의 personCount가 누적
  // 오염된다(실제로 4번째 케이스에서 111명으로 잡혔던 원인).
  afterEach(async () => {
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use(cookieParser());
    // 실제 pool + 실제 config(STATS_ENGINE_PYTHON은 mock하지 않음 — config.ts의
    // 기본 경로 해석이 cwd(server/)+../services/stats-engine/.venv를 그대로 찾는다).
    a.use('/api/stats', createStatsRouter(pool));
    return a;
  }

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${accessToken}`).set('X-CSRF-Token', CSRF_TOKEN);
  }

  async function insertPatient(payload: unknown, personName: string): Promise<void> {
    const person = await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1,$2) RETURNING id`,
      [orgId, personName],
    );
    await pool.query(
      `INSERT INTO patient_records (organization_id, owner_user_id, patient_person_id, name, revision, payload)
       VALUES ($1,$2,$3,$4,1,$5)`,
      [orgId, userId, person.rows[0].id, personName, payload],
    );
  }

  async function insertGroup(
    label: string,
    n: number,
    buildPayload: (i: number) => unknown,
  ): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await insertPatient(buildPayload(i), `${label}-${i}-${crypto.randomUUID()}`);
    }
  }

  const RECIPE_BASE = { grain: 'case' as const, filters: [], analysisPurpose: 'association' as const };

  it('boolean(shoulder.exposure.anyExceeded) × continuous(knee.relatedness.max) — welch_t', async () => {
    await insertGroup('shoulder-false', 12, (i) => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(false), knee: kneeModule(i % 2 === 0 ? 'low' : 'lowMid') },
        activeModules: ['shoulder', 'knee'],
      },
    }));
    await insertGroup('shoulder-true', 12, (i) => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(true), knee: kneeModule(i % 2 === 0 ? 'highMid' : 'high') },
        activeModules: ['shoulder', 'knee'],
      },
    }));

    const variableKeys = ['shoulder.exposure.anyExceeded', 'knee.relatedness.max'];
    const formulaPolicies = { 'shoulder.exposure.anyExceeded': 'recompute_current', 'knee.relatedness.max': 'recompute_current' };

    const preview = await authed(request(app()).post('/api/stats/preview')).send({
      ...RECIPE_BASE, variableKeys, formulaPolicies, analysisMode: 'bivariate',
    });
    expect(preview.status).toBe(200);
    expect(preview.body.counts.suppressed).toBe(false);
    expect(preview.body.counts.personCount).toBe(24);
    const welchEntry = preview.body.availableMethods.find((m: { id: string }) => m.id === 'welch_t');
    expect(welchEntry).toMatchObject({ status: 'available', reasonCode: null });

    const analyze = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys, formulaPolicies, analysisMode: 'bivariate', requestedMethod: 'welch_t',
    });
    expect(analyze.status).toBe(200);
    const bivariate = analyze.body.result.bivariate;
    expect(bivariate.suppressed).toBe(false);
    expect(bivariate.method).toBe('welch_t');
    expect(bivariate.n).toBe(24);
    expect(Number.isFinite(bivariate.statistic)).toBe(true);
    expect(bivariate.pValue).toBeGreaterThanOrEqual(0);
    expect(bivariate.pValue).toBeLessThanOrEqual(1);
    expect(bivariate.groupBreakdown).toEqual([
      { label: false, n: 12 },
      { label: true, n: 12 },
    ]);
    // true 그룹(무릎 weight/squatting이 훨씬 큼)이 relatedness가 더 높아야 하므로
    // "뒤(true)-앞(false)" 평균차는 양수여야 한다 — 방향규칙(§방향규칙) 실측 확인.
    const meanDiff = bivariate.effectSizes.find((es: { name: string }) => es.name === 'mean_difference');
    expect(meanDiff.value).toBeGreaterThan(0);
  }, 30000);

  it('ordinal(elbow.assessment.burdenGradeMax) × continuous(knee.relatedness.max) — welch_t', async () => {
    const sharedJobsAndDx = { jobs: [{ id: 'job-1', jobName: '조립공' }], diagnoses: [{ id: 'dx-elbow', code: 'M770', moduleId: 'elbow', side: 'right' }] };
    await insertGroup('elbow-low', 11, (i) => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', ...sharedJobsAndDx },
        modules: { elbow: elbowModule(false), knee: kneeModule(i % 2 === 0 ? 'low' : 'lowMid') },
        activeModules: ['elbow', 'knee'],
      },
    }));
    await insertGroup('elbow-high', 11, (i) => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', ...sharedJobsAndDx },
        modules: { elbow: elbowModule(true), knee: kneeModule(i % 2 === 0 ? 'highMid' : 'high') },
        activeModules: ['elbow', 'knee'],
      },
    }));

    const variableKeys = ['elbow.assessment.burdenGradeMax', 'knee.relatedness.max'];
    const formulaPolicies = { 'elbow.assessment.burdenGradeMax': 'recompute_current', 'knee.relatedness.max': 'recompute_current' };

    const analyze = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys, formulaPolicies, analysisMode: 'bivariate', requestedMethod: 'welch_t',
    });
    expect(analyze.status).toBe(200);
    const bivariate = analyze.body.result.bivariate;
    expect(bivariate.suppressed).toBe(false);
    expect(bivariate.n).toBe(22);
    // 카탈로그 고정 순서(ELBOW_BURDEN_GRADE_ORDER)를 따라 "부담 작업 아님"이 앞,
    // "고도"가 뒤여야 한다(관측 안 된 중간 레벨은 응답에 아예 등장하지 않음).
    expect(bivariate.groupBreakdown).toEqual([
      { label: '부담 작업 아님', n: 11 },
      { label: '고도', n: 11 },
    ]);
  }, 30000);

  it('continuous(knee.relatedness.max) × continuous(spine.mddm.lifetimeDoseMNh) — pearson_correlation', async () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }];
    // knee는 계단함수(위 KNEE_BURDEN_BINS 주석 참고)라 i가 커질수록 구간도 단조증가하게
    // 묶어(low→lowMid→highMid→high) spine(연속값, i*3 증가)과 대략 같은 방향으로 움직이게
    // 한다 — 정확한 상관계수 값 자체는 이미 Python 단위테스트(test_bivariate.py)가 검증
    // 했으므로, 여기서는 "0이 아닌 유한한 r이 파이프라인을 통과하는지"만 본다.
    // spine 쪽은 weight가 낮으면(실측 디버깅으로 확인: weight<31) 압박력이 excluded
    // 임계치 미달로 lifetimeDose 자체가 not_entered가 돼 그 행이 통째로 빠진다 — 시작값을
    // 35로 올려 16명 전원이 정상 계산 경로를 타게 한다.
    const KNEE_BIN_ORDER = ['low', 'lowMid', 'highMid', 'high'] as const;
    await insertGroup('knee-spine', 16, (i) => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', gender: 'male', jobs, diagnoses: [] },
        modules: { knee: kneeModule(KNEE_BIN_ORDER[Math.min(3, Math.floor(i / 4))]), spine: spineModule(35 + i * 3) },
        activeModules: ['knee', 'spine'],
      },
    }));

    const variableKeys = ['knee.relatedness.max', 'spine.mddm.lifetimeDoseMNh'];
    // formulaPolicies는 변수 키가 아니라 formula family로 키를 건다(statsRecipeValidation
    // 에러 메시지로 확인) — spine_mddm은 정책이 2개(recompute_recorded_version/
    // recompute_current)라 명시가 필수, knee_relatedness는 정책이 1개뿐이라 생략 가능.
    const formulaPolicies = { spine_mddm: 'recompute_current' };

    const analyze = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys, formulaPolicies, analysisMode: 'bivariate', requestedMethod: 'pearson_correlation',
    });
    expect(analyze.status).toBe(200);
    const bivariate = analyze.body.result.bivariate;
    expect(bivariate.suppressed).toBe(false);
    expect(bivariate.method).toBe('pearson_correlation');
    expect(bivariate.n).toBe(16);
    const r = bivariate.effectSizes[0];
    expect(r.name).toBe('pearson_r');
    expect(r.value).toBeGreaterThanOrEqual(-1);
    expect(r.value).toBeLessThanOrEqual(1);
    expect(Number.isFinite(bivariate.pValue)).toBe(true);
  }, 30000);

  it('ordinal(elbow) × ordinal(wrist) 2×2 — chi_square, 분할표 각 셀 ≥10이면 실제 cell 수치까지 공개', async () => {
    const sharedJobsAndDx = {
      jobs: [{ id: 'job-1', jobName: '조립공' }],
      diagnoses: [
        { id: 'dx-elbow', code: 'M770', moduleId: 'elbow', side: 'right' },
        { id: 'dx-wrist', code: 'M65.3', moduleId: 'wrist', side: 'right' },
      ],
    };
    function buildPayload(elbowHigh: boolean, wristHigh: boolean) {
      return {
        data: {
          shared: sharedJobsAndDx,
          modules: { elbow: elbowModule(elbowHigh), wrist: wristModule(wristHigh) },
          activeModules: ['elbow', 'wrist'],
        },
      };
    }
    // [부담 작업 아님×부담 작업 아님, 부담 작업 아님×고도, 고도×부담 작업 아님, 고도×고도]
    // 전부 ≥10으로 채워 A-2/B 둘 다 클린 브레이크다운을 통과하게 한다(계획서 §검증계획
    // "그룹비교는 각 그룹, 분할표는 각 양수 셀이 전부 0 또는 ≥10인 조합").
    await insertGroup('ee-ll', 15, () => buildPayload(false, false));
    await insertGroup('ee-lh', 10, () => buildPayload(false, true));
    await insertGroup('ee-hl', 10, () => buildPayload(true, false));
    await insertGroup('ee-hh', 15, () => buildPayload(true, true));

    const variableKeys = ['elbow.assessment.burdenGradeMax', 'wrist.assessment.burdenGradeMax'];
    const formulaPolicies = { 'elbow.assessment.burdenGradeMax': 'recompute_current', 'wrist.assessment.burdenGradeMax': 'recompute_current' };

    const preview = await authed(request(app()).post('/api/stats/preview')).send({
      ...RECIPE_BASE, variableKeys, formulaPolicies, analysisMode: 'bivariate',
    });
    expect(preview.status).toBe(200);
    expect(preview.body.counts.personCount).toBe(50);
    const chiSquareEntry = preview.body.availableMethods.find((m: { id: string }) => m.id === 'chi_square');
    expect(chiSquareEntry).toMatchObject({ status: 'available', reasonCode: null });

    const analyze = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys, formulaPolicies, analysisMode: 'bivariate', requestedMethod: 'chi_square',
    });
    expect(analyze.status).toBe(200);
    const bivariate = analyze.body.result.bivariate;
    expect(bivariate.suppressed).toBe(false);
    expect(bivariate.n).toBe(50);
    // x=elbow(행)/y=wrist(열) — 계획서 §방향규칙 "분할표는 x=행/y=열" 그대로.
    expect(bivariate.contingencyTable).toEqual({
      rowLabels: ['부담 작업 아님', '고도'],
      colLabels: ['부담 작업 아님', '고도'],
      cells: [
        [15, 10],
        [10, 15],
      ],
    });
    expect(Number.isFinite(bivariate.statistic)).toBe(true);
    expect(bivariate.qualityFlags).not.toContain('low_expected_count');
  }, 30000);
});

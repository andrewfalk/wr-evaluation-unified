// PR4-A1 계획서(pr4-a-lexical-reddy.md) §검증 "HTTP 통합(실 Postgres + 실 Python)" —
// statsBivariateHttp.integration.test.ts와 동일한 패턴(TEST_DATABASE_URL 없으면
// 전체 skip, 자체 fixture 생성/정리)으로 실제 Express 라우터를 supertest로 띄우고
// 실제 Python 서브프로세스(mock 없음)까지 전부 실행한다. case grain(personCount
// ===rowCount, HC3 경로)의 OLS·이분 로지스틱 배선만 검증한다 — HC3/CR1 계산 자체의
// 통계적 정확성은 test_regression.py의 R 대조가 이미 증명했고, 클러스터 게이트
// 우선순위는 statsRegressionSuppression.test.ts가 mock으로 이미 검증했다. 여기서는
// "preview→analyze가 실제 DB·실제 Python 경계를 넘어 끝까지 도는지"만 본다.
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// 통계 워크벤치는 인트라넷 배포에서만 열린다(statsWorkbenchRuntimeState.ts) — 이 게이트가
// 꺼져 있으면 requireCapability가 유효한 토큰이 있어도 "기능 자체가 없는 것처럼" 403이
// 아니라 404를 반환한다(의도된 동작, §7.6). 이 게이트는 DEPLOYMENT_MODE=intranet +
// STATS_WORKBENCH_ENABLED=true를 요구하고, intranet 모드는 다시 CORS_ORIGINS 등을
// 요구하는 연쇄가 있다 — 이 테스트는 실 Postgres·실 Python 경계만 검증하면 충분하고
// 배포모드 게이트 자체를 검증하는 게 목적이 아니므로, 그 연쇄를 통째로 우회한다.
// (재현된 사고: 이 mock 없이 TEST_DATABASE_URL만 주고 돌리면 preview/analyze가 전부
// "이유를 알 수 없는 404"로 실패해, 이 테스트가 실제로 한 번도 CI/로컬에서 끝까지
// 실행된 적이 없었다 — 원인 불명 상태로 계속 skip돼 온 근본 원인이었다.)
vi.mock('../statsWorkbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: true, reason: null, checkedAt: null }),
  setStatsWorkbenchHealthy: () => {},
}));

import { createStatsRouter } from '../routes/stats';
import { createStatsRunsQueueWorker } from '../statsRunsQueue';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';
// PR4-A2(3차 리뷰 지적) — 표준화 테스트가 "평균·SD가 유한값"만 보면 변환 자체가
// 빠져도 통과한다. 실제 분석 코드(패키지가 서버·클라이언트와 공유하는 함수)로
// fixture의 기대 평균·SD를 독립 재계산해 서버 응답과 대조한다(하드코딩 매직넘버가
// 아니라 실 formula).
import { computeKneeCalc } from '@wr/analytics-core/modules/knee/index';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-regression-csrf';

// buildRegressionCsv(statsExportHandler.ts)가 만드는 "# section,<name>" 블록 하나를
// 헤더 행 기준으로 파싱한다 — CSV 문자열에 값이 "포함"되는지가 아니라 실제 셀 값을
// 검증하기 위함(리뷰 지적 — toContain만으로는 우연한 부분 문자열 일치를 못 걸러낸다).
function extractCsvSection(csv: string, sectionName: string): Array<Record<string, string>> | null {
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  const startIdx = lines.findIndex((l) => l === `# section,${sectionName}`);
  if (startIdx === -1) return null;
  const header = lines[startIdx + 1].split(',');
  const rows: Array<Record<string, string>> = [];
  for (let i = startIdx + 2; i < lines.length; i += 1) {
    if (lines[i] === '' || lines[i].startsWith('#')) break;
    const cells = lines[i].split(',');
    rows.push(Object.fromEntries(header.map((h, j) => [h, cells[j]])));
  }
  return rows;
}

// knee.relatedness.max(continuous) — packages/analytics-core/__tests__/modules/knee/
// extractors.test.ts와 동일한 burden bin 선택(statsBivariateHttp.integration.test.ts와
// 동일한 기법 — 계단함수라 그룹 내부에도 분산이 있어야 CONSTANT_VARIABLE로 억제되지
// 않는다).
const KNEE_BURDEN_BINS = {
  low: [500, 10] as const,
  lowMid: [500, 90] as const,
  highMid: [3500, 90] as const,
  high: [3500, 130] as const,
};
function kneeModule(bin: keyof typeof KNEE_BURDEN_BINS) {
  const [weight, squatting] = KNEE_BURDEN_BINS[bin];
  return { jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: String(weight), squatting: String(squatting) }], jobExtras: [] };
}

// shoulder.exposure.anyExceeded(boolean) — extractors.test.ts "순서 4".
function shoulderModule(exceeded: boolean) {
  return { jobExtras: [{ sharedJobId: 'job-1', overheadHours: exceeded ? '3' : '0.1' }] };
}
const SHOULDER_JOB = { id: 'job-1', startDate: '2015-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };

describe.skipIf(!TEST_DB_URL)('연관성 회귀 — 실데이터 HTTP 통합(POST /preview, POST /analyze)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;
  let accessToken: string;
  let worker: { stop: () => void };

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    // PR4-B1 — POST /analyze는 이제 admission이 항상 queued 행을 만들고, 실제로
    // claim→attempt→finishRun까지 이 백그라운드 워커가 돌아야 syncBudgetMs 안에
    // 200으로 끝난다(워커 없이는 매 요청이 202로만 떨어진다).
    worker = createStatsRunsQueueWorker(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_regressionHttp_org__'],
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_regressionHttp_user_${Date.now()}__`, 'x', 'Test Doctor', orgId],
    );
    userId = user.rows[0].id;

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
    worker.stop();
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM user_capability_grants WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  afterEach(async () => {
    // PR4-B1 — 각 it()이 admission으로 만든 queued/succeeded 행을 다음 케이스로
    // 넘기면 다음 요청의 in-flight/시간당 quota(§A)를 오염시킨다(허위 429).
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use(cookieParser());
    a.use('/api/stats', createStatsRouter(pool));
    return a;
  }

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${accessToken}`).set('X-CSRF-Token', CSRF_TOKEN);
  }

  // PR4-B1 코드리뷰(2026-09-24) — POST /analyze는 admission이 항상 관여하므로,
  // §C-1(limited_row 진단 재계산)이 같은 전역 엔진 세마포어를 잠깐 점유하는 동안
  // claimTick이 정확히 슬롯을 기다리면(§statsRunsQueue.ts의 isEngineSlotAvailable
  // 게이트) 이 파일처럼 실제 Python을 여러 번 왕복하는 무거운 fixture는 무부하가
  // 아닌 실행 환경(다른 테스트 파일과 함께 도는 CI 등)에서 syncBudgetMs(기본 4초)를
  // 넘겨 202로 떨어질 수 있다 — 계획서 §B-1이 이미 "무부하 조건 한정"이라고 명시한
  // 그대로다. 이 헬퍼는 200/202 둘 다 받아들이고, 202면 실제 GET /runs/:id 폴링으로
  // 종결까지 기다린 뒤 200 응답과 동일한 shape({status, body:{runManifest,result}})으로
  // 맞춰 돌려준다 — 기존 `analyze.status`/`analyze.body...` 단언을 그대로 재사용할 수
  // 있다(리뷰가 지적한 "202→GET 완료 흐름 coverage 부족"도 이 경로로 함께 메운다).
  async function postAnalyzeAndAwait(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const res = await authed(request(app()).post('/api/stats/analyze')).send(body);
    if (res.status !== 202) return res;
    const analysisRunId = res.body.analysisRunId;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const getRes = await authed(request(app()).get(`/api/stats/runs/${analysisRunId}`));
      if (getRes.body.status === 'succeeded') {
        return { status: 200, body: { runManifest: getRes.body.runManifest, result: getRes.body.result } };
      }
      if (getRes.body.status === 'failed' || getRes.body.status === 'cancelled') {
        return { status: getRes.status, body: getRes.body };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`postAnalyzeAndAwait: 202 폴링이 30초 안에 끝나지 않음(analysisRunId=${analysisRunId})`);
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

  async function insertGroup(label: string, n: number, buildPayload: (i: number) => unknown): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await insertPatient(buildPayload(i), `${label}-${i}-${crypto.randomUUID()}`);
    }
  }

  const RECIPE_BASE = { grain: 'case' as const, filters: [], analysisPurpose: 'association' as const };
  const OUTCOME_KEY = 'knee.relatedness.max';
  const PREDICTOR_KEY = 'shoulder.exposure.anyExceeded';
  const VARIABLE_KEYS = [OUTCOME_KEY, PREDICTOR_KEY];
  const FORMULA_POLICIES = { [OUTCOME_KEY]: 'recompute_current', [PREDICTOR_KEY]: 'recompute_current' };

  async function seedPatients(): Promise<void> {
    await insertGroup('shoulder-false', 20, (i) => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(false), knee: kneeModule(i % 2 === 0 ? 'low' : 'lowMid') },
        activeModules: ['shoulder', 'knee'],
      },
    }));
    await insertGroup('shoulder-true', 20, (i) => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(true), knee: kneeModule(i % 2 === 0 ? 'highMid' : 'high') },
        activeModules: ['shoulder', 'knee'],
      },
    }));
  }

  it('OLS — continuous outcome(knee.relatedness.max) ~ boolean predictor(shoulder.exposure.anyExceeded)', async () => {
    await seedPatients();

    const preview = await authed(request(app()).post('/api/stats/preview')).send({
      ...RECIPE_BASE, variableKeys: VARIABLE_KEYS, formulaPolicies: FORMULA_POLICIES,
      analysisMode: 'regression', regression: { outcomeKey: OUTCOME_KEY },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.counts.suppressed).toBe(false);
    expect(preview.body.counts.personCount).toBe(40);
    const olsEntry = preview.body.availableMethods.find((m: { id: string }) => m.id === 'ols_linear');
    expect(olsEntry).toMatchObject({ status: 'available', reasonCode: null });
    expect(preview.body.estimability.candidateParameterCount).toBe(2); // 절편 + boolean predictor 1열

    const analyze = await postAnalyzeAndAwait({
      ...RECIPE_BASE, variableKeys: VARIABLE_KEYS, formulaPolicies: FORMULA_POLICIES,
      analysisMode: 'regression', regression: { outcomeKey: OUTCOME_KEY }, requestedMethod: 'ols_linear',
    });
    expect(analyze.status).toBe(200);
    const regression = analyze.body.result.regression;
    expect(regression.suppressed).toBe(false);
    expect(regression.estimation).toBe('ok');
    expect(regression.method).toBe('ols_linear');
    expect(regression.covariance).toBe('hc3');
    expect(regression.n).toBe(40);
    expect(regression.personCount).toBe(40);
    expect(regression.clusterCount).toBeNull();
    expect(regression.terms).toHaveLength(2);
    const predictorTerm = regression.terms.find((t: { variableKey: string }) => t.variableKey === PREDICTOR_KEY);
    expect(predictorTerm).toBeDefined();
    expect(Number.isFinite(predictorTerm.estimate)).toBe(true);
    expect(Number.isFinite(predictorTerm.se)).toBe(true);
    expect(predictorTerm.se).toBeGreaterThan(0);
    expect(predictorTerm.pValue).toBeGreaterThanOrEqual(0);
    expect(predictorTerm.pValue).toBeLessThanOrEqual(1);
    // shoulder=true 그룹의 knee burden bin이 더 크므로(high/highMid vs low/lowMid)
    // predictor 계수는 양수여야 한다(실측 방향 확인).
    expect(predictorTerm.estimate).toBeGreaterThan(0);
    expect(regression.fit.r2).toBeGreaterThan(0);
  }, 30000);

  it('이분 로지스틱 — boolean outcome(shoulder.exposure.anyExceeded) ~ continuous predictor(knee.relatedness.max)', async () => {
    await seedPatients();
    // seedPatients()만으로는 shoulder=false가 항상 low/lowMid, shoulder=true가 항상
    // highMid/high 구간이라 knee burden(연속 predictor)로 outcome(shoulder)이 완전히
    // 갈린다 — 완전분리(로지스틱 MLE 미존재)가 정상적으로 SEPARATION_DETECTED를 낸다.
    // 이 자체는 §3 LP 분리판정이 올바르게 동작한다는 뜻이지만, 이 테스트의 목적은
    // "정상 추정 배선이 실제 Python까지 도는지"이므로 두 그룹의 knee burden 구간에
    // 실제 겹침을 만들어 분리를 깬다(전체 방향성은 유지 — shoulder=true 쪽이 여전히
    // 평균적으로 더 크다).
    await insertGroup('shoulder-false-overlap', 4, () => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(false), knee: kneeModule('highMid') },
        activeModules: ['shoulder', 'knee'],
      },
    }));
    await insertGroup('shoulder-true-overlap', 4, () => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(true), knee: kneeModule('lowMid') },
        activeModules: ['shoulder', 'knee'],
      },
    }));
    const variableKeys = [PREDICTOR_KEY, OUTCOME_KEY]; // outcome이 boolean이 되도록 뒤집음

    const analyze = await postAnalyzeAndAwait({
      ...RECIPE_BASE, variableKeys, formulaPolicies: FORMULA_POLICIES,
      analysisMode: 'regression', regression: { outcomeKey: PREDICTOR_KEY }, requestedMethod: 'binary_logistic',
    });
    expect(analyze.status).toBe(200);
    const regression = analyze.body.result.regression;
    expect(regression.suppressed).toBe(false);
    expect(regression.estimation).toBe('ok');
    expect(regression.method).toBe('binary_logistic');
    expect(regression.eventLevel).toBe('true');
    expect(regression.inferenceDistribution).toBe('normal'); // 로지스틱+HC3
    expect(regression.inferenceDf).toBeNull();
    const predictorTerm = regression.terms.find((t: { variableKey: string }) => t.variableKey === OUTCOME_KEY);
    expect(predictorTerm).toBeDefined();
    expect(predictorTerm.exponentiated).not.toBeNull();
    expect(predictorTerm.exponentiated.estimate).toBeGreaterThan(0); // OR은 항상 양수
    expect(regression.fit.logLik).not.toBeNull();
    expect(regression.fit.aic).not.toBeNull();
  }, 30000);

  // PR4-A2(리뷰 후 수정) — regression export는 이제 지원된다(계획서 §4 "그 외 배선"
  // — REGRESSION_EXPORT_NOT_SUPPORTED 차단 제거). 이 테스트는 반대 기대값이 그대로
  // 남아 있었다(리뷰 지적) — 실 DB·실 Python 경계를 넘어 200 + CSV 본문에 모형
  // 메타데이터(outcomeKey/eventLevel/표준화)가 실리는지, pointDiagnostics가 CSV에
  // 없는지(disclosure-safety 회귀 방지)까지 확인한다.
  it('POST /export는 회귀 결과를 CSV로 반환하고, 모형 메타데이터를 포함하며, pointDiagnostics는 담지 않는다(실 저장 결과 기준)', async () => {
    await seedPatients();
    const analyze = await postAnalyzeAndAwait({
      ...RECIPE_BASE, variableKeys: VARIABLE_KEYS, formulaPolicies: FORMULA_POLICIES,
      analysisMode: 'regression', regression: { outcomeKey: OUTCOME_KEY }, requestedMethod: 'ols_linear',
    });
    expect(analyze.status).toBe(200);
    const analysisRunId = analyze.body.runManifest.analysisRunId;

    const exportRes = await authed(request(app()).post('/api/stats/export')).send({ analysisRunId });
    expect(exportRes.status).toBe(200);
    const csv = exportRes.text as string;
    expect(csv).toContain('# section,model');
    expect(csv).toContain(`outcomeKey,eventLevel,method,covariance`);
    expect(csv).toContain(OUTCOME_KEY);
    expect(csv).toContain('# section,referenceLevelsUsed');
    expect(csv).toContain('# section,standardization');
    expect(csv).toContain('# section,coefficients');
    expect(csv).not.toContain('pointDiagnostics');
    expect(csv).not.toContain('rowIndex');
    expect(csv).not.toContain('cooksDistance');
  }, 30000);

  // PR4-A2(3차 리뷰 지적) — 이전 버전은 평균·SD·계수가 "유한한지"만 봐서, 메타
  //데이터를 채우면서 실제 (x-mean)/sd 변환 자체를 빠뜨려도(예: mean/sd만 계산해
  // 보고하고 실제 열은 원 단위 그대로 쓴 채 회귀를 돌려도) 통과할 수 있었다.
  // 이번엔 (a) fixture를 직접 구성해 실제 분석 코드(computeKneeCalc, `@wr/
  // analytics-core`)로 기대 평균·SD를 독립적으로 재계산해 서버 응답과 대조하고,
  // (b) standardizePredictors:false로 같은 recipe를 한 번 더 돌려 원 단위 계수
  // β_raw를 얻은 뒤 β_std ≈ β_raw × SD(표준화의 대수적 불변식 — z=(x-mean)/sd는
  // x의 아핀 변환이므로 로지스틱 MLE의 적합 곡선 자체는 바뀌지 않고 계수만
  // 척도가 바뀐다)까지 확인한다.
  it('표준화(standardizePredictors:true) — 실제 (x-mean)/sd 변환이 일어나는지 fixture 재계산 + β_std≈β_raw×SD로 검증', async () => {
    // shoulder(boolean outcome)가 knee burden(continuous predictor)으로 완전분리되지
    // 않도록 그룹 구간에 실제 겹침을 만든다(위 로지스틱 테스트와 동일한 기법) —
    // 동시에 이 배열 자체가 "실제로 삽입한 값"의 단일 진실원이 되어, 아래에서
    // computeKneeCalc로 기대 평균·SD를 재계산할 때 fixture와 어긋날 여지가 없다.
    const fixture: Array<{ shoulder: boolean; bin: keyof typeof KNEE_BURDEN_BINS }> = [
      ...Array.from({ length: 10 }, () => ({ shoulder: false as const, bin: 'low' as const })),
      ...Array.from({ length: 10 }, () => ({ shoulder: false as const, bin: 'lowMid' as const })),
      ...Array.from({ length: 10 }, () => ({ shoulder: true as const, bin: 'highMid' as const })),
      ...Array.from({ length: 10 }, () => ({ shoulder: true as const, bin: 'high' as const })),
      ...Array.from({ length: 4 }, () => ({ shoulder: false as const, bin: 'highMid' as const })), // 분리 방지
      ...Array.from({ length: 4 }, () => ({ shoulder: true as const, bin: 'lowMid' as const })), // 분리 방지
    ];
    const sharedFixture = { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] };
    for (let i = 0; i < fixture.length; i += 1) {
      const { shoulder, bin } = fixture[i];
      await insertPatient(
        {
          data: {
            shared: sharedFixture,
            modules: { shoulder: shoulderModule(shoulder), knee: kneeModule(bin) },
            activeModules: ['shoulder', 'knee'],
          },
        },
        `std-fixture-${i}-${crypto.randomUUID()}`,
      );
    }

    // 실제 분석 코드(패키지가 서버·클라이언트와 공유하는 그 함수)로 기대 평균·SD를
    // 독립 재계산한다 — 매직넘버 하드코딩이 아니라 실 fixture×실 formula.
    const expectedValues = fixture.map(
      ({ bin }) => Number(computeKneeCalc({ shared: sharedFixture as any, module: kneeModule(bin) as any }).relatedness.max),
    );
    const expectedMean = expectedValues.reduce((a, b) => a + b, 0) / expectedValues.length;
    const expectedSd = Math.sqrt(
      expectedValues.reduce((a, b) => a + (b - expectedMean) ** 2, 0) / expectedValues.length,
    ); // statsRegressionDesign.ts와 동일하게 모집단 SD(ddof=0)

    const variableKeys = [PREDICTOR_KEY, OUTCOME_KEY]; // outcome=boolean(shoulder), predictor=continuous(knee)
    const baseBody = {
      ...RECIPE_BASE, variableKeys, formulaPolicies: FORMULA_POLICIES,
      analysisMode: 'regression' as const, requestedMethod: 'binary_logistic' as const,
    };

    const standardized = await postAnalyzeAndAwait({
      ...baseBody, regression: { outcomeKey: PREDICTOR_KEY, standardizePredictors: true },
    });
    expect(standardized.status).toBe(200);
    const stdRegression = standardized.body.result.regression;
    expect(stdRegression.estimation).toBe('ok');
    expect(stdRegression.n).toBe(fixture.length);
    expect(stdRegression.standardizedPredictorKeys).toEqual([OUTCOME_KEY]); // 여기선 knee가 predictor
    expect(stdRegression.standardization).not.toBeNull();
    const stats = stdRegression.standardization[OUTCOME_KEY];
    // (a) fixture 재계산 대조 — 메타데이터가 실제 데이터에서 나온 값인지.
    expect(stats.mean).toBeCloseTo(expectedMean, 6);
    expect(stats.sd).toBeCloseTo(expectedSd, 6);
    const stdTerm = stdRegression.terms.find((t: { variableKey: string }) => t.variableKey === OUTCOME_KEY);
    expect(Number.isFinite(stdTerm.estimate)).toBe(true);

    // 비표준화 실행 — 원 단위 계수 β_raw를 얻는다(같은 recipe, standardizePredictors만 false).
    const raw = await postAnalyzeAndAwait({
      ...baseBody, regression: { outcomeKey: PREDICTOR_KEY, standardizePredictors: false },
    });
    expect(raw.status).toBe(200);
    const rawRegression = raw.body.result.regression;
    expect(rawRegression.estimation).toBe('ok');
    expect(rawRegression.standardizedPredictorKeys).toEqual([]);
    const rawTerm = rawRegression.terms.find((t: { variableKey: string }) => t.variableKey === OUTCOME_KEY);
    expect(Number.isFinite(rawTerm.estimate)).toBe(true);

    // (b) 표준화의 대수적 불변식 — β_std ≈ β_raw × SD. z=(x-mean)/sd는 x의 아핀
    // 변환이라 로지스틱 MLE의 적합 함수 자체는 동일하고 계수만 척도가 바뀐다
    // (실제 (x-mean)/sd 변환이 빠진 채 메타데이터만 채웠다면 이 관계가 깨진다 —
    // 이번 리뷰가 지적한 "변환 누락"을 직접 잡아내는 검증).
    expect(stdTerm.estimate).toBeCloseTo(rawTerm.estimate * stats.sd, 3);

    const analysisRunId = standardized.body.runManifest.analysisRunId;
    const exportRes = await authed(request(app()).post('/api/stats/export')).send({ analysisRunId });
    expect(exportRes.status).toBe(200);
    const csv = exportRes.text as string;
    const standardizationRows = extractCsvSection(csv, 'standardization');
    expect(standardizationRows).toEqual([
      { variableKey: OUTCOME_KEY, mean: expect.any(String), sd: expect.any(String) },
    ]);
    expect(parseFloat(standardizationRows![0].mean)).toBeCloseTo(expectedMean, 6);
    expect(parseFloat(standardizationRows![0].sd)).toBeCloseTo(expectedSd, 6);
  }, 30000);

  // PR4-A2(2차 리뷰 지적) — 이전 버전은 부여 후 상태를 available/unavailable_model/
  // unavailable_computation_failed 셋 중 아무거나 허용해, 진단 엔진 연결이 항상
  // 실패해도 통과했다. 이 fixture(boolean predictor, n=40, 그룹 내부 분산 있음)는
  // leverage·MSE 둘 다 건강해 진단을 지원해야 하는 모형이므로 **available만**
  // 정답으로 인정하고, pointDiagnostics 배열의 실제 내용(점 개수·유한값)까지
  // 검증한다. 실패 경로(unavailable_model)는 아래 별도 테스트로 분리했다(리뷰 지적).
  it('권한 축(stats.export_limited_rows) — 없음→부여→회수 순서로 pointDiagnosticsStatus가 갱신되고, 캐시 적중 시 계수는 불변', async () => {
    await seedPatients();
    const body = {
      ...RECIPE_BASE, variableKeys: VARIABLE_KEYS, formulaPolicies: FORMULA_POLICIES,
      analysisMode: 'regression', regression: { outcomeKey: OUTCOME_KEY }, requestedMethod: 'ols_linear',
    };

    const first = await postAnalyzeAndAwait(body);
    expect(first.status).toBe(200);
    expect(first.body.result.regression.diagnostics.pointDiagnosticsStatus).toBe('unavailable_no_access');
    // 권한 없음 — pointDiagnostics 키 자체가 없어야 한다(값이 빈 배열인 것과는 다름).
    expect(first.body.result.regression.diagnostics).not.toHaveProperty('pointDiagnostics');

    const grant = await pool.query<{ id: string }>(
      `INSERT INTO user_capability_grants (user_id, organization_id, capability, granted_by, granted_by_org, reason)
       VALUES ($1,$2,'stats.export_limited_rows',$1,$2,'test grant') RETURNING id`,
      [userId, orgId],
    );
    try {
      // 같은 recipe(=같은 execution_digest) — stats_runs 캐시 hit 경로를 그대로 타면서도
      // 권한 축만 새로 반영돼야 한다(limited_row 재계산은 캐시와 무관, 계획서 §4).
      const second = await postAnalyzeAndAwait(body);
      expect(second.status).toBe(200);
      // 같은 analysisRunId — stats_runs 캐시 hit(재계산 아님)을 실제로 증명한다.
      expect(second.body.runManifest.analysisRunId).toBe(first.body.runManifest.analysisRunId);
      const diagnosticsGranted = second.body.result.regression.diagnostics;
      expect(diagnosticsGranted.pointDiagnosticsStatus).toBe('available');
      expect(diagnosticsGranted.pointDiagnosticsSupported).toBe(true);
      expect(Array.isArray(diagnosticsGranted.pointDiagnostics)).toBe(true);
      expect(diagnosticsGranted.pointDiagnostics.length).toBe(diagnosticsGranted.displayedPointCount);
      expect(diagnosticsGranted.totalPointCount).toBe(second.body.result.regression.n);
      expect(diagnosticsGranted.displayedPointCount).toBe(second.body.result.regression.n); // n=40 < 상한(2000) — 전량 표시
      for (const point of diagnosticsGranted.pointDiagnostics) {
        expect(Number.isFinite(point.rowIndex)).toBe(true);
        expect(Number.isFinite(point.fittedValue)).toBe(true);
        expect(Number.isFinite(point.residual)).toBe(true);
        expect(Number.isFinite(point.leverage)).toBe(true);
        expect(Number.isFinite(point.standardizedResidual)).toBe(true);
        expect(Number.isFinite(point.cooksDistance)).toBe(true);
        expect(Number.isFinite(point.theoreticalQuantile)).toBe(true);
      }
      // 계수·적합도(aggregate)는 권한과 무관하게 캐시된 값 그대로여야 한다.
      expect(second.body.result.regression.terms).toEqual(first.body.result.regression.terms);

      await pool.query(
        `UPDATE user_capability_grants
            SET revoked_at = now(), revoked_by = $2, revoked_by_org = $3, revocation_reason = 'manual'
          WHERE id = $1`,
        [grant.rows[0].id, userId, orgId],
      );
      const third = await postAnalyzeAndAwait(body);
      expect(third.status).toBe(200);
      expect(third.body.runManifest.analysisRunId).toBe(first.body.runManifest.analysisRunId); // 여전히 캐시 hit
      expect(third.body.result.regression.diagnostics.pointDiagnosticsStatus).toBe('unavailable_no_access');
      expect(third.body.result.regression.diagnostics).not.toHaveProperty('pointDiagnostics');
      expect(third.body.result.regression.terms).toEqual(first.body.result.regression.terms);
    } finally {
      await pool.query(
        `DELETE FROM user_capability_grants WHERE user_id = $1 AND organization_id = $2 AND capability = 'stats.export_limited_rows'`,
        [userId, orgId],
      );
    }
  }, 30000);

  // PR4-A2(2차 리뷰 지적) — "실패 경로는 별도 테스트로 분리"하라는 지적에 따라
  // 추가. 엔진 프로세스를 mock으로 죽이는 대신, 진짜(비mock) 완전적합 모형을
  // 만들어 Python의 `_evaluate_diagnostic_support`가 실제로 INVALID_DIAGNOSTIC_
  // SCALE을 내는 경로를 실 DB·실 Python 경계로 재현한다 — 그룹별 knee burden을
  // (이전 테스트와 달리) 그룹 내부에서 상수로 고정해, boolean predictor 하나가
  // outcome 분산을 100% 설명하게 만든다(잔차=0 → MSE=0). 이 판정은 estimation
  // 상태(ok/inference_withheld)와 무관하게 독립적으로 이뤄져야 한다는 것이
  // 계획서 §3의 핵심 불변식이므로, Node의 pointDiagnosticsStatus 게이트가 엔진을
  // 아예 호출하지 않고 'unavailable_model'로 응답하는지까지 확인한다.
  it('완전적합(잔차 0) 모형은 진단 엔진을 호출하지 않고 pointDiagnosticsStatus=unavailable_model로 응답한다(실패 경로)', async () => {
    // REGRESSION_POLICY.minCompleteRows(statsPolicy.ts) = 30 — 이 문턱 아래면
    // INSUFFICIENT_COMPLETE_ROWS로 더 일찍 non_estimable이 되어 diagnostics 판정
    // 자체에 도달하지 못한다. 완전적합을 유지하면서 문턱을 넘기려면 그룹당 15명.
    await insertGroup('perfect-fit-false', 15, () => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(false), knee: kneeModule('low') },
        activeModules: ['shoulder', 'knee'],
      },
    }));
    await insertGroup('perfect-fit-true', 15, () => ({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
        modules: { shoulder: shoulderModule(true), knee: kneeModule('high') },
        activeModules: ['shoulder', 'knee'],
      },
    }));

    await pool.query(
      `INSERT INTO user_capability_grants (user_id, organization_id, capability, granted_by, granted_by_org, reason)
       VALUES ($1,$2,'stats.export_limited_rows',$1,$2,'test grant')`,
      [userId, orgId],
    );
    try {
      const analyze = await postAnalyzeAndAwait({
        ...RECIPE_BASE, variableKeys: VARIABLE_KEYS, formulaPolicies: FORMULA_POLICIES,
        analysisMode: 'regression', regression: { outcomeKey: OUTCOME_KEY }, requestedMethod: 'ols_linear',
      });
      expect(analyze.status).toBe(200);
      const regression = analyze.body.result.regression;
      expect(regression.n).toBe(30);
      expect(regression.fit?.r2).toBeCloseTo(1, 6); // 완전적합 실측 확인
      const diagnostics = regression.diagnostics;
      expect(diagnostics.pointDiagnosticsSupported).toBe(false);
      expect(diagnostics.pointDiagnosticsUnsupportedReason).toBe('INVALID_DIAGNOSTIC_SCALE');
      expect(diagnostics.pointDiagnosticsStatus).toBe('unavailable_model');
      expect(diagnostics).not.toHaveProperty('pointDiagnostics');
    } finally {
      await pool.query(
        `DELETE FROM user_capability_grants WHERE user_id = $1 AND organization_id = $2 AND capability = 'stats.export_limited_rows'`,
        [userId, orgId],
      );
    }
  }, 30000);

  // PR4-A2(별도 작업 — 2차 리뷰가 반복 지적한 "interaction+spline+categorical
  // outcome 조합의 HTTP 통합 검증 누락"). categorical outcome(patient.identity.
  // gender) + interaction(shoulder.exposure.anyExceeded × patient.identity.
  // heightCm, 둘 다 spline 밖) + spline(knee.relatedness.max)을 한 recipe에
  // 동시에 걸어 실 DB·실 Python 경계를 끝까지 통과하는지 확인한다. 세 옵션을
  // 각각 따로 쓰는 경로는 이미 단위/모형 테스트가 다루므로, 여기서는 "세 개를
  // 동시에 걸었을 때 설계행렬 조립(Node)·spline contrast 왕복(Python)이 서로
  // 깨지지 않는지"만 본다.
  //
  // knee.relatedness.max는 실제로는 계단함수라(calculateWorkRelatedness —
  // burden level 4단계 × 나이 계수) 같은 나이·같은 job 기간에서는 딱 4가지
  // 값만 나온다 — spline의 MIN_UNIQUE_VALUES(5)를 채우려고 한 그룹만 나이를
  // 다르게 줘서(age factor가 달라짐) 5번째 값을 만든다(아래 KNEE_SPLINE_BINS).
  const KNEE_SPLINE_BINS: Array<{ birthDate: string; weight: number; squatting: number }> = [
    { birthDate: '1980-01-01', weight: 500, squatting: 10 },   // age40, 경도    -> 50.0
    { birthDate: '1985-01-01', weight: 500, squatting: 10 },   // age35, 경도    -> 66.7(나이만 다름)
    { birthDate: '1980-01-01', weight: 500, squatting: 90 },   // age40, 중등도하 -> 75.0
    { birthDate: '1980-01-01', weight: 3500, squatting: 90 },  // age40, 중등도상 -> 83.3
    { birthDate: '1980-01-01', weight: 3500, squatting: 130 }, // age40, 고도    -> 88.9
  ];
  function rawKneeModule(weight: number, squatting: number) {
    return { jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: String(weight), squatting: String(squatting) }], jobExtras: [] };
  }

  it('interaction+spline+categorical outcome 조합 — 실 DB·실 Python 경계를 끝까지 통과한다', async () => {
    // EPV(REGRESSION_POLICY.minEventsPerParameter=10) — 이 설계는 절편 제외
    // 파라미터가 7개(shoulder 주효과 1 + height 주효과 1 + interaction 1 + spline
    // 기저 4)라 min(event,non-event) ≥ 70이 필요하다(70/7=10.0). gender를 predictor와
    // 무관하게 i%2로 배정해 75/75로 정확히 맞추고(완전분리 위험도 원천 차단),
    // 나머지 predictor는 서로 다른 주기(3/40)로 순환시켜 우연한 완전공선성을 피한다.
    //
    // knee 5값의 등장 횟수는 균등(30/30/30/30/30)이 아니라 [10,20,60,50,10]으로
    // 치우쳐 있다 — resolveSplineKnots(statsSplineBasis.ts)의 type-7 분위수가
    // 정확히 균등분포일 때 10%/90% 지점이 경계값과 우연히 겹쳐(정확한 동률)
    // "내부 knot이 경계와 겹치면 거부" 규칙에 걸려 SPLINE_INSUFFICIENT_UNIQUE_
    // VALUES로 실패하는 것을 실측으로 확인했다 — 5개 값 각각의 빈도를 조정해
    // 10%/50%/90% 분위수가 경계 안쪽 값에 엄격하게 놓이도록 만든다.
    const N = 150;
    const KNEE_BIN_COUNTS = [10, 20, 60, 50, 10]; // KNEE_SPLINE_BINS와 같은 순서
    const kneeBinSequence: number[] = [];
    KNEE_BIN_COUNTS.forEach((count, binIdx) => {
      for (let k = 0; k < count; k += 1) kneeBinSequence.push(binIdx);
    });
    const GENDER_KEY = 'patient.identity.gender';
    const HEIGHT_KEY = 'patient.identity.heightCm';
    for (let i = 0; i < N; i += 1) {
      const gender = i % 2 === 0 ? 'male' : 'female';
      const shoulderExceeded = i % 3 === 0;
      const heightCm = 150 + (i % 40);
      const bin = KNEE_SPLINE_BINS[kneeBinSequence[i]];
      await insertPatient(
        {
          data: {
            shared: {
              gender, height: heightCm,
              birthDate: bin.birthDate, injuryDate: '2020-01-01',
              jobs: [SHOULDER_JOB],
            },
            modules: {
              shoulder: shoulderModule(shoulderExceeded),
              knee: rawKneeModule(bin.weight, bin.squatting),
            },
            activeModules: ['shoulder', 'knee'],
          },
        },
        `combo-${i}-${crypto.randomUUID()}`,
      );
    }

    const variableKeys = [GENDER_KEY, PREDICTOR_KEY, HEIGHT_KEY, OUTCOME_KEY]; // outcome=gender, predictors=shoulder·height·knee
    const formulaPolicies = {
      [GENDER_KEY]: 'recompute_current', [PREDICTOR_KEY]: 'recompute_current',
      [HEIGHT_KEY]: 'recompute_current', [OUTCOME_KEY]: 'recompute_current',
    };

    const analyze = await postAnalyzeAndAwait({
      ...RECIPE_BASE, variableKeys, formulaPolicies,
      analysisMode: 'regression',
      regression: {
        outcomeKey: GENDER_KEY,
        eventLevel: 'female',
        interactionTerms: [[PREDICTOR_KEY, HEIGHT_KEY]],
        splineKeys: [OUTCOME_KEY], // knee.relatedness.max
      },
      requestedMethod: 'binary_logistic',
    });
    expect(analyze.status).toBe(200);
    const regression = analyze.body.result.regression;
    expect(regression.suppressed).toBe(false);
    expect(regression.estimation).toBe('ok');
    expect(regression.method).toBe('binary_logistic');
    expect(regression.eventLevel).toBe('female');
    expect(regression.n).toBe(N);
    expect(regression.personCount).toBe(N);

    // 절편 + shoulder 주효과 + height 주효과 + interaction + spline 기저 4열 = 8항.
    expect(regression.terms).toHaveLength(8);
    const splineTerms = regression.terms.filter((t: { termType: string }) => t.termType === 'spline_basis');
    expect(splineTerms).toHaveLength(4);
    expect(splineTerms.every((t: { variableKey: string | null }) => t.variableKey === OUTCOME_KEY)).toBe(true);
    const interactionTerm = regression.terms.find((t: { termType: string }) => t.termType === 'interaction');
    expect(interactionTerm).toBeDefined();
    expect(interactionTerm.interactionOf).toEqual([PREDICTOR_KEY, HEIGHT_KEY]);
    expect(Number.isFinite(interactionTerm.estimate)).toBe(true);
    const shoulderMainTerm = regression.terms.find((t: { variableKey: string; termType: string }) => t.variableKey === PREDICTOR_KEY && t.termType === 'main');
    const heightMainTerm = regression.terms.find((t: { variableKey: string; termType: string }) => t.variableKey === HEIGHT_KEY && t.termType === 'main');
    expect(shoulderMainTerm).toBeDefined();
    expect(heightMainTerm).toBeDefined();

    // spline 부분효과 — Node가 만든 contrast가 Python 왕복을 실제로 거쳐 그래프
    // 데이터가 나오는지(그리드 40점, statsRegressionSuppression.ts SPLINE_GRID_SIZE).
    expect(regression.splinePartialEffects).not.toBeNull();
    expect(regression.splinePartialEffects).toHaveLength(1);
    const effect = regression.splinePartialEffects[0];
    expect(effect.variableKey).toBe(OUTCOME_KEY);
    expect(effect.points.length).toBeGreaterThan(0);
    expect(effect.points.every((p: { x: number }) => Number.isFinite(p.x))).toBe(true);

    // 진단(VIF/condition number)은 aggregate라 권한과 무관하게 채워진다 — 이 recipe가
    // 계획서 §2 "표준화·spline 기저"·"interaction 열" 조립을 모두 거쳤다는 방증.
    expect(regression.diagnostics).not.toBeNull();
    expect(regression.diagnostics.pointDiagnosticsStatus).toBe('unavailable_no_access'); // 이 테스트는 권한을 부여하지 않음

    const analysisRunId = analyze.body.runManifest.analysisRunId;
    const exportRes = await authed(request(app()).post('/api/stats/export')).send({ analysisRunId });
    expect(exportRes.status).toBe(200);
    const csv = exportRes.text as string;
    expect(csv).toContain('# section,splinePartialEffects');
    expect(csv).not.toContain('pointDiagnostics');
  }, 60000);
});

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
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-regression-csrf';

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

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
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
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  afterEach(async () => {
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

    const analyze = await authed(request(app()).post('/api/stats/analyze')).send({
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

    const analyze = await authed(request(app()).post('/api/stats/analyze')).send({
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

  it('POST /export는 회귀 결과를 REGRESSION_EXPORT_NOT_SUPPORTED로 거부한다(실 저장 결과 기준)', async () => {
    await seedPatients();
    const analyze = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys: VARIABLE_KEYS, formulaPolicies: FORMULA_POLICIES,
      analysisMode: 'regression', regression: { outcomeKey: OUTCOME_KEY }, requestedMethod: 'ols_linear',
    });
    expect(analyze.status).toBe(200);
    const analysisRunId = analyze.body.runManifest.analysisRunId;

    const exportRes = await authed(request(app()).post('/api/stats/export')).send({ analysisRunId });
    expect(exportRes.status).toBe(400);
    expect(exportRes.body.code).toBe('REGRESSION_EXPORT_NOT_SUPPORTED');
  }, 30000);
});

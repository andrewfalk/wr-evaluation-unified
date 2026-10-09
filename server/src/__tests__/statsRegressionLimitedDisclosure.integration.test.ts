// 제한데이터(stats.export_limited_rows) 권한자의 회귀 소수 셀(1~9명) 제한 해제 — 실제 Postgres + 실제 Python +
// 실제 워커로 HTTP 경로 전체를 증명한다(statsLimitedDisclosure.integration.test.ts와 같은 방식).
// 핵심 검증: (1) 결측 제외가 소수(3명)라 통째로 가려진 회귀가 권한자에게는 추정 결과로 풀린다,
// (2) 소수 인원 때문이 아니라 표본 부족 같은 통계 조건이면 해제돼도 계산 불가 사유가 그대로 나온다,
// (3) 해제본은 stats_runs.result(캐시)에 저장되지 않고 응답 시점 권한으로만 나온다, (4) 회수·접근 제어.
//
//   TEST_DATABASE_URL=postgres://wr_user:<PW>@localhost:5432/wr_test \
//     npx vitest run --config vitest.config.ts src/__tests__/statsRegressionLimitedDisclosure.integration.test.ts
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../statsWorkbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: true, reason: null, checkedAt: null }),
  setStatsWorkbenchHealthy: () => {},
}));

import { createStatsRouter } from '../routes/stats';
import { createStatsRunsQueueWorker } from '../statsRunsQueue';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';
import { __resetDifferencingGuardForTests } from '../statsDifferencingGuard';
import { __resetLimitedDisclosureGuardForTests } from '../statsLimitedDisclosureGuard';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-reg-limited-csrf';
const CAP = 'stats.export_limited_rows';

// statsRegressionHttp.integration.test.ts와 같은 fixture — knee burden(continuous) ~ shoulder 초과(boolean).
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
function shoulderModule(exceeded: boolean) {
  return { jobExtras: [{ sharedJobId: 'job-1', overheadHours: exceeded ? '3' : '0.1' }] };
}
const SHOULDER_JOB = { id: 'job-1', startDate: '2015-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };

interface TestUser { id: string; token: string }

describe.skipIf(!TEST_DB_URL)('회귀 제한 해제 — HTTP 통합 (실제 Postgres+Python+워커)', () => {
  let pool: Pool;
  let orgId: string;
  let owner: TestUser;      // 해제 대상 사용자(권한 grant/revoke를 반복)
  let adminNoCap: TestUser; // 같은 조직의 admin(제한데이터 권한 없음)
  let worker: { stop: () => void };
  const createdUserIds: string[] = [];

  async function createUser(org: string, role: 'doctor' | 'admin', name: string): Promise<TestUser> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [`__test_reglimited_${role}_${crypto.randomUUID()}__`, 'x', name, role, org],
    );
    const id = user.rows[0].id;
    createdUserIds.push(id);
    const sessionId = crypto.randomUUID();
    const csrfHash = hashToken(CSRF_TOKEN);
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, family_id)
       VALUES ($1,$2,$3,$4, now() + interval '1 day', $5)`,
      [sessionId, id, hashToken(generateToken()), csrfHash, crypto.randomUUID()],
    );
    const token = generateAccessToken({
      sub: id, sessionId, orgId: org, role, name, mustChangePassword: false, csrfHash,
    }).token;
    return { id, token };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    worker = createStatsRunsQueueWorker(pool);
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, ['__test_reglimited_org__'])).rows[0].id;
    owner = await createUser(orgId, 'doctor', '소유자 의사');
    adminNoCap = await createUser(orgId, 'admin', '관리자');
  });

  afterAll(async () => {
    worker.stop();
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM user_capability_grants WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [createdUserIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  beforeEach(() => {
    __resetDifferencingGuardForTests();
    __resetLimitedDisclosureGuardForTests();
  });

  afterEach(async () => {
    await revoke();
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
  });

  async function grant(): Promise<void> {
    await pool.query(
      `INSERT INTO user_capability_grants (user_id, organization_id, capability, granted_by, granted_by_org, reason)
       VALUES ($1,$2,$3,$1,$2,'test grant')`,
      [owner.id, orgId, CAP],
    );
  }
  async function revoke(): Promise<void> {
    await pool.query(`DELETE FROM user_capability_grants WHERE user_id=$1 AND organization_id=$2 AND capability=$3`, [owner.id, orgId, CAP]);
  }

  function app() {
    const a = express();
    a.use(express.json());
    a.use(cookieParser());
    a.use('/api/stats', createStatsRouter(pool));
    return a;
  }
  function as(user: TestUser, req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${user.token}`).set('X-CSRF-Token', CSRF_TOKEN);
  }
  const post = (user: TestUser, path: string, body: unknown) => as(user, request(app()).post(`/api/stats/${path}`)).send(body as object);
  const get = (user: TestUser, path: string) => as(user, request(app()).get(`/api/stats/${path}`));

  async function insertPatient(payload: unknown, name: string): Promise<void> {
    const person = await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1,$2) RETURNING id`, [orgId, name],
    );
    await pool.query(
      `INSERT INTO patient_records (organization_id, owner_user_id, patient_person_id, name, revision, payload)
       VALUES ($1,$2,$3,$4,1,$5)`,
      [orgId, owner.id, person.rows[0].id, name, payload],
    );
  }
  // shoulder 초과 여부가 다른 두 그룹 — 초과 그룹의 knee burden bin이 더 커서 predictor 계수가 양수다.
  async function seedComplete(perGroup: number): Promise<void> {
    for (const exceeded of [false, true]) {
      for (let i = 0; i < perGroup; i += 1) {
        const bin = exceeded ? (i % 2 === 0 ? 'highMid' : 'high') : (i % 2 === 0 ? 'low' : 'lowMid');
        await insertPatient({
          data: {
            shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
            modules: { shoulder: shoulderModule(exceeded), knee: kneeModule(bin) },
            activeModules: ['shoulder', 'knee'],
          },
        }, `reg-${exceeded}-${i}-${crypto.randomUUID()}`);
      }
    }
  }
  // 두 변수가 모두 결측인 인원 — 완전사례에서 제외된다.
  async function seedMissing(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await insertPatient(
        { data: { shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [] }, modules: {}, activeModules: [] } },
        `reg-missing-${i}-${crypto.randomUUID()}`,
      );
    }
  }

  const OUTCOME_KEY = 'knee.relatedness.max';
  const PREDICTOR_KEY = 'shoulder.exposure.anyExceeded';
  const REGRESSION_BODY = {
    grain: 'case', filters: [], analysisPurpose: 'association',
    variableKeys: [OUTCOME_KEY, PREDICTOR_KEY],
    formulaPolicies: { [OUTCOME_KEY]: 'recompute_current', [PREDICTOR_KEY]: 'recompute_current' },
    analysisMode: 'regression', regression: { outcomeKey: OUTCOME_KEY }, requestedMethod: 'ols_linear',
  };

  async function runRow(analysisRunId: string) {
    return (await pool.query<{ result: { regression?: { suppressed: boolean } }; frozen_dataset: unknown }>(
      `SELECT result, frozen_dataset FROM stats_runs WHERE analysis_run_id=$1`, [analysisRunId],
    )).rows[0];
  }

  // ---------------------------------------------------------------------------
  // 핵심 시나리오: 완전사례 40명 + 결측 제외 3명 — 제외 3명이 소수 셀이라 회귀 전체가 비공개였다.
  // ---------------------------------------------------------------------------
  it('미리보기: 결측 제외 3명 때문에 방법 목록이 비어 실행 불가였던 분석이 권한자에게는 실행 가능하게 보인다', async () => {
    await seedComplete(20);
    await seedMissing(3);
    const body = { ...REGRESSION_BODY, requestedMethod: undefined };

    const plain = await post(owner, 'preview', body);
    expect(plain.status).toBe(200);
    expect(plain.body.availableMethods).toEqual([]); // 공개 게이트가 닫혀 방법 목록 자체가 없다
    expect(plain.body.limitedDisclosure).toBeUndefined();

    await grant();
    const lifted = await post(owner, 'preview', body);
    expect(lifted.status).toBe(200);
    expect(lifted.body.limitedDisclosure).toBe('applied');
    const ols = lifted.body.availableMethods.find((m: { id: string }) => m.id === 'ols_linear');
    expect(ols).toMatchObject({ status: 'available' });
    expect(lifted.body.estimability.candidateParameterCount).toBe(2); // 절편 + boolean predictor 1열

    // 권한이 없는 같은 조직 admin은 해제되지 않는다.
    const adminPreview = await post(adminNoCap, 'preview', body);
    expect(adminPreview.body.availableMethods).toEqual([]);
    expect(adminPreview.body.limitedDisclosure).toBeUndefined();
  }, 60000);

  it('분석: 권한자는 응답 시점에 추정 결과가 해제되고 저장된 캐시에는 억제 스텁만 남으며, 비권한자는 스텁을 받는다', async () => {
    await seedComplete(20);
    await seedMissing(3);

    const plain = await post(owner, 'analyze', REGRESSION_BODY);
    expect(plain.status).toBe(200);
    expect(plain.body.result.regression).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(plain.body.result.limitedDisclosure).toBeUndefined();

    await grant();
    const res = await post(owner, 'analyze', REGRESSION_BODY);
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    const regression = res.body.result.regression;
    expect(regression.suppressed).toBe(false);
    expect(regression.estimation).toBe('ok');
    expect(regression.n).toBe(40); // 결측 제외 3명을 뺀 완전사례
    expect(regression.personCount).toBe(40);
    const predictorTerm = regression.terms.find((t: { variableKey: string }) => t.variableKey === PREDICTOR_KEY);
    expect(predictorTerm.estimate).toBeGreaterThan(0);
    // 해제된 회귀에도 권한자용 점별 진단이 붙는다 — 제한 컨텍스트(regressionDesign=null)로 부착하면 항상
    // unavailable_computation_failed가 된다(코드리뷰 지적).
    expect(regression.diagnostics.pointDiagnosticsStatus).toBe('available');
    expect(regression.diagnostics.pointDiagnostics.length).toBe(regression.diagnostics.displayedPointCount);

    // 저장된 두 실행 모두 스텁 그대로 — 해제 수치·플래그가 DB에 없다.
    const rows = await pool.query<{ result: unknown }>(`SELECT result FROM stats_runs WHERE organization_id=$1`, [orgId]);
    expect(rows.rows.length).toBe(2);
    for (const r of rows.rows) {
      const stored = JSON.stringify(r.result);
      expect(stored).not.toContain('limitedDisclosure');
      expect(stored).not.toContain('terms');
    }
  }, 60000);

  it('같은 analysisRunId GET은 해제를 유지하고, 권한을 회수하면 스텁으로 되돌아간다. 권한 없는 admin은 스텁이다', async () => {
    await seedComplete(20);
    await seedMissing(3);
    await grant();
    const res = await post(owner, 'analyze', REGRESSION_BODY);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    const runId = res.body.runManifest.analysisRunId;
    expect((await runRow(runId)).frozen_dataset).not.toBeNull(); // 권한자 조기 억제 실행만 원본을 남긴다

    const viaGet = await get(owner, `runs/${runId}`);
    expect(viaGet.status).toBe(200);
    expect(viaGet.body.result.limitedDisclosure).toBe('applied');
    expect(viaGet.body.result.regression.estimation).toBe('ok');

    const adminGet = await get(adminNoCap, `runs/${runId}`);
    expect(adminGet.status).toBe(200);
    expect(adminGet.body.result.regression).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(adminGet.body.result.limitedDisclosure).toBeUndefined();

    await revoke();
    const afterRevoke = await get(owner, `runs/${runId}`);
    expect(afterRevoke.body.result.regression).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(afterRevoke.body.result.limitedDisclosure).toBeUndefined();
  }, 60000);

  it('권한 없이 만든 억제 실행은 원본이 없어, 나중에 권한을 받아도 같은 ID로는 풀리지 않고 재실행 안내(unavailable_source_missing)가 나온다', async () => {
    await seedComplete(20);
    await seedMissing(3);
    const plain = await post(owner, 'analyze', REGRESSION_BODY);
    const runId = plain.body.runManifest.analysisRunId;
    expect((await runRow(runId)).frozen_dataset).toBeNull();

    await grant();
    const viaGet = await get(owner, `runs/${runId}`);
    expect(viaGet.body.result.regression).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(viaGet.body.result.limitedDisclosure).toBe('unavailable_source_missing');

    // 재실행하면 풀린다.
    const rerun = await post(owner, 'analyze', REGRESSION_BODY);
    expect(rerun.body.result.limitedDisclosure).toBe('applied');
  }, 60000);

  // ---------------------------------------------------------------------------
  // 공개 제한과 계산 가능 조건의 분리 — 해제돼도 표본이 모자라면 계산 불가 사유가 그대로 나온다.
  // ---------------------------------------------------------------------------
  it('전체 N<10 조기 억제: 해제돼도 완전사례가 모자라면(최소 30) 계산 불가 사유(INSUFFICIENT_COMPLETE_ROWS)로 응답한다', async () => {
    await seedComplete(3); // 6명 — 요청 수준 억제(N<10)
    await grant();
    const res = await post(owner, 'analyze', REGRESSION_BODY);
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    expect(res.body.result.regression).toMatchObject({
      suppressed: false, estimation: 'non_estimable', nonEstimableReason: 'INSUFFICIENT_COMPLETE_ROWS',
    });
  }, 60000);

  it('차분(differencing) 제한은 권한자도 풀리지 않는다 — 원본이 저장되지 않고, 같은 ID GET에서도 해제되지 않으며, 미리보기도 억제 그대로다', async () => {
    await seedComplete(20);
    await seedMissing(3);
    await grant();
    const body = (day: number) => ({
      ...REGRESSION_BODY,
      filters: [{ key: 'case.meta.registeredAt', operator: 'gte', value: `2000-01-${String(day).padStart(2, '0')}` }],
    });
    // 같은 family에서 서로 다른 필터 값을 11개 조회하면(maxDistinctFilterValuesPerKey=10 초과) forceSuppress.
    for (let day = 1; day <= 10; day += 1) {
      const preview = await post(owner, 'preview', { ...body(day), requestedMethod: undefined });
      expect(preview.status).toBe(200);
    }
    const lastPreview = await post(owner, 'preview', { ...body(11), requestedMethod: undefined });
    expect(lastPreview.body.counts.suppressed).toBe(true);
    expect(lastPreview.body.counts.reasonCode).toBe('DIFFERENCING_RATE_LIMIT');
    expect(lastPreview.body.limitedDisclosure).toBeUndefined();
    expect(lastPreview.body.availableMethods).toEqual([]);

    const res = await post(owner, 'analyze', body(11));
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBeUndefined();
    expect(res.body.result.regression).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    const id = res.body.runManifest.analysisRunId;
    expect((await runRow(id)).frozen_dataset).toBeNull(); // 사유 코드가 아니라 forceSuppress 플래그로 판정

    __resetDifferencingGuardForTests(); // GET은 differencing을 다시 평가하지 않는다 — 우회 가능성 자체를 확인.
    const viaGet = await get(owner, `runs/${id}`);
    expect(viaGet.body.result.limitedDisclosure).not.toBe('applied');
    expect(viaGet.body.result.regression).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
  }, 120000);
});

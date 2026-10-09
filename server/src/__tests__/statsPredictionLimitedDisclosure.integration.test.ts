// 제한데이터(stats.export_limited_rows) 권한자의 예측 소수 셀(1~9명) 제한 해제 — 실제 Postgres + 실제 Python +
// 실제 워커로 HTTP 경로 전체를 증명한다(statsCorrelationMatrixLimitedDisclosure.integration.test.ts와 같은 저장형 구조).
// 예측은 계산에 수 분이 걸리고 성공 직후 원본 행을 지우므로, 권한자가 "실행"하면 워커가 엔진을 한 번만 돌려 일반본(result)과
// 해제본(limited_result)을 함께 저장하고 조회는 조회자의 현재 권한으로 표시본을 고른다.
// 핵심 검증: (1) 소수 집단(제외 3명) 때문에 억제되던 예측이 권한자에게는 실제 성능 지표로 풀린다,
// (2) 사건이 1~9명이면 "억제"가 아니라 "사건/비사건 인원 부족" 계산 불가 사유로 바뀐다(통계 조건은 유지),
// (3) 해제본은 limited_result에만 있고 result(캐시)·비권한 admin에는 없다, (4) 회수·재조회·CSV.
//
//   TEST_DATABASE_URL=postgres://wr_user:<PW>@localhost:5432/wr_test \
//     npx vitest run --config vitest.config.ts --no-file-parallelism src/__tests__/statsPredictionLimitedDisclosure.integration.test.ts
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
import { attempt, claimNextQueuedRun, createStatsRunsQueueWorker } from '../statsRunsQueue';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';
import { __resetDifferencingGuardForTests } from '../statsDifferencingGuard';
import { __resetLimitedDisclosureGuardForTests } from '../statsLimitedDisclosureGuard';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-pred-limited-csrf';
const CAP = 'stats.export_limited_rows';

interface TestUser { id: string; token: string }

describe.skipIf(!TEST_DB_URL)('예측 제한 해제 — HTTP 통합 (실제 Postgres+Python+워커)', () => {
  let pool: Pool;
  let orgId: string;
  let owner: TestUser;      // 해제 대상 사용자(권한 grant/revoke를 반복)
  let adminNoCap: TestUser; // 같은 조직의 admin(제한데이터 권한 없음)
  let worker: { stop: () => void };
  const createdUserIds: string[] = [];

  async function createUser(org: string, role: 'doctor' | 'admin', name: string): Promise<TestUser> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [`__test_predlimited_${role}_${crypto.randomUUID()}__`, 'x', name, role, org],
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
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, ['__test_predlimited_org__'])).rows[0].id;
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

  // 큐 워커가 도는 실행은 200 또는 202(+폴링)로 끝난다 — 예측은 수 초~수십 초라 사실상 항상 202다.
  async function analyzeAndAwait(user: TestUser, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const res = await post(user, 'analyze', body);
    if (res.status !== 202) return res;
    const analysisRunId = res.body.analysisRunId;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const polled = await get(user, `runs/${analysisRunId}`);
      if (polled.body.status === 'succeeded') return { status: 200, body: { runManifest: polled.body.runManifest, result: polled.body.result } };
      if (polled.body.status === 'failed' || polled.body.status === 'cancelled') return { status: polled.status, body: polled.body };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`analyzeAndAwait: 202 폴링이 120초 안에 끝나지 않음(analysisRunId=${analysisRunId})`);
  }

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
  // 결과변수: 상병 업무관련성 high(=사건 true) / low(=false). 예측변수: BMI(키·몸무게)·재해일 기준 나이.
  // 사건 그룹의 몸무게가 평균적으로 크지만 분포가 겹쳐 완전 분리(separation)는 생기지 않는다.
  function payload(i: number, event: boolean, withPredictors: boolean) {
    const weight = event ? 66 + ((i * 5) % 22) : 58 + ((i * 5) % 22);
    const birthYear = 1960 + ((i * 7) % 25);
    return {
      data: {
        shared: {
          birthDate: `${birthYear}-03-15`,
          injuryDate: '2020-06-01',
          ...(withPredictors ? { height: '170', weight: String(weight) } : {}),
          diagnoses: [{
            id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', confirmedRight: 'confirmed',
            assessmentRight: event ? 'high' : 'low',
          }],
          jobs: [],
        },
        modules: {},
        activeModules: ['knee'],
      },
    };
  }
  async function seed(spec: { events: number; nonEvents: number; excluded?: number }): Promise<void> {
    for (let i = 0; i < spec.events; i += 1) await insertPatient(payload(i, true, true), `pred-event-${i}-${crypto.randomUUID()}`);
    for (let i = 0; i < spec.nonEvents; i += 1) await insertPatient(payload(i, false, true), `pred-non-${i}-${crypto.randomUUID()}`);
    // 결과는 있지만 예측변수(BMI)가 결측 — 완전사례에서 제외되는 소수(3명)다.
    for (let i = 0; i < (spec.excluded ?? 0); i += 1) await insertPatient(payload(i, i % 2 === 0, false), `pred-excl-${i}-${crypto.randomUUID()}`);
  }

  const OUTCOME_KEY = 'diagnosis.rollup.anyHighRelatedness';
  const BODY = {
    grain: 'case', filters: [], analysisPurpose: 'prediction', formulaPolicies: {},
    analysisMode: 'prediction', requestedMethod: 'l2_logistic',
    variableKeys: [OUTCOME_KEY, 'patient.identity.bmi', 'patient.identity.ageAtInjury'],
    prediction: { outcomeKey: OUTCOME_KEY, eventLevel: 'true' },
  };
  const STUB = { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' };

  async function runRow(analysisRunId: string) {
    return (await pool.query<{
      result: any; limited_result: any; frozen_dataset: unknown; requested_disclosure_profile: string; cacheable: boolean;
    }>(
      `SELECT result, limited_result, frozen_dataset, requested_disclosure_profile, cacheable FROM stats_runs WHERE analysis_run_id=$1`,
      [analysisRunId],
    )).rows[0];
  }

  // ---------------------------------------------------------------------------
  // 핵심 시나리오: 사건 35·비사건 35 완전사례 + 예측변수 결측 제외 3명 — 제외 집합이 소수 셀이라 예측 전체가 억제된다.
  // ---------------------------------------------------------------------------
  it('결측 제외 3명: 비권한자는 억제 스텁, 권한자는 워커가 만든 해제본으로 실제 성능 지표가 나온다. 해제본은 limited_result에만 있다', async () => {
    await seed({ events: 35, nonEvents: 35, excluded: 3 });

    const plain = await post(owner, 'analyze', BODY);
    expect(plain.status).toBe(200);
    expect(plain.body.result.prediction).toEqual(STUB);
    expect(plain.body.result.limitedDisclosure).toBeUndefined();

    await grant();
    const lifted = await analyzeAndAwait(owner, BODY);
    expect(lifted.status).toBe(200);
    expect(lifted.body.result.limitedDisclosure).toBe('applied');
    const prediction = lifted.body.result.prediction;
    expect(prediction.suppressed).toBe(false);
    expect(prediction.estimation).toBe('ok');
    expect(prediction.personCount).toBe(70);
    expect(prediction.eventPersonCount).toBe(35);
    const auc = prediction.metrics.find((m: { metric: string }) => m.metric === 'roc_auc');
    expect(Number.isFinite(auc.apparent)).toBe(true);
    expect(Array.isArray(prediction.curves.bins)).toBe(true);

    // 저장 구조: 일반본(result)은 억제 스텁 그대로, 해제본은 limited_result에만 있고, 원본 행(frozen_dataset)은 지워진다.
    const row = await runRow(lifted.body.runManifest.analysisRunId);
    expect(row.requested_disclosure_profile).toBe('lift_eligible');
    expect(row.frozen_dataset).toBeNull();
    expect(row.cacheable).toBe(true);
    expect(row.result.prediction).toEqual(STUB);
    expect(JSON.stringify(row.result)).not.toContain('roc_auc');
    expect(row.limited_result.prediction.estimation).toBe('ok');
  }, 240000);

  it('같은 실행 재조회(GET)는 조회자의 현재 권한으로 표시본을 고른다 — 권한자 해제 / 비권한 admin 일반본 / 회수 후 일반본. CSV에는 해제본이 없다', async () => {
    await seed({ events: 35, nonEvents: 35, excluded: 3 });
    await grant();
    const lifted = await analyzeAndAwait(owner, BODY);
    expect(lifted.body.result.limitedDisclosure).toBe('applied');
    const id = lifted.body.runManifest.analysisRunId;

    const viaOwner = await get(owner, `runs/${id}`);
    expect(viaOwner.body.result.limitedDisclosure).toBe('applied');
    expect(viaOwner.body.result.prediction.estimation).toBe('ok');

    const viaAdmin = await get(adminNoCap, `runs/${id}`);
    expect(viaAdmin.status).toBe(200);
    expect(viaAdmin.body.result.limitedDisclosure).toBeUndefined();
    expect(viaAdmin.body.result.prediction).toEqual(STUB);
    expect(JSON.stringify(viaAdmin.body)).not.toContain('roc_auc');

    // CSV 내보내기는 집계본(result)만 읽는다 — 해제 적격 실행이어도 지표가 나가지 않는다.
    const exported = await post(owner, 'export', { analysisRunId: id });
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain('roc_auc');

    await revoke();
    const afterRevoke = await get(owner, `runs/${id}`);
    expect(afterRevoke.body.result.limitedDisclosure).toBeUndefined();
    expect(afterRevoke.body.result.prediction).toEqual(STUB);
  }, 240000);

  // ---------------------------------------------------------------------------
  // 공개 제한과 계산 가능 조건의 분리 — 사건이 1~9명이면 "억제"가 아니라 계산 불가 사유로 바뀐다.
  // ---------------------------------------------------------------------------
  it('사건 8명: 비권한자는 억제 스텁, 권한자는 "사건/비사건 인원 부족" 계산 불가 사유를 본다(통계 조건은 풀리지 않는다)', async () => {
    await seed({ events: 8, nonEvents: 62 });
    const previewBody = { ...BODY, requestedMethod: undefined };

    const plainPreview = await post(owner, 'preview', previewBody);
    expect(plainPreview.body.counts.suppressed).toBe(true);
    expect(plainPreview.body.limitedDisclosure).toBeUndefined();
    expect((await post(owner, 'analyze', BODY)).body.result.prediction).toEqual(STUB);

    await grant();
    const liftedPreview = await post(owner, 'preview', previewBody);
    expect(liftedPreview.body.limitedDisclosure).toBe('applied');
    expect(liftedPreview.body.counts).toMatchObject({ suppressed: false, personCount: 70 });
    expect(liftedPreview.body.availableMethods.find((m: { id: string }) => m.id === 'l2_logistic')).toMatchObject({ status: 'available' });
    expect((await post(adminNoCap, 'preview', previewBody)).body.counts.suppressed).toBe(true);

    const lifted = await analyzeAndAwait(owner, BODY);
    expect(lifted.body.result.limitedDisclosure).toBe('applied');
    expect(lifted.body.result.prediction).toMatchObject({
      suppressed: false, estimation: 'non_estimable', nonEstimableReason: 'INSUFFICIENT_EVENT_PERSONS',
      eventPersonCount: 8, metrics: [], curves: null, coefficients: null,
    });
    // 저장된 일반본에는 사건 수 같은 수치가 없다.
    const row = await runRow(lifted.body.runManifest.analysisRunId);
    expect(row.result.prediction).toEqual(STUB);
  }, 240000);

  it('권한 없이 만든 실행은 해제본이 없어 나중에 권한을 받아도 같은 ID로는 풀리지 않고, 재실행하면 새 실행이 해제본을 만든다', async () => {
    await seed({ events: 8, nonEvents: 62 });
    const plain = await analyzeAndAwait(owner, BODY);
    const plainId = plain.body.runManifest.analysisRunId;
    expect(plain.body.result.prediction).toEqual(STUB);

    await grant();
    const viaGet = await get(owner, `runs/${plainId}`);
    expect(viaGet.body.result.prediction).toEqual(STUB);
    expect(viaGet.body.result.limitedDisclosure).toBe('unavailable_source_missing');

    const rerun = await analyzeAndAwait(owner, BODY);
    expect(rerun.body.runManifest.analysisRunId).not.toBe(plainId);
    expect(rerun.body.result.limitedDisclosure).toBe('applied');
  }, 240000);

  // Codex 리뷰 지적 — 해제 적격으로 접수한 뒤 워커가 시작되기 전에 권한이 회수되면, 일반 컨텍스트는 공개통제가 닫혀 predictionState가
  // 없다. 워커가 그 컨텍스트로 엔진 단계를 부르면 예외가 나 정상적인 억제 스텁 대신 PROCESS_ERROR로 종결됐다.
  it('접수 뒤 워커 시작 전에 권한이 회수되면 failed가 아니라 일반 억제 스텁으로 종결되고 해제본·캐시는 남지 않는다', async () => {
    await seed({ events: 35, nonEvents: 35, excluded: 3 });
    await grant();
    worker.stop(); // 접수된 행을 자동으로 처리하지 못하게 워커를 멈추고, 아래에서 수동으로 한 번만 실행한다.
    try {
      const queued = await post(owner, 'analyze', BODY);
      expect(queued.status).toBe(202); // 워커가 없으니 대기 상태로 남는다
      const analysisRunId = queued.body.analysisRunId;
      expect((await runRow(analysisRunId)).requested_disclosure_profile).toBe('lift_eligible');

      await revoke(); // 접수 후 워커 시작 전에 회수
      const claimed = await claimNextQueuedRun(pool, 600000);
      expect(claimed?.analysis_run_id).toBe(analysisRunId);
      await attempt(pool, claimed!);

      const row = (await pool.query<{ status: string; error_code: string | null; cacheable: boolean }>(
        `SELECT status, error_code, cacheable FROM stats_runs WHERE analysis_run_id=$1`, [analysisRunId],
      )).rows[0];
      expect(row.status).toBe('succeeded');
      expect(row.error_code).toBeNull();
      expect(row.cacheable).toBe(false); // 해제본 없는 적격 행은 캐시에 남지 않는다
      const stored = await runRow(analysisRunId);
      expect(stored.result.prediction).toEqual(STUB);
      expect(stored.limited_result).toBeNull();
    } finally {
      worker = createStatsRunsQueueWorker(pool);
    }
  }, 240000);

  it('differencing(forceSuppress)이면 권한자도 해제 적격이 아니다 — 기존 억제 경로 그대로이고 해제본이 만들어지지 않는다', async () => {
    await seed({ events: 8, nonEvents: 62 });
    await grant();
    const body = (day: number) => ({
      ...BODY,
      filters: [{ key: 'case.meta.registeredAt', operator: 'gte', value: `2000-01-${String(day).padStart(2, '0')}` }],
    });
    for (let day = 1; day <= 10; day += 1) {
      expect((await post(owner, 'preview', { ...body(day), requestedMethod: undefined })).status).toBe(200);
    }
    const res = await post(owner, 'analyze', body(11));
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBeUndefined();
    expect(res.body.result.prediction).toEqual(STUB);
    const row = await runRow(res.body.runManifest.analysisRunId);
    expect(row.requested_disclosure_profile).toBe('aggregate');
    expect(row.limited_result).toBeNull();
  }, 240000);
});

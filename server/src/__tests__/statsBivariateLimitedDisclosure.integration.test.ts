// 제한데이터(stats.export_limited_rows) 권한자의 이변량 소수 셀(1~9명) 제한 해제 — 실제 Postgres + 실제 Python +
// 실제 워커로 HTTP 경로 전체를 증명한다(statsRegressionLimitedDisclosure.integration.test.ts와 같은 방식).
// 핵심 검증: (1) 소수 그룹(5명)이라 엔진도 못 돌고 억제되던 그룹 비교가 권한자에게는 그룹별 n과 함께 풀린다,
// (2) 결측 제외 3명이라 쌍 전체가 억제되던 분석이 풀린다, (3) 해제본은 stats_runs.result(캐시)에 저장되지 않는다,
// (4) 회수·접근 제어, (5) 미리보기도 해제 기준이라 실행 버튼이 열린다.
//
//   TEST_DATABASE_URL=postgres://wr_user:<PW>@localhost:5432/wr_test \
//     npx vitest run --config vitest.config.ts --no-file-parallelism src/__tests__/statsBivariateLimitedDisclosure.integration.test.ts
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
const CSRF_TOKEN = 'itest-bi-limited-csrf';
const CAP = 'stats.export_limited_rows';

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

describe.skipIf(!TEST_DB_URL)('이변량 제한 해제 — HTTP 통합 (실제 Postgres+Python+워커)', () => {
  let pool: Pool;
  let orgId: string;
  let owner: TestUser;      // 해제 대상 사용자(권한 grant/revoke를 반복)
  let adminNoCap: TestUser; // 같은 조직의 admin(제한데이터 권한 없음)
  let worker: { stop: () => void };
  const createdUserIds: string[] = [];

  async function createUser(org: string, role: 'doctor' | 'admin', name: string): Promise<TestUser> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [`__test_bilimited_${role}_${crypto.randomUUID()}__`, 'x', name, role, org],
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
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, ['__test_bilimited_org__'])).rows[0].id;
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

  // 큐 워커가 도는 일반 실행은 200 또는 202(+폴링)로 끝난다 — 둘 다 같은 shape로 맞춘다.
  async function analyzeAndAwait(user: TestUser, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const res = await post(user, 'analyze', body);
    if (res.status !== 202) return res;
    const analysisRunId = res.body.analysisRunId;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const polled = await get(user, `runs/${analysisRunId}`);
      if (polled.body.status === 'succeeded') return { status: 200, body: { runManifest: polled.body.runManifest, result: polled.body.result } };
      if (polled.body.status === 'failed' || polled.body.status === 'cancelled') return { status: polled.status, body: polled.body };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`analyzeAndAwait: 202 폴링이 30초 안에 끝나지 않음(analysisRunId=${analysisRunId})`);
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
  // shoulder 초과 여부별 인원 수를 주면 완전사례 환자를 만든다. 초과 그룹의 knee burden이 더 커서 그룹 평균이 다르다.
  async function seedGroup(exceeded: boolean, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const bin = exceeded ? (i % 2 === 0 ? 'highMid' : 'high') : (i % 2 === 0 ? 'low' : 'lowMid');
      await insertPatient({
        data: {
          shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [SHOULDER_JOB] },
          modules: { shoulder: shoulderModule(exceeded), knee: kneeModule(bin) },
          activeModules: ['shoulder', 'knee'],
        },
      }, `bi-${exceeded}-${i}-${crypto.randomUUID()}`);
    }
  }
  // 두 변수가 모두 결측인 인원 — 쌍 완전사례에서 제외된다.
  async function seedMissing(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await insertPatient(
        { data: { shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [] }, modules: {}, activeModules: [] } },
        `bi-missing-${i}-${crypto.randomUUID()}`,
      );
    }
  }

  const GROUP_KEY = 'shoulder.exposure.anyExceeded';
  const VALUE_KEY = 'knee.relatedness.max';
  const BODY = {
    grain: 'case', filters: [], analysisPurpose: 'association',
    variableKeys: [GROUP_KEY, VALUE_KEY],
    formulaPolicies: { [GROUP_KEY]: 'recompute_current', [VALUE_KEY]: 'recompute_current' },
    analysisMode: 'bivariate', requestedMethod: 'welch_t',
  };

  async function runRow(analysisRunId: string) {
    return (await pool.query<{ result: unknown; frozen_dataset: unknown }>(
      `SELECT result, frozen_dataset FROM stats_runs WHERE analysis_run_id=$1`, [analysisRunId],
    )).rows[0];
  }

  // ---------------------------------------------------------------------------
  // 소수 그룹(5명) — 쌍 게이트는 통과하지만 B-1이 엔진 호출 전에 억제한다.
  // ---------------------------------------------------------------------------
  it('소수 그룹(5명): 비권한자는 억제, 권한자는 같은 캐시 실행에서 그룹별 n까지 풀린다. 저장된 캐시는 억제 그대로다', async () => {
    await seedGroup(false, 30);
    await seedGroup(true, 5);

    const plain = await analyzeAndAwait(owner, BODY);
    expect(plain.status).toBe(200);
    expect(plain.body.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });
    expect(plain.body.result.limitedDisclosure).toBeUndefined();

    await grant();
    const res = await analyzeAndAwait(owner, BODY); // 같은 캐시 실행 + 최신 권한
    expect(res.status).toBe(200);
    expect(res.body.runManifest.analysisRunId).toBe(plain.body.runManifest.analysisRunId);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    const bivariate = res.body.result.bivariate;
    expect(bivariate.suppressed).toBe(false);
    expect(bivariate.n).toBe(35);
    expect(Number.isFinite(bivariate.statistic)).toBe(true);
    const sizes = bivariate.groupBreakdown.map((g: { label: boolean; n: number }) => [g.label, g.n]);
    expect(sizes).toEqual([[false, 30], [true, 5]]); // 5명 그룹이 그대로 보인다

    // 저장된 캐시는 억제 스텁 그대로(해제 수치·플래그 없음) — 비권한 admin이 읽어도 새지 않는다.
    const id = plain.body.runManifest.analysisRunId;
    const stored = JSON.stringify((await runRow(id)).result);
    expect(stored).not.toContain('groupBreakdown');
    expect(stored).not.toContain('limitedDisclosure');
    const viaAdmin = await get(adminNoCap, `runs/${id}`);
    expect(viaAdmin.body.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });
    expect(viaAdmin.body.result.limitedDisclosure).toBeUndefined();

    // 같은 실행 재조회(GET)도 해제 유지, 회수하면 스텁으로 복귀
    const viaGet = await get(owner, `runs/${id}`);
    expect(viaGet.body.result.limitedDisclosure).toBe('applied');
    expect(viaGet.body.result.bivariate.groupBreakdown).toHaveLength(2);
    await revoke();
    const afterRevoke = await get(owner, `runs/${id}`);
    expect(afterRevoke.body.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });
    expect(afterRevoke.body.result.limitedDisclosure).toBeUndefined();
  }, 90000);

  // ---------------------------------------------------------------------------
  // 결측 제외 3명 — 쌍 게이트(레이어1)가 닫혀 조기 억제 경로를 탄다.
  // ---------------------------------------------------------------------------
  it('결측 제외 3명: 미리보기 방법 목록이 비어 있던 쌍 전체 억제가 권한자에게는 풀리고, 분석 결과도 완전사례 기준으로 나온다', async () => {
    await seedGroup(false, 20);
    await seedGroup(true, 20);
    await seedMissing(3);
    const previewBody = { ...BODY, requestedMethod: undefined };

    const plainPreview = await post(owner, 'preview', previewBody);
    expect(plainPreview.status).toBe(200);
    expect(plainPreview.body.availableMethods).toEqual([]); // 쌍 게이트가 닫혀 방법 목록 자체가 없다
    expect(plainPreview.body.limitedDisclosure).toBeUndefined();

    const plain = await post(owner, 'analyze', BODY);
    expect(plain.status).toBe(200);
    expect(plain.body.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });

    await grant();
    const liftedPreview = await post(owner, 'preview', previewBody);
    expect(liftedPreview.body.limitedDisclosure).toBe('applied');
    expect(liftedPreview.body.availableMethods.find((m: { id: string }) => m.id === 'welch_t')).toMatchObject({ status: 'available' });
    const adminPreview = await post(adminNoCap, 'preview', previewBody);
    expect(adminPreview.body.availableMethods).toEqual([]);

    const res = await post(owner, 'analyze', BODY);
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    expect(res.body.result.bivariate.suppressed).toBe(false);
    expect(res.body.result.bivariate.n).toBe(40);
    expect(res.body.result.bivariate.excludedCaseCount).toBe(3);
    // 제외 사유 상세도 풀린다(3명 = 소수 셀이라 제한 모드에서는 null이었을 값)
    expect(res.body.result.bivariate.exclusions).toEqual([{ reasonCode: 'both_missing', count: 3 }]);

    // 원본이 저장돼(권한자 조기 억제) 같은 ID GET에서도 해제가 유지되고, 비권한 admin에게는 스텁이다.
    const id = res.body.runManifest.analysisRunId;
    expect((await runRow(id)).frozen_dataset).not.toBeNull();
    expect((await get(owner, `runs/${id}`)).body.result.limitedDisclosure).toBe('applied');
    expect((await get(adminNoCap, `runs/${id}`)).body.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });
  }, 90000);

  it('권한 없이 만든 조기 억제 실행은 원본이 없어, 나중에 권한을 받아도 같은 ID로는 풀리지 않고 재실행 안내가 나온다', async () => {
    await seedGroup(false, 20);
    await seedGroup(true, 20);
    await seedMissing(3);
    const plain = await post(owner, 'analyze', BODY);
    const id = plain.body.runManifest.analysisRunId;
    expect((await runRow(id)).frozen_dataset).toBeNull();

    await grant();
    const viaGet = await get(owner, `runs/${id}`);
    expect(viaGet.body.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });
    expect(viaGet.body.result.limitedDisclosure).toBe('unavailable_source_missing');
    expect((await post(owner, 'analyze', BODY)).body.result.limitedDisclosure).toBe('applied'); // 재실행하면 풀린다
  }, 90000);

  it('차분(differencing) 제한은 권한자도 풀리지 않는다 — 원본이 저장되지 않고 미리보기도 억제 그대로다', async () => {
    await seedGroup(false, 20);
    await seedGroup(true, 20);
    await seedMissing(3);
    await grant();
    const body = (day: number) => ({
      ...BODY,
      filters: [{ key: 'case.meta.registeredAt', operator: 'gte', value: `2000-01-${String(day).padStart(2, '0')}` }],
    });
    for (let day = 1; day <= 10; day += 1) {
      expect((await post(owner, 'preview', { ...body(day), requestedMethod: undefined })).status).toBe(200);
    }
    const lastPreview = await post(owner, 'preview', { ...body(11), requestedMethod: undefined });
    expect(lastPreview.body.counts.reasonCode).toBe('DIFFERENCING_RATE_LIMIT');
    expect(lastPreview.body.limitedDisclosure).toBeUndefined();
    expect(lastPreview.body.availableMethods).toEqual([]);

    const res = await post(owner, 'analyze', body(11));
    expect(res.body.result.limitedDisclosure).toBeUndefined();
    expect(res.body.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });
    expect((await runRow(res.body.runManifest.analysisRunId)).frozen_dataset).toBeNull();
  }, 120000);
});

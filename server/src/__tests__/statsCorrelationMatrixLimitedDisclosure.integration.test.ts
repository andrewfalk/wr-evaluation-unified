// 제한데이터(stats.export_limited_rows) 권한자의 상관행렬 소수 셀(1~9명) 제한 해제 — 실제 Postgres + 실제 Python +
// 실제 워커로 HTTP 경로 전체를 증명한다. 상관행렬은 성공 직후 원본 행(frozen_dataset)을 지우므로 기술통계·회귀·이변량처럼
// 조회 때 재계산할 수 없다 — 권한자가 "실행"하면 워커가 엔진을 한 번 돌려 일반본(result)과 해제본(limited_result)을
// 함께 저장하고, 조회는 조회자의 현재 권한으로 표시본을 고른다.
// 핵심 검증: (1) 해제본은 limited_result에만 있고 result(캐시)·일반 응답·비권한 admin·CSV에는 없다,
// (2) 권한자 실행과 비권한자 실행은 캐시가 섞이지 않는다, (3) 회수·재조회·재실행, (4) 해제본 없는 적격 캐시 고착 방지.
//
//   TEST_DATABASE_URL=postgres://wr_user:<PW>@localhost:5432/wr_test \
//     npx vitest run --config vitest.config.ts --no-file-parallelism src/__tests__/statsCorrelationMatrixLimitedDisclosure.integration.test.ts
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
import { createStatsRunsQueueWorker, finishRun } from '../statsRunsQueue';
import { buildPendingStatsRunManifest } from '../statsRunManifest';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';
import { __resetDifferencingGuardForTests } from '../statsDifferencingGuard';
import { __resetLimitedDisclosureGuardForTests } from '../statsLimitedDisclosureGuard';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-corr-limited-csrf';
const CAP = 'stats.export_limited_rows';

const JOBS = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }];
const KNEE_BURDEN_BINS = {
  low: [500, 10] as const, lowMid: [500, 90] as const, highMid: [3500, 90] as const, high: [3500, 130] as const,
};
const KNEE_BIN_ORDER: Array<keyof typeof KNEE_BURDEN_BINS> = ['low', 'lowMid', 'highMid', 'high'];

interface TestUser { id: string; token: string }

describe.skipIf(!TEST_DB_URL)('상관행렬 제한 해제 — HTTP 통합 (실제 Postgres+Python+워커)', () => {
  let pool: Pool;
  let orgId: string;
  let owner: TestUser;      // 해제 대상 사용자(권한 grant/revoke를 반복)
  let adminNoCap: TestUser; // 같은 조직의 admin(제한데이터 권한 없음)
  let worker: { stop: () => void };
  const createdUserIds: string[] = [];

  async function createUser(org: string, role: 'doctor' | 'admin', name: string): Promise<TestUser> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [`__test_corrlimited_${role}_${crypto.randomUUID()}__`, 'x', name, role, org],
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
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, ['__test_corrlimited_org__'])).rows[0].id;
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

  // 큐 워커가 도는 실행은 200 또는 202(+폴링)로 끝난다 — 둘 다 같은 shape로 맞춘다.
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
  const kneeModule = (i: number) => {
    const [weight, squatting] = KNEE_BURDEN_BINS[KNEE_BIN_ORDER[i % KNEE_BIN_ORDER.length]];
    return { jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: String(weight), squatting: String(squatting) }], jobExtras: [] };
  };
  // 세 변수(knee/cervical/spine)가 모두 있는 완전사례.
  function fullPayload(i: number) {
    return {
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: JOBS, diagnoses: [] },
        modules: {
          knee: kneeModule(i),
          spine: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [{ sharedJobId: 'job-1', name: '중량물 취급', posture: 'G3', weight: 35 + i * 3, frequency: 80, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.0 }] },
          cervical: { tasks: [{ id: `task-${i}`, sharedJobId: 'job-1', name: '박스 운반', exposure_types: ['shoulder_heavy_load'], load_weight_kg: String(10 + i * 4), carry_hours_per_shift: '2', forced_neck_posture: 'yes' }] },
        },
        activeModules: ['knee', 'spine', 'cervical'],
      },
    };
  }
  // knee만 있고 spine·cervical은 결측인 인원 — 모든 쌍에서 제외 인원이 된다.
  function kneeOnlyPayload(i: number) {
    return {
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: JOBS, diagnoses: [] },
        modules: { knee: kneeModule(i) },
        activeModules: ['knee'],
      },
    };
  }
  async function seedFull(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await insertPatient(fullPayload(i), `corr-full-${i}-${crypto.randomUUID()}`);
  }
  async function seedKneeOnly(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await insertPatient(kneeOnlyPayload(i), `corr-kneeonly-${i}-${crypto.randomUUID()}`);
  }

  const VARIABLE_KEYS = ['knee.relatedness.max', 'cervical.case.maxJobCumulativeKgHours', 'spine.mddm.lifetimeDoseMNh'];
  const BODY = {
    grain: 'case', filters: [], analysisPurpose: 'association',
    formulaPolicies: { spine_mddm: 'recompute_current' }, analysisMode: 'correlation_matrix',
    requestedMethod: 'pearson_correlation', variableKeys: VARIABLE_KEYS,
  };

  async function runRow(analysisRunId: string) {
    return (await pool.query<{
      result: unknown; limited_result: unknown; frozen_dataset: unknown; requested_disclosure_profile: string; cacheable: boolean;
    }>(
      `SELECT result, limited_result, frozen_dataset, requested_disclosure_profile, cacheable FROM stats_runs WHERE analysis_run_id=$1`,
      [analysisRunId],
    )).rows[0];
  }
  const allSuppressed = (res: any) => res.cells.every((c: { suppressed: boolean }) => c.suppressed);

  // ---------------------------------------------------------------------------
  // 핵심 시나리오: 완전사례 40명 + 결측 제외 3명 — 제외 3명이 소수 셀이라 모든 쌍이 억제된다.
  // ---------------------------------------------------------------------------
  it('결측 제외 3명: 비권한자는 전 쌍 억제, 권한자는 워커가 만든 해제본으로 전 쌍 공개된다. 해제본은 limited_result에만 있다', async () => {
    await seedFull(40);
    await seedKneeOnly(3);

    const plain = await analyzeAndAwait(owner, BODY);
    expect(plain.status).toBe(200);
    expect(plain.body.result.limitedDisclosure).toBeUndefined();
    expect(allSuppressed(plain.body.result.correlationMatrix)).toBe(true);
    expect(plain.body.result.correlationMatrix.adjustedPWithheld).toBe(true);
    // 일반 응답의 억제 셀에는 사유가 붙지 않는다(소수 인원인지 통계 불가인지 구분되지 않아야 한다).
    expect(plain.body.result.correlationMatrix.cells.some((c: { reasonCode?: string }) => c.reasonCode !== undefined)).toBe(false);

    await grant();
    const lifted = await analyzeAndAwait(owner, BODY);
    expect(lifted.status).toBe(200);
    expect(lifted.body.runManifest.analysisRunId).not.toBe(plain.body.runManifest.analysisRunId); // 캐시가 섞이지 않는다
    expect(lifted.body.result.limitedDisclosure).toBe('applied');
    const matrix = lifted.body.result.correlationMatrix;
    expect(matrix.cells).toHaveLength(3);
    for (const cell of matrix.cells) {
      expect(cell.suppressed).toBe(false);
      expect(cell.n).toBe(40);
      expect(Number.isFinite(cell.r)).toBe(true);
    }
    expect(matrix.adjustedPWithheld).toBe(false);

    // 저장 구조: 일반본(result)은 전 쌍 억제 그대로, 해제본은 limited_result에만 있고, 원본 행(frozen_dataset)은 지워진다.
    const row = await runRow(lifted.body.runManifest.analysisRunId);
    expect(row.requested_disclosure_profile).toBe('lift_eligible');
    expect(row.frozen_dataset).toBeNull();
    expect(row.cacheable).toBe(true);
    expect(allSuppressed((row.result as any).correlationMatrix)).toBe(true);
    expect(JSON.stringify(row.result)).not.toContain('"r"');
    expect((row.limited_result as any).correlationMatrix.cells.every((c: { suppressed: boolean }) => !c.suppressed)).toBe(true);

    // 비권한 일반 실행 행에는 해제본이 없다.
    const plainRow = await runRow(plain.body.runManifest.analysisRunId);
    expect(plainRow.requested_disclosure_profile).toBe('aggregate');
    expect(plainRow.limited_result).toBeNull();
  }, 120000);

  it('같은 실행 재조회(GET)는 조회자의 현재 권한으로 표시본을 고른다 — 권한자 해제 / 비권한 admin 일반본 / 회수 후 일반본', async () => {
    await seedFull(40);
    await seedKneeOnly(3);
    await grant();
    const lifted = await analyzeAndAwait(owner, BODY);
    expect(lifted.body.result.limitedDisclosure).toBe('applied');
    const id = lifted.body.runManifest.analysisRunId;

    const viaOwner = await get(owner, `runs/${id}`);
    expect(viaOwner.status).toBe(200);
    expect(viaOwner.body.result.limitedDisclosure).toBe('applied');
    expect(viaOwner.body.result.correlationMatrix.cells.every((c: { suppressed: boolean }) => !c.suppressed)).toBe(true);

    // 같은 조직의 권한 없는 admin은 일반본만 본다 — 해제 수치가 새지 않는다.
    const viaAdmin = await get(adminNoCap, `runs/${id}`);
    expect(viaAdmin.status).toBe(200);
    expect(viaAdmin.body.result.limitedDisclosure).toBeUndefined();
    expect(allSuppressed(viaAdmin.body.result.correlationMatrix)).toBe(true);
    expect(JSON.stringify(viaAdmin.body)).not.toContain('"r"');

    await revoke();
    const afterRevoke = await get(owner, `runs/${id}`);
    expect(afterRevoke.body.result.limitedDisclosure).toBeUndefined();
    expect(allSuppressed(afterRevoke.body.result.correlationMatrix)).toBe(true);
    expect(JSON.stringify(afterRevoke.body)).not.toContain('"r"');

    // 해제본을 내보낸 시점마다 strict 감사가 남는다(권한자 조회 1회 = 감사 1건 이상).
    const audits = await pool.query(
      `SELECT 1 FROM audit_logs WHERE actor_org_id=$1 AND action='stats_analyze'
         AND extra->>'analysisRunId'=$2 AND extra->>'smallCellLimitStatus'='applied' AND extra->>'limitedDisclosureSource'='stored'`,
      [orgId, id],
    );
    expect(audits.rows.length).toBeGreaterThanOrEqual(2); // 실행 응답 + GET
  }, 120000);

  it('권한 없이 만든 실행은 해제본이 없어 나중에 권한을 받아도 같은 ID로는 풀리지 않고, 재실행하면 새 실행이 해제본을 만든다', async () => {
    await seedFull(40);
    await seedKneeOnly(3);
    const plain = await analyzeAndAwait(owner, BODY);
    const plainId = plain.body.runManifest.analysisRunId;

    await grant();
    const viaGet = await get(owner, `runs/${plainId}`);
    expect(allSuppressed(viaGet.body.result.correlationMatrix)).toBe(true);
    expect(viaGet.body.result.limitedDisclosure).toBe('unavailable_source_missing');

    const rerun = await analyzeAndAwait(owner, BODY);
    expect(rerun.body.runManifest.analysisRunId).not.toBe(plainId);
    expect(rerun.body.result.limitedDisclosure).toBe('applied');
  }, 120000);

  it('같은 권한자의 재요청은 해제본이 있는 적격 캐시에 적중한다(엔진을 다시 돌리지 않는다)', async () => {
    await seedFull(40);
    await seedKneeOnly(3);
    await grant();
    const first = await analyzeAndAwait(owner, BODY);
    const second = await post(owner, 'analyze', BODY);
    expect(second.status).toBe(200); // 캐시 적중은 즉시 200
    expect(second.body.runManifest.analysisRunId).toBe(first.body.runManifest.analysisRunId);
    expect(second.body.result.limitedDisclosure).toBe('applied');
    expect((await pool.query(`SELECT 1 FROM stats_runs WHERE organization_id=$1`, [orgId])).rows).toHaveLength(1);
  }, 120000);

  it('전체 N<10: 일반본은 전체 억제 스텁, 권한자는 해제본으로 5명 기준 상관이 풀린다(워커가 일반본 요청 수준 판정을 다시 한다)', async () => {
    await seedFull(5);
    const previewBody = { ...BODY, requestedMethod: undefined };

    const plainPreview = await post(owner, 'preview', previewBody);
    expect(plainPreview.body.counts.suppressed).toBe(true);
    expect(plainPreview.body.limitedDisclosure).toBeUndefined();

    await grant();
    const liftedPreview = await post(owner, 'preview', previewBody);
    expect(liftedPreview.body.counts).toMatchObject({ suppressed: false, personCount: 5 });
    expect(liftedPreview.body.limitedDisclosure).toBe('applied');
    expect(liftedPreview.body.availableMethods.find((m: { id: string }) => m.id === 'pearson_correlation')).toMatchObject({ status: 'available' });
    expect((await post(adminNoCap, 'preview', previewBody)).body.counts.suppressed).toBe(true);

    const lifted = await analyzeAndAwait(owner, BODY);
    expect(lifted.body.result.limitedDisclosure).toBe('applied');
    // 5명이라는 이유(소수 셀)로만 막혀 있던 쌍은 풀린다. 이 fixture에서 cervical 변수는 5명으로는 통계적으로 계산할 수 없어
    // (엔진이 null) 해제본에서도 억제되지만, 일반 응답과 달리 그 이유가 셀에 붙는다 — "여전히 비공개"로 오해하지 않게 한다.
    const cells = lifted.body.result.correlationMatrix.cells as Array<{ suppressed: boolean; n?: number; yKey: string; reasonCode?: string }>;
    expect(cells.find((c) => !c.suppressed)).toMatchObject({ suppressed: false, n: 5 });
    const remaining = cells.filter((c) => c.suppressed);
    expect(remaining.length).toBeGreaterThan(0);
    for (const cell of remaining) expect(cell.reasonCode).toBe('NOT_COMPUTABLE');
    expect(lifted.body.result.correlationMatrix.adjustedPWithheld).toBe(true); // 남은 억제 셀이 있으면 보정값은 계속 비공개

    const row = await runRow(lifted.body.runManifest.analysisRunId);
    expect(allSuppressed((row.result as any).correlationMatrix)).toBe(true); // 저장된 일반본은 전체 억제 스텁
    expect(JSON.stringify(row.result)).not.toContain('"r"');
    expect((await get(adminNoCap, `runs/${lifted.body.runManifest.analysisRunId}`)).body.result.correlationMatrix.adjustedPWithheld).toBe(true);
  }, 120000);

  it('CSV 내보내기는 해제 적격 실행에서도 집계본 정책을 따른다 — 500이 아니라 기존 미지원 응답이고 해제본은 나가지 않는다', async () => {
    await seedFull(40);
    await seedKneeOnly(3);
    await grant();
    const lifted = await analyzeAndAwait(owner, BODY);
    const exported = await post(owner, 'export', { analysisRunId: lifted.body.runManifest.analysisRunId });
    expect(exported.status).toBe(400);
    expect(exported.body.code).toBe('CORRELATION_MATRIX_EXPORT_NOT_SUPPORTED');
    expect(JSON.stringify(exported.body)).not.toContain('"r"');
  }, 120000);

  it('differencing(forceSuppress)이면 권한자도 해제 적격이 아니다 — 기존 억제 경로 그대로이고 해제본이 만들어지지 않는다', async () => {
    await seedFull(5);
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
    expect(allSuppressed(res.body.result.correlationMatrix)).toBe(true);
    const row = await runRow(res.body.runManifest.analysisRunId);
    expect(row.requested_disclosure_profile).toBe('aggregate');
    expect(row.limited_result).toBeNull();
  }, 120000);

  // ---------------------------------------------------------------------------
  // 캐시 고착 방지(Codex 1회차 P2) — 해제본 없는 적격 행이 캐시로 남으면 같은 digest의 재요청이 계속 막힌다.
  // ---------------------------------------------------------------------------
  describe('해제본 없는 적격 행의 캐시 고착 방지', () => {
    async function insertRunningEligibleRow(): Promise<{ id: string; analysisRunId: string }> {
      const analysisRunId = crypto.randomUUID();
      const manifest = buildPendingStatsRunManifest({
        recipeDigest: 'rd-x', sourceDigest: 'sd-x', snapshotAsOf: new Date().toISOString(),
        formulaPolicies: {}, analysisMode: 'correlation_matrix', analysisRunId,
      });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
           requested_disclosure_profile, cacheable, manifest, started_at, heartbeat_at, expires_at, analysis_run_id)
         VALUES ($1,$2,'running','rd-x','sd-x',$3,'lift_eligible',true,$4, now(), now(), now() + interval '1 day', $5)
         RETURNING id`,
        [orgId, owner.id, `exec-${analysisRunId}`, JSON.stringify(manifest), analysisRunId],
      );
      return { id: rows[0].id, analysisRunId };
    }
    const resultStub = { continuous: [], discrete: [], correlationMatrix: { method: 'pearson_correlation', variableKeys: ['a', 'b', 'c'], cells: [], adjustedPWithheld: true } } as never;

    it('워커 시점에 권한이 회수돼 해제본 없이 끝난 적격 행은 cacheable=false로 종결된다', async () => {
      const { id, analysisRunId } = await insertRunningEligibleRow();
      expect(await finishRun(pool, id, { origin: 'computed', outcome: { kind: 'succeeded', result: resultStub } })).toBe('finalized');
      const row = await runRow(analysisRunId);
      expect(row.cacheable).toBe(false);
      expect(row.limited_result).toBeNull();
    });

    it('해제본과 함께 끝난 적격 행은 캐시 가능하고 해제본이 저장된다', async () => {
      const { id, analysisRunId } = await insertRunningEligibleRow();
      const limitedStub = { continuous: [], discrete: [], correlationMatrix: { method: 'pearson_correlation', variableKeys: ['a', 'b', 'c'], cells: [], adjustedPWithheld: false } } as never;
      expect(await finishRun(pool, id, { origin: 'computed', outcome: { kind: 'succeeded', result: resultStub, limitedResult: limitedStub } })).toBe('finalized');
      const row = await runRow(analysisRunId);
      expect(row.cacheable).toBe(true);
      expect(row.limited_result).toEqual(limitedStub);
    });

    it('실패·취소로 끝난 행은 해제본이 없다(CHECK: 해제본은 성공한 실행에만)', async () => {
      const { id, analysisRunId } = await insertRunningEligibleRow();
      expect(await finishRun(pool, id, { origin: 'computed', outcome: { kind: 'failed', errorCode: 'PROCESS_ERROR' } })).toBe('finalized');
      expect((await runRow(analysisRunId)).limited_result).toBeNull();
      await expect(
        pool.query(`UPDATE stats_runs SET limited_result='{}'::jsonb WHERE analysis_run_id=$1`, [analysisRunId]),
      ).rejects.toThrow(/stats_runs_limited_result_succeeded/);
    });

    it('admission 캐시 조회는 해제본이 없는 적격 행에 적중하지 않는다 — 새 실행이 만들어져 해제본을 받는다', async () => {
      await seedFull(40);
      await seedKneeOnly(3);
      await grant();
      const first = await analyzeAndAwait(owner, BODY);
      const firstId = first.body.runManifest.analysisRunId;
      // 해제본 없는 적격 캐시 행을 인위적으로 만든다(정상 경로로는 생기지 않는다 — 방어선 검증).
      await pool.query(`UPDATE stats_runs SET limited_result=NULL WHERE analysis_run_id=$1`, [firstId]);

      const again = await analyzeAndAwait(owner, BODY);
      expect(again.body.runManifest.analysisRunId).not.toBe(firstId); // 해제본 없는 행에 적중하지 않았다
      expect(again.body.result.limitedDisclosure).toBe('applied');
    }, 120000);
  });
});

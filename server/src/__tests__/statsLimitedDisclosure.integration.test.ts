// 제한데이터(stats.export_limited_rows) 권한자의 기술통계 소수 셀(1~9명) 제한 해제 — 실제
// Postgres + 실제 Python + 실제 워커로 HTTP 경로 전체를 증명한다(statsDescriptiveHttp.integration.test.ts와
// 같은 방식). 해제는 stats_runs.result(캐시)에 저장하지 않고 응답 시점에만 만든다는 설계 불변식,
// 접근 제어·감사·권한 회수·연결 중단·엔진 폴백이 핵심 검증 대상이다.
//
//   TEST_DATABASE_URL=postgres://wr_user:<PW>@localhost:5432/wr_test STATS_ENGINE_PYTHON=<venv>/bin/python \
//     npx vitest run --config vitest.config.ts src/__tests__/statsLimitedDisclosure.integration.test.ts
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
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
import { StatsEngineBusyError, StatsEngineCancelledError } from '../statsEngine';
import { __resetDifferencingGuardForTests } from '../statsDifferencingGuard';
import { __resetLimitedDisclosureGuardForTests } from '../statsLimitedDisclosureGuard';

// runStatsEngine은 기본적으로 실제 구현을 통과시킨다. 폴백·지연·취소 시나리오만 한 번씩 가로챈다.
type RunStatsEngineFn = typeof import('../statsEngine')['runStatsEngine'];
const runStatsEngineSpy = vi.fn(async (...args: Parameters<RunStatsEngineFn>) => {
  const actual = await vi.importActual<typeof import('../statsEngine')>('../statsEngine');
  return actual.runStatsEngine(...args);
});
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runStatsEngine: (...args: Parameters<typeof actual.runStatsEngine>) => runStatsEngineSpy(...args) };
});

type WriteAuditLogStrictFn = typeof import('../middleware/audit')['writeAuditLogStrict'];
const writeAuditLogStrictSpy = vi.fn(async (...args: Parameters<WriteAuditLogStrictFn>) => {
  const actual = await vi.importActual<typeof import('../middleware/audit')>('../middleware/audit');
  return actual.writeAuditLogStrict(...args);
});
vi.mock('../middleware/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/audit')>();
  return { ...actual, writeAuditLogStrict: (...args: Parameters<typeof actual.writeAuditLogStrict>) => writeAuditLogStrictSpy(...args) };
});

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-limited-csrf';
const CAP = 'stats.export_limited_rows';
const JOB_KEY = 'job.rollup.longestTenureJobNameNormalized';
const STAFF_KEY = 'case.staff.assignedDoctorUserId';

interface TestUser { id: string; token: string }

describe.skipIf(!TEST_DB_URL)('제한데이터 권한자 소수 셀 해제 — HTTP 통합 (실제 Postgres+Python+워커)', () => {
  let pool: Pool;
  let orgId: string;
  let otherOrgId: string;
  let owner: TestUser;       // 해제 대상 사용자(권한 grant/revoke를 반복)
  let otherDoctor: TestUser; // 같은 조직의 다른 일반 사용자
  let adminNoCap: TestUser;  // 같은 조직의 admin(제한데이터 권한 없음)
  let outsider: TestUser;    // 다른 조직 사용자
  let worker: { stop: () => void };
  const createdUserIds: string[] = [];

  async function createUser(org: string, role: 'doctor' | 'admin', name: string): Promise<TestUser> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [`__test_limited_${role}_${crypto.randomUUID()}__`, 'x', name, role, org],
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
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, ['__test_limited_org__'])).rows[0].id;
    otherOrgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, ['__test_limited_other_org__'])).rows[0].id;
    owner = await createUser(orgId, 'doctor', '소유자 의사');
    otherDoctor = await createUser(orgId, 'doctor', '다른 의사');
    adminNoCap = await createUser(orgId, 'admin', '관리자');
    outsider = await createUser(otherOrgId, 'doctor', '타 조직 의사');
  });

  afterAll(async () => {
    worker.stop();
    for (const org of [orgId, otherOrgId]) {
      await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [org]);
      await pool.query(`DELETE FROM user_capability_grants WHERE organization_id = $1`, [org]);
    }
    await pool.query(`DELETE FROM patient_records WHERE organization_id = ANY($1)`, [[orgId, otherOrgId]]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = ANY($1)`, [[orgId, otherOrgId]]);
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [createdUserIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    await pool.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgId, otherOrgId]]);
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
    runStatsEngineSpy.mockReset();
    runStatsEngineSpy.mockImplementation(async (...args: Parameters<RunStatsEngineFn>) => {
      const actual = await vi.importActual<typeof import('../statsEngine')>('../statsEngine');
      return actual.runStatsEngine(...args);
    });
    writeAuditLogStrictSpy.mockClear();
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
  // supertest 요청은 await/then 전에는 실행되지 않는 지연 객체다 — "먼저 시작해 두고 중간에 무언가 하는" 시나리오는
  // 이 함수로 즉시 시작해야 한다.
  const startPost = (user: TestUser, path: string, body: unknown) => {
    const pending = post(user, path, body);
    return new Promise<request.Response>((resolve, reject) => { pending.then(resolve, reject); });
  };
  const get = (user: TestUser, path: string) => as(user, request(app()).get(`/api/stats/${path}`));

  async function insertPatient(payload: unknown, name: string, assignedDoctorId: string | null = null): Promise<void> {
    const person = await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1,$2) RETURNING id`, [orgId, name],
    );
    await pool.query(
      `INSERT INTO patient_records (organization_id, owner_user_id, patient_person_id, name, revision, payload, assigned_doctor_user_id)
       VALUES ($1,$2,$3,$4,1,$5,$6)`,
      [orgId, owner.id, person.rows[0].id, name, payload, assignedDoctorId],
    );
  }
  const jobPayload = (jobName: string, idx: number) => ({
    data: { shared: { jobs: [{ id: `job-${jobName}-${idx}`, jobName, startDate: '2015-01-01', endDate: '2020-01-01' }] }, modules: {}, activeModules: [] },
  });
  const noJobPayload = () => ({ data: { shared: { jobs: [] }, modules: {}, activeModules: [] } });
  async function seedJobs(spec: Array<[string, number]>, assignedDoctorId: string | null = null): Promise<void> {
    for (const [name, count] of spec) {
      for (let i = 0; i < count; i += 1) await insertPatient(jobPayload(name, i), `job-${name}-${i}-${crypto.randomUUID()}`, assignedDoctorId);
    }
  }
  async function seedNoJob(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) await insertPatient(noJobPayload(), `nojob-${i}-${crypto.randomUUID()}`);
  }

  const RECIPE_BASE = { grain: 'case' as const, filters: [], analysisPurpose: 'association' as const, formulaPolicies: {} };
  const JOB_BODY = { ...RECIPE_BASE, variableKeys: [JOB_KEY], analysisMode: 'descriptive' };

  async function runRow(analysisRunId: string) {
    return (await pool.query<{ result: unknown; frozen_dataset: unknown }>(
      `SELECT result, frozen_dataset FROM stats_runs WHERE analysis_run_id=$1`, [analysisRunId],
    )).rows[0];
  }
  async function limitedAudits(analysisRunId: string) {
    return (await pool.query<{ extra: Record<string, unknown> }>(
      `SELECT extra FROM audit_logs WHERE actor_org_id=$1 AND action='stats_analyze'
         AND extra->>'analysisRunId'=$2 AND extra->>'smallCellLimitStatus' IS NOT NULL ORDER BY id`,
      [orgId, analysisRunId],
    )).rows.map((r) => r.extra);
  }

  // ---------------------------------------------------------------------------
  // 사용자가 겪은 핵심 시나리오: 값이 있는 인원은 충분한데 결측이 소수(2명)라 변수 전체가 비공개.
  // ---------------------------------------------------------------------------
  it('결측 2명 때문에 통째로 비공개였던 결과가 권한자에게는 결측 건수와 함께 공개되고, 비권한자는 그대로 비공개다', async () => {
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await seedNoJob(2);

    const plain = await post(owner, 'analyze', JOB_BODY);
    expect(plain.status).toBe(200);
    expect(plain.body.result.discrete[0].suppressed).toBe(true);
    expect(plain.body.result.limitedDisclosure).toBeUndefined();

    await grant();
    const res = await post(owner, 'analyze', JOB_BODY); // 같은 캐시 실행 + 최신 권한
    expect(res.status).toBe(200);
    expect(res.body.runManifest.analysisRunId).toBe(plain.body.runManifest.analysisRunId);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    const d = res.body.result.discrete[0];
    expect(d.suppressed).toBe(false);
    expect(d.n).toBe(50);
    expect(d.missingCount).toBe(2);
    expect(d.levels.map((l: { level: string; count: number }) => [l.level, l.count]).sort()).toEqual([['목수', 20], ['용접공', 30]]);

    // 저장된 캐시는 집계 그대로(해제 수치·플래그 없음)
    const stored = JSON.stringify((await runRow(plain.body.runManifest.analysisRunId)).result);
    expect(stored).not.toContain('limitedDisclosure');
    expect(stored).not.toContain('용접공');
  }, 40000);

  // ---------------------------------------------------------------------------
  // 담당의 층화 — 김호길·박완이 소수여도 개별 그룹으로 보인다.
  // ---------------------------------------------------------------------------
  it('담당의 층화: 소수 담당의가 "기타"로 숨는 대신 이름 그룹으로 공개되고 전체 열도 공개된다(비권한자는 억제)', async () => {
    const docA = await createUser(orgId, 'doctor', '김호길');
    const docB = await createUser(orgId, 'doctor', '박완');
    await seedJobs([['용접공', 12]], docA.id);
    await seedJobs([['용접공', 3]], docB.id);
    const body = { ...JOB_BODY, descriptive: { stratifyByKey: STAFF_KEY } };

    const plain = await post(owner, 'analyze', body);
    expect(plain.status).toBe(200);
    const plainGroups = plain.body.result.descriptiveStratified.groups.map((g: { kind: string }) => g.kind);
    expect(plainGroups).toContain('other'); // 3명뿐인 담당의는 "기타"로 병합
    const plainTotal = plain.body.result.descriptiveStratified.byGroup.find((g: { groupId: string }) => g.groupId === 'total');
    expect(plainTotal.discrete[0].suppressed).toBe(true); // 하나라도 비공개면 전체도 비공개
    expect(JSON.stringify(plain.body.result)).not.toContain('박완');

    await grant();
    const res = await post(owner, 'analyze', body);
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    expect(res.body.result.continuous).toEqual([]);
    expect(res.body.result.discrete).toEqual([]);
    const st = res.body.result.descriptiveStratified;
    expect(st.groups.map((g: { kind: string }) => g.kind)).not.toContain('other');
    const names = st.groups.filter((g: { kind: string }) => g.kind === 'level').map((g: { level: string }) => g.level).sort();
    expect(names).toEqual(['김호길', '박완']);
    const nOf = (groupId: string) => {
      const cell = st.byGroup.find((g: { groupId: string }) => g.groupId === groupId).discrete[0];
      expect(cell.suppressed).toBe(false);
      return cell.n;
    };
    const levelIds = st.groups.filter((g: { kind: string }) => g.kind === 'level');
    const perGroup = levelIds.map((g: { groupId: string; level: string }) => [g.level, nOf(g.groupId)]).sort();
    expect(perGroup).toEqual([['김호길', 12], ['박완', 3]]);
    expect(nOf('total')).toBe(15);

    // 같은 실행 재조회(GET)도 해제 유지, 저장된 캐시에는 담당의 이름·수치 없음
    const viaGet = await get(owner, `runs/${plain.body.runManifest.analysisRunId}`);
    expect(viaGet.body.result.limitedDisclosure).toBe('applied');
    expect(JSON.stringify((await runRow(plain.body.runManifest.analysisRunId)).result)).not.toContain('박완');
  }, 60000);

  // ---------------------------------------------------------------------------
  // 요청 단위 억제(필터 후 10명 미만) — 원본 보존과 같은 ID 재조회
  // ---------------------------------------------------------------------------
  it('N<10 조기 억제: 권한자는 POST에서 해제되고 같은 analysisRunId GET에서도 해제 유지, 회수하면 집계로 복귀한다', async () => {
    await seedJobs([['용접공', 5]]);
    await grant();
    const res = await post(owner, 'analyze', JOB_BODY);
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBe('applied');
    expect(res.body.result.discrete[0].levels).toEqual([{ level: '용접공', count: 5, proportion: 1 }]);
    const id = res.body.runManifest.analysisRunId;

    const row = await runRow(id);
    expect(row.frozen_dataset).not.toBeNull(); // 권한자 + 미(未)differencing 실행만 원본 보존
    expect(JSON.stringify(row.result)).not.toContain('용접공'); // 저장된 결과는 집계(억제) 그대로

    const viaGet = await get(owner, `runs/${id}`);
    expect(viaGet.status).toBe(200);
    expect(viaGet.body.result.limitedDisclosure).toBe('applied');
    expect(viaGet.body.result.discrete[0].n).toBe(5);

    await revoke();
    const revoked = await get(owner, `runs/${id}`);
    expect(revoked.body.result.limitedDisclosure).toBeUndefined();
    expect(revoked.body.result.discrete[0].suppressed).toBe(true);
    expect(JSON.stringify(revoked.body.result)).not.toContain('용접공');

    // 해제 전달 1건당 해제 감사 1건(POST 1 + GET 1), 승인·억제 감사는 별도로 남는다.
    const audits = await limitedAudits(id);
    expect(audits.map((a) => a.smallCellLimitStatus)).toEqual(['applied', 'applied']);
  }, 40000);

  it('비권한 상태에서 만든 N<10 실행은 원본이 없다 — 이후 권한을 받아도 GET은 집계 + unavailable_source_missing, 재실행하면 해제된다', async () => {
    await seedJobs([['용접공', 5]]);
    const first = await post(owner, 'analyze', JOB_BODY);
    expect(first.status).toBe(200);
    expect(first.body.result.discrete[0].suppressed).toBe(true);
    const id = first.body.runManifest.analysisRunId;
    expect((await runRow(id)).frozen_dataset).toBeNull();

    await grant();
    const viaGet = await get(owner, `runs/${id}`);
    expect(viaGet.body.result.limitedDisclosure).toBe('unavailable_source_missing');
    expect(viaGet.body.result.discrete[0].suppressed).toBe(true);

    const rerun = await post(owner, 'analyze', JOB_BODY);
    expect(rerun.body.result.limitedDisclosure).toBe('applied');
    expect(rerun.body.result.discrete[0].n).toBe(5);
  }, 40000);

  // ---------------------------------------------------------------------------
  // differencing(forceSuppress) 우회 차단 — N>=10 / N<10 각각 POST → 같은 ID GET
  // ---------------------------------------------------------------------------
  describe.each([
    ['N>=10', 12],
    ['N<10', 5],
  ])('differencing 제한 + %s', (_label, count) => {
    it('권한자여도 해제되지 않고 원본이 저장되지 않으며, 같은 ID GET에서도 해제되지 않는다', async () => {
      await seedJobs([['용접공', count]]);
      await grant();
      const body = (day: number) => ({
        ...JOB_BODY,
        filters: [{ key: 'case.meta.registeredAt', operator: 'gte', value: `2000-01-${String(day).padStart(2, '0')}` }],
      });
      // 같은 family에서 서로 다른 필터 값을 11개 조회하면(maxDistinctFilterValuesPerKey=10 초과) forceSuppress.
      for (let day = 1; day <= 10; day += 1) {
        const preview = await post(owner, 'preview', body(day));
        expect(preview.status).toBe(200);
      }
      const res = await post(owner, 'analyze', body(11));
      expect(res.status).toBe(200);
      expect(res.body.result.limitedDisclosure).toBeUndefined();
      expect(res.body.result.discrete[0].suppressed).toBe(true);
      expect(JSON.stringify(res.body.result)).not.toContain('용접공');
      const id = res.body.runManifest.analysisRunId;
      expect((await runRow(id)).frozen_dataset).toBeNull(); // 사유 코드가 아니라 forceSuppress 플래그로 판정

      __resetDifferencingGuardForTests(); // GET은 differencing을 다시 평가하지 않는다 — 우회 가능성 자체를 확인.
      const viaGet = await get(owner, `runs/${id}`);
      expect(viaGet.status).toBe(200);
      expect(viaGet.body.result.limitedDisclosure).not.toBe('applied');
      expect(viaGet.body.result.discrete[0].suppressed).toBe(true);
      expect(JSON.stringify(viaGet.body.result)).not.toContain('용접공');
      expect((await limitedAudits(id)).filter((a) => a.smallCellLimitStatus === 'applied')).toHaveLength(0);
    }, 60000);
  });

  // ---------------------------------------------------------------------------
  // 접근 제어는 기존 그대로 — 제한데이터 권한은 실행 소유권 검사를 대체하지 않는다.
  // ---------------------------------------------------------------------------
  it('접근 제어: 같은 조직 비권한 admin은 집계, 같은 조직 일반 타 사용자는 403, 다른 조직은 404', async () => {
    await seedJobs([['용접공', 12], ['목수', 12], ['간호사', 12], ['잠수부', 3]]);
    await grant();
    const mine = await post(owner, 'analyze', JOB_BODY);
    expect(mine.body.result.limitedDisclosure).toBe('applied');
    const id = mine.body.runManifest.analysisRunId;

    const viaAdmin = await get(adminNoCap, `runs/${id}`);
    expect(viaAdmin.status).toBe(200);
    expect(viaAdmin.body.result.limitedDisclosure).toBeUndefined();
    expect(JSON.stringify(viaAdmin.body.result)).not.toContain('잠수부'); // 해제 수치가 admin에게 새지 않는다
    expect(viaAdmin.body.result.discrete[0].other).toBeDefined();

    expect((await get(otherDoctor, `runs/${id}`)).status).toBe(403);
    expect((await get(outsider, `runs/${id}`)).status).toBe(404);
  }, 40000);

  // ---------------------------------------------------------------------------
  // 미리보기
  // ---------------------------------------------------------------------------
  it('미리보기: 권한자는 N<10도 실제 수와 limitedDisclosure를 받고 감사에는 요청 수준 해제가 기록된다(이변량 미리보기는 그대로 억제)', async () => {
    await seedJobs([['용접공', 5]]);
    const plain = await post(owner, 'preview', JOB_BODY);
    expect(plain.body.counts).toMatchObject({ suppressed: true, personCount: null, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(plain.body.limitedDisclosure).toBeUndefined();

    await grant();
    const open = await post(owner, 'preview', JOB_BODY);
    expect(open.status).toBe(200);
    expect(open.body.counts).toMatchObject({ suppressed: false, personCount: 5, reasonCode: null });
    expect(open.body.limitedDisclosure).toBe('applied');
    expect(open.body.estimability.completeCaseN).toBe(5);

    const audit = (await pool.query<{ outcome: string; extra: Record<string, unknown> }>(
      `SELECT outcome, extra FROM audit_logs WHERE actor_org_id=$1 AND action='stats_preview'
         AND extra->>'analysisRunId'=$2`, [orgId, open.body.runManifest.analysisRunId],
    )).rows[0];
    expect(audit.outcome).toBe('success');
    expect(audit.extra).toMatchObject({
      suppressed: false, originalReasonCode: 'MIN_COHORT_NOT_MET', deliveredReasonCode: null,
      smallCellLimitLifted: true, liftedRequestGate: true,
    });

    // 이변량 미리보기는 권한자여도 변경 없음(통계적 타당성 게이트가 섞여 있어 범위 밖)
    const bivariate = await post(owner, 'preview', {
      ...RECIPE_BASE, variableKeys: ['shoulder.exposure.anyExceeded', 'knee.relatedness.max'],
      formulaPolicies: { 'shoulder.exposure.anyExceeded': 'recompute_current', 'knee.relatedness.max': 'recompute_current' },
      analysisMode: 'bivariate',
    });
    expect(bivariate.status).toBe(200);
    expect(bivariate.body.counts.suppressed).toBe(true);
    expect(bivariate.body.limitedDisclosure).toBeUndefined();
  }, 40000);

  it('미리보기: 요청 수준은 통과하고 결측 2명(셀 수준)만 푼 경우 감사는 liftedRequestGate=false, liftedCellLevel=true로 구분된다', async () => {
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await seedNoJob(2);

    const plain = await post(owner, 'preview', JOB_BODY);
    expect(plain.body.counts.suppressed).toBe(false);
    expect(plain.body.estimability.completeCaseN).toBeNull();
    expect(plain.body.estimability.missingRatesByVariable[JOB_KEY]).toBeNull();

    await grant();
    const open = await post(owner, 'preview', JOB_BODY);
    expect(open.body.limitedDisclosure).toBe('applied');
    expect(open.body.estimability.completeCaseN).toBe(50);
    expect(open.body.estimability.missingRatesByVariable[JOB_KEY]).toBeCloseTo(2 / 52, 6);

    const audit = (await pool.query<{ extra: Record<string, unknown> }>(
      `SELECT extra FROM audit_logs WHERE actor_org_id=$1 AND action='stats_preview' AND extra->>'analysisRunId'=$2`,
      [orgId, open.body.runManifest.analysisRunId],
    )).rows[0];
    expect(audit.extra).toMatchObject({
      suppressed: false, originalReasonCode: null, deliveredReasonCode: null,
      smallCellLimitLifted: true, liftedRequestGate: false, liftedCellLevel: true,
    });
  }, 40000);

  it('미리보기: 풀 것이 없으면(소수 셀 없음) 권한자 응답도 일반 응답과 같고 해제 표시·감사 플래그가 없다', async () => {
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await grant();
    const res = await post(owner, 'preview', JOB_BODY);
    expect(res.body.limitedDisclosure).toBeUndefined();
    const audit = (await pool.query<{ extra: Record<string, unknown> }>(
      `SELECT extra FROM audit_logs WHERE actor_org_id=$1 AND action='stats_preview' AND extra->>'analysisRunId'=$2`,
      [orgId, res.body.runManifest.analysisRunId],
    )).rows[0];
    expect(audit.extra).toMatchObject({ smallCellLimitLifted: false, liftedRequestGate: false, liftedCellLevel: false });
  }, 40000);

  // ---------------------------------------------------------------------------
  // memo · 감사 · 폴백
  // ---------------------------------------------------------------------------
  it('memo hit도 전달마다 별도 해제 감사가 남는다(엔진은 한 번만 호출)', async () => {
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await seedNoJob(2);
    const plain = await post(owner, 'analyze', JOB_BODY); // 집계 캐시 생성
    const id = plain.body.runManifest.analysisRunId;
    await grant();
    runStatsEngineSpy.mockClear();

    const a = await post(owner, 'analyze', JOB_BODY);
    const b = await post(owner, 'analyze', JOB_BODY);
    expect(a.body.result.limitedDisclosure).toBe('applied');
    expect(b.body.result.limitedDisclosure).toBe('applied');
    expect(runStatsEngineSpy).toHaveBeenCalledTimes(1);
    const audits = await limitedAudits(id);
    expect(audits.map((x) => [x.smallCellLimitStatus, x.limitedDisclosureSource])).toEqual([['applied', 'computed'], ['applied', 'memo']]);
  }, 40000);

  it('엔진 Busy 폴백: 집계 결과 + unavailable_engine_busy, 공개된 것이 없으면 best-effort 감사, 원시 필드가 붙으면 strict 감사(실패 시 500)', async () => {
    // (1) 이산형 — 원시 필드가 붙지 않는다 → best-effort 감사만
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await seedNoJob(2);
    const plain = await post(owner, 'analyze', JOB_BODY);
    const jobId = plain.body.runManifest.analysisRunId;
    await grant();
    runStatsEngineSpy.mockImplementationOnce(async () => { throw new StatsEngineBusyError(); });
    const busy = await post(owner, 'analyze', JOB_BODY);
    expect(busy.status).toBe(200);
    expect(busy.body.result.limitedDisclosure).toBe('unavailable_engine_busy');
    expect(busy.body.result.discrete[0].suppressed).toBe(true); // 집계 그대로
    const audits = await limitedAudits(jobId);
    expect(audits.at(-1)).toMatchObject({ smallCellLimitStatus: 'unavailable_engine_busy', limitedRowFieldsAttached: false });
  }, 40000);

  it('엔진 Busy 폴백 + 원시 필드 부착(연속형): 해제 상태는 실제 unavailable_*로, 감사는 strict이며 감사 실패 시 500이다', async () => {
    const KNEE = { low: [500, 10], lowMid: [500, 90], highMid: [3500, 90], high: [3500, 130] } as const;
    const bins = ['low', 'lowMid', 'highMid', 'high'] as const;
    for (let i = 0; i < 12; i += 1) {
      const [weight, squatting] = KNEE[bins[i % 4]];
      await insertPatient({
        data: {
          shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01' },
          modules: { knee: { jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: String(weight), squatting: String(squatting) }], jobExtras: [] } },
          activeModules: ['knee'],
        },
      }, `knee-${i}-${crypto.randomUUID()}`);
    }
    const body = { ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive' };
    const plain = await post(owner, 'analyze', body);
    const id = plain.body.runManifest.analysisRunId;
    await grant();

    runStatsEngineSpy.mockImplementationOnce(async () => { throw new StatsEngineBusyError(); });
    const res = await post(owner, 'analyze', body);
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBe('unavailable_engine_busy');
    expect(res.body.result.continuous[0].rawHistogram).toBeDefined(); // 해제 실패와 무관하게 원시 필드는 붙는다
    const audit = (await limitedAudits(id)).at(-1)!;
    expect(audit).toMatchObject({ smallCellLimitStatus: 'unavailable_engine_busy', limitedRowFieldsAttached: true });

    // strict 감사가 실패하면 500이고 응답에 원시 필드가 없다.
    __resetLimitedDisclosureGuardForTests();
    runStatsEngineSpy.mockImplementationOnce(async () => { throw new StatsEngineBusyError(); });
    writeAuditLogStrictSpy
      .mockImplementationOnce(async (...args: Parameters<WriteAuditLogStrictFn>) => {
        const actual = await vi.importActual<typeof import('../middleware/audit')>('../middleware/audit');
        return actual.writeAuditLogStrict(...args); // admission 캐시 hit 감사
      })
      .mockRejectedValueOnce(new Error('audit db down'));
    const failed = await post(owner, 'analyze', body);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('rawHistogram');
  }, 60000);

  it('계산 중 권한이 회수되면 집계 결과로 반환하고 해제 수치·원시 필드·해제 감사가 없다', async () => {
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await seedNoJob(2);
    const plain = await post(owner, 'analyze', JOB_BODY);
    const id = plain.body.runManifest.analysisRunId;
    await grant();
    runStatsEngineSpy.mockImplementationOnce(async (...args: Parameters<RunStatsEngineFn>) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const actual = await vi.importActual<typeof import('../statsEngine')>('../statsEngine');
      return actual.runStatsEngine(...args);
    });
    const pending = startPost(owner, 'analyze', JOB_BODY);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await revoke(); // 계산이 도는 사이 권한 회수
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.result.limitedDisclosure).toBeUndefined();
    expect(res.body.result.discrete[0].suppressed).toBe(true);
    expect(JSON.stringify(res.body.result)).not.toContain('용접공');
    expect(JSON.stringify(res.body.result)).not.toContain('rawLevels');
    expect(await limitedAudits(id)).toHaveLength(0);
  }, 40000);

  // ---------------------------------------------------------------------------
  // 연결 중단 / 사용자당 동시 1건
  // ---------------------------------------------------------------------------
  function slowCancellableEngine(ms: number, state: { aborted: boolean }) {
    return async (...args: Parameters<RunStatsEngineFn>) => {
      const signal = args[1]?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          state.aborted = true;
          clearTimeout(timer);
          reject(new StatsEngineCancelledError());
        }, { once: true });
      });
      const actual = await vi.importActual<typeof import('../statsEngine')>('../statsEngine');
      return actual.runStatsEngine(...args);
    };
  }

  it('실제 연결 중단 시 계산을 중단하고 새 해제 감사·memo 없이 사용자 잠금이 풀린다(정상 요청은 취소되지 않는다)', async () => {
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await seedNoJob(2);
    const plain = await post(owner, 'analyze', JOB_BODY);
    const id = plain.body.runManifest.analysisRunId;
    await grant();

    const state = { aborted: false };
    runStatsEngineSpy.mockImplementationOnce(slowCancellableEngine(5000, state));
    const server = await new Promise<http.Server>((resolve) => { const s = app().listen(0, () => resolve(s)); });
    try {
      const port = (server.address() as AddressInfo).port;
      const req = http.request({
        port, method: 'POST', path: '/api/stats/analyze',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}`, 'X-CSRF-Token': CSRF_TOKEN },
      });
      req.on('error', () => { /* 의도한 연결 파괴 */ });
      req.write(JSON.stringify(JOB_BODY));
      req.end();
      await new Promise((resolve) => setTimeout(resolve, 500)); // 요청 본문 수신 완료 이후에도 취소되지 않아야 한다
      expect(state.aborted).toBe(false);
      req.destroy(); // 응답 완료 전 실제 연결 중단
      const deadline = Date.now() + 5000;
      while (!state.aborted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(state.aborted).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await limitedAudits(id)).filter((a) => a.smallCellLimitStatus === 'applied')).toHaveLength(0);

    // 잠금이 풀렸고 memo도 없다 — 다음 요청은 새로 계산해 정상 해제된다.
    runStatsEngineSpy.mockClear();
    const next = await post(owner, 'analyze', JOB_BODY);
    expect(next.body.result.limitedDisclosure).toBe('applied');
    expect(runStatsEngineSpy).toHaveBeenCalledTimes(1);
  }, 40000);

  it('같은 사용자의 동시 해제 요청은 1건만 계산하고 나머지는 기다리지 않고 unavailable_engine_busy로 폴백한다', async () => {
    await seedJobs([['용접공', 30], ['목수', 20]]);
    await seedNoJob(2);
    await post(owner, 'analyze', JOB_BODY);
    await grant();
    runStatsEngineSpy.mockImplementationOnce(async (...args: Parameters<RunStatsEngineFn>) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const actual = await vi.importActual<typeof import('../statsEngine')>('../statsEngine');
      return actual.runStatsEngine(...args);
    });
    const first = startPost(owner, 'analyze', JOB_BODY);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await post(owner, 'analyze', JOB_BODY);
    expect(second.body.result.limitedDisclosure).toBe('unavailable_engine_busy');
    const firstRes = await first;
    expect(firstRes.body.result.limitedDisclosure).toBe('applied');
  }, 40000);
});

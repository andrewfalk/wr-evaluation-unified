// PR4-B1 — routes/__tests__/stats.test.ts의 POST /analyze mock 기반 테스트 다수가
// admission(§A) 도입으로 pool.query 순서 자체가 완전히 바뀌어 깨졌다(그 파일은
// BEGIN→DELETE만료→INSERT RETURNING→COMMIT 같은 "한 트랜잭션" 순서를 그대로
// mockResolvedValueOnce 큐로 흉내내는데, 지금은 admission 트랜잭션(advisory lock×2+
// 캐시확인+합류확인+quota확인+INSERT)과 워커의 finishRun 트랜잭션이 분리돼 있다).
// 그 mock 시퀀스는 새 아키텍처를 재현할 수 없으므로, "생성자/캐시hit/타임아웃/
// grain-agnostic 배선/limited_row 응답시점 merge"처럼 여전히 유효한 관찰가능한 동작은
// statsBivariateHttp.integration.test.ts와 동일한 패턴(실제 Postgres + 실제 Python +
// 실제 백그라운드 워커)으로 여기서 다시 증명한다. ENGINE_BUSY(429)·"감사 실패 시
// 트랜잭션 롤백" 두 테스트는 새 아키텍처에서 전제 자체가 사라졌다(BUSY는 이제 워커
// 내부에서 requeueOrFinish로 조용히 재큐잉될 뿐 클라이언트에 429로 노출되지 않고,
// 감사-원자성은 finishRun의 writeTerminalOutcome으로 자리를 옮겼다) — 그 보장들은
// statsRunsQueue.integration.test.ts가 대신 증명한다(routes/__tests__/stats.test.ts의
// 해당 두 테스트는 삭제하고 이 사실을 주석으로 남긴다).
//
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/__tests__/statsDescriptiveHttp.integration.test.ts
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// statsBivariateHttp.integration.test.ts와 동일한 이유(§상단 주석)로 배포모드 게이트를 우회한다.
vi.mock('../statsWorkbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: true, reason: null, checkedAt: null }),
  setStatsWorkbenchHealthy: () => {},
}));

import { createStatsRouter } from '../routes/stats';
import { createStatsRunsQueueWorker } from '../statsRunsQueue';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';
import { StatsEngineTimeoutError, StatsEngineProcessError } from '../statsEngine';

// 끝 구간 병합 PR — 202(비동기) 경로를 결정적으로 재현하려면 syncBudgetMs를 테스트
// 안에서 바꿔야 하는데 실제 config는 Object.freeze라 직접 못 바꾼다(Proxy도 frozen
// 속성의 get 불변식 위반). 동결 안 된 복사본을 만들고 syncBudgetMs만 getter로 둔다.
const syncBudget = vi.hoisted(() => ({ ms: null as number | null }));
vi.mock('../config', async (importOriginal) => {
  const actualModule = await importOriginal<typeof import('../config')>();
  const actual = actualModule.default;
  const asyncCfg = { ...actual.stats.async };
  Object.defineProperty(asyncCfg, 'syncBudgetMs', {
    get: () => syncBudget.ms ?? actual.stats.async.syncBudgetMs,
    enumerable: true,
  });
  return { ...actualModule, default: { ...actual, stats: { ...actual.stats, async: asyncCfg } } };
});

// runStatsEngine은 기본적으로 실제 구현을 그대로 통과시킨다(정상 경로는 실제 Python
// subprocess가 돈다) — Timeout/ProcessError 두 테스트만 .mockRejectedValueOnce로 딱
// 한 번 가로챈다(그 뒤 호출은 다시 실제 구현으로 돌아간다, vitest의 …Once 관례).
// 실제 구현은 호출 시점에 vi.importActual로 얻는다 — 이 파일 최상단에서
// `import { runStatsEngine } from '../statsEngine'`로 따로 가져오면 vi.mock 호이스팅
// 때문에 그 import 자체도 mock된 값을 참조하게 되어 무한 재귀(→ 스택오버플로가
// PROCESS_ERROR로 뭉개짐)에 빠진다. 모듈 스코프 let에 담아뒀다가 쓰는 것도 vi.mock의
// 호이스팅(TDZ) 때문에 안 된다 — 매 호출마다 동적으로 가져온다.
type RunStatsEngineFn = typeof import('../statsEngine')['runStatsEngine'];
const runStatsEngineSpy = vi.fn(async (...args: Parameters<RunStatsEngineFn>) => {
  const actual = await vi.importActual<typeof import('../statsEngine')>('../statsEngine');
  return actual.runStatsEngine(...args);
});
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runStatsEngine: (...args: Parameters<typeof actual.runStatsEngine>) => runStatsEngineSpy(...args) };
});

// §9(limited_row 응답시점 merge)의 신규 감사 실패 테스트용 — 같은 vi.importActual 패턴.
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
const CSRF_TOKEN = 'itest-descriptive-csrf';
const CAP_LIMITED_ROWS = 'stats.export_limited_rows';

describe.skipIf(!TEST_DB_URL)('POST /analyze(descriptive) — 실데이터 HTTP 통합 (실제 Postgres+Python+워커)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;
  let accessToken: string;
  let worker: { stop: () => void };

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    worker = createStatsRunsQueueWorker(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_descriptiveHttp_org__'],
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_descriptiveHttp_user_${Date.now()}__`, 'x', 'Test Doctor', orgId],
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
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
    runStatsEngineSpy.mockClear();
    writeAuditLogStrictSpy.mockClear();
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

  const RECIPE_BASE = { grain: 'case' as const, filters: [], analysisPurpose: 'association' as const, formulaPolicies: {} };

  // ---------------------------------------------------------------------------
  // knee.relatedness.max — statsBivariateHttp.integration.test.ts와 동일한 4구간
  // burden bin(그룹 내부에도 분산이 있어야 CONSTANT_VARIABLE로 억제되지 않는다).
  // ---------------------------------------------------------------------------
  const KNEE_BURDEN_BINS = {
    low: [500, 10] as const, lowMid: [500, 90] as const, highMid: [3500, 90] as const, high: [3500, 130] as const,
  };
  function kneePayload(bin: keyof typeof KNEE_BURDEN_BINS) {
    const [weight, squatting] = KNEE_BURDEN_BINS[bin];
    return {
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01' },
        modules: { knee: { jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: String(weight), squatting: String(squatting) }], jobExtras: [] } },
        activeModules: ['knee'],
      },
    };
  }
  async function seedKneeCohort(n = 12): Promise<void> {
    const bins: Array<keyof typeof KNEE_BURDEN_BINS> = ['low', 'lowMid', 'highMid', 'high'];
    for (let i = 0; i < n; i += 1) {
      await insertPatient(kneePayload(bins[i % bins.length]), `knee-${i}-${crypto.randomUUID()}`);
    }
  }

  it('생성자(캐시 미스) — 200 + result + runManifest, 실제 Python 계산이 감사와 함께 원자적으로 저장된다', async () => {
    await seedKneeCohort();
    const res = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive',
    });
    expect(res.status).toBe(200);
    expect(res.body.runManifest).toBeDefined();
    expect(res.body.runManifest.outcome).toBeUndefined(); // toPublicRunManifest가 제거
    expect(res.body.result.continuous[0].variableKey).toBe('knee.relatedness.max');
    expect(res.body.result.continuous[0].suppressed).toBe(false);
    expect(res.body.result.continuous[0].n).toBe(12);
  }, 30000);

  it('DB 캐시 hit — 같은 recipe 재요청은 Python을 다시 부르지 않고 같은 analysisRunId·같은 결과를 반환한다', async () => {
    await seedKneeCohort();
    const body = { ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive' };
    const first = await authed(request(app()).post('/api/stats/analyze')).send(body);
    expect(first.status).toBe(200);
    const callsBeforeSecond = runStatsEngineSpy.mock.calls.length;

    const second = await authed(request(app()).post('/api/stats/analyze')).send(body);
    expect(second.status).toBe(200);
    expect(second.body.runManifest.analysisRunId).toBe(first.body.runManifest.analysisRunId);
    expect(second.body.result).toEqual(first.body.result);
    expect(runStatsEngineSpy.mock.calls.length).toBe(callsBeforeSecond); // 엔진 재호출 없음
  }, 30000);

  it('Python 타임아웃 — 500 + code:TIMEOUT + failed 저장, 원시 에러 상세는 응답에 없다', async () => {
    await seedKneeCohort();
    runStatsEngineSpy.mockRejectedValueOnce(new StatsEngineTimeoutError());
    const res = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive',
    });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('TIMEOUT');
    expect(res.body.error).toBe('Analysis timed out.');
    expect(JSON.stringify(res.body)).not.toMatch(/stack|Error:/);

    const runRow = await pool.query(`SELECT status, error_code FROM stats_runs WHERE organization_id=$1`, [orgId]);
    expect(runRow.rows[0].status).toBe('failed');
    expect(runRow.rows[0].error_code).toBe('TIMEOUT');
  }, 30000);

  it('Python 프로세스 에러 — 원시 에러 메시지(spawn 경로·내부 상세 등)가 HTTP 응답에 새어나가지 않는다', async () => {
    await seedKneeCohort();
    const sensitiveDetail = 'ENOENT: spawn C:\\opt\\stats-venv\\bin\\python /internal/scripts/analyze.py failed, DB connection string leaked here';
    runStatsEngineSpy.mockRejectedValueOnce(new StatsEngineProcessError('PROCESS_ERROR', sensitiveDetail));
    const res = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive',
    });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('PROCESS_ERROR');
    expect(res.body.error).toBe('Analysis engine failed to complete.');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ENOENT');
    expect(body).not.toContain('stats-venv');
    expect(body).not.toContain('leaked');
  }, 30000);

  it('disease grain — 상병×측 단위로 끝까지 처리되고 discrete 결과가 응답에 담긴다(grain-agnostic 배선)', async () => {
    for (let i = 0; i < 12; i += 1) {
      await insertPatient(
        { data: { shared: { diagnoses: [{ id: `dx-${i}`, code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: '2', klgLeft: '3' }] }, modules: {}, activeModules: [] } },
        `disease-${i}-${crypto.randomUUID()}`,
      );
    }
    const res = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, grain: 'disease', variableKeys: ['knee.diagnosisSide.klGrade'], analysisMode: 'descriptive',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.discrete[0].variableKey).toBe('knee.diagnosisSide.klGrade');
    expect(res.body.result.discrete[0].n).toBe(12);
  }, 30000);

  it('job grain — 직력 단위로 끝까지 처리되고 discrete 결과가 응답에 담긴다(grain-agnostic 배선)', async () => {
    for (let i = 0; i < 12; i += 1) {
      await insertPatient(
        { data: { shared: { jobs: [{ id: `job-${i}`, jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01' }] }, modules: {}, activeModules: [] } },
        `job-${i}-${crypto.randomUUID()}`,
      );
    }
    const res = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, grain: 'job', variableKeys: ['job.identity.jobNameNormalized'], analysisMode: 'descriptive',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.discrete[0].variableKey).toBe('job.identity.jobNameNormalized');
    expect(res.body.result.discrete[0].n).toBe(12);
  }, 30000);

  it('공통변수 브로드캐스트 — 성별(patient.identity.gender)이 job grain에서 행 기준 30:10으로 억제 없이 나온다', async () => {
    const weldJob = (idx: number) => ({ id: `job-${idx}`, jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01' });
    for (let i = 0; i < 10; i += 1) {
      await insertPatient(
        { data: { shared: { gender: 'male', jobs: [weldJob(i * 3), weldJob(i * 3 + 1), weldJob(i * 3 + 2)] }, modules: {}, activeModules: [] } },
        `male-${i}-${crypto.randomUUID()}`,
      );
    }
    for (let i = 0; i < 10; i += 1) {
      await insertPatient(
        { data: { shared: { gender: 'female', jobs: [weldJob(i)] }, modules: {}, activeModules: [] } },
        `female-${i}-${crypto.randomUUID()}`,
      );
    }
    const res = await authed(request(app()).post('/api/stats/analyze')).send({
      ...RECIPE_BASE, grain: 'job', variableKeys: ['patient.identity.gender'], analysisMode: 'descriptive',
    });
    expect(res.status).toBe(200);
    const genderResult = res.body.result.discrete[0];
    expect(genderResult.suppressed).toBe(false);
    expect(genderResult.n).toBe(40);
    const male = genderResult.levels.find((l: { level: string }) => l.level === 'male');
    const female = genderResult.levels.find((l: { level: string }) => l.level === 'female');
    expect(male.count).toBe(30);
    expect(female.count).toBe(10);
  }, 30000);

  describe('limited_row 필드 응답시점 merge(§9, stats.export_limited_rows)', () => {
    async function grant(): Promise<void> {
      await pool.query(
        `INSERT INTO user_capability_grants (user_id, organization_id, capability, granted_by, granted_by_org, reason)
         VALUES ($1,$2,$3,$1,$2,'test grant')`,
        [userId, orgId, CAP_LIMITED_ROWS],
      );
    }
    async function revoke(): Promise<void> {
      await pool.query(
        `DELETE FROM user_capability_grants WHERE user_id=$1 AND organization_id=$2 AND capability=$3`,
        [userId, orgId, CAP_LIMITED_ROWS],
      );
    }
    afterEach(revoke);

    it('생성자(캐시 미스) 경로 — 권한이 있으면 응답에 boxplot.outlierValues가 실제로 붙는다', async () => {
      await seedKneeCohort();
      await grant();
      const res = await authed(request(app()).post('/api/stats/analyze')).send({
        ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive',
      });
      expect(res.status).toBe(200);
      expect(res.body.result.continuous[0].boxplot.outlierValues).toBeDefined();
      expect(Array.isArray(res.body.result.continuous[0].boxplot.outlierValues)).toBe(true);
    }, 30000);

    it('§9 신규 감사(limitedRowFieldsAttached) 기록이 실패하면 500을 반환하고 응답 바디에 원시 필드가 없다', async () => {
      await seedKneeCohort();
      await grant();
      // 호출 순서는 이벤트루프상 결정적이다: ①워커의 finishRun 성공감사(백그라운드,
      // HTTP 핸들러가 'succeeded'를 관측하기 전에 이미 커밋됨) → ②finalizeAnalyzeResponse의
      // §9 신규감사(limitedRowFieldsAttached, 이 시점에만 붙는 필드) — ①은 정상 통과시키고
      // ②만 가로챈다(구 아키텍처의 "1차 정상/2차 실패" 순서와 동일한 의도).
      writeAuditLogStrictSpy
        .mockImplementationOnce(async (...args: Parameters<WriteAuditLogStrictFn>) => {
          const actual = await vi.importActual<typeof import('../middleware/audit')>('../middleware/audit');
          return actual.writeAuditLogStrict(...args);
        })
        .mockRejectedValueOnce(new Error('audit db down'));

      const res = await authed(request(app()).post('/api/stats/analyze')).send({
        ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive',
      });
      expect(res.status).toBe(500);
      expect(res.body.result).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('outlierValues');
    }, 30000);

    it('캐시 hit 경로 — 권한이 있으면 캐시된 aggregate 결과에도 응답시점에 boxplot.outlierValues가 붙는다', async () => {
      await seedKneeCohort();
      const body = { ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive' };
      const withoutAccess = await authed(request(app()).post('/api/stats/analyze')).send(body);
      expect(withoutAccess.status).toBe(200);
      expect(withoutAccess.body.result.continuous[0].boxplot?.outlierValues).toBeUndefined();

      await grant();
      const withAccess = await authed(request(app()).post('/api/stats/analyze')).send(body);
      expect(withAccess.status).toBe(200);
      expect(withAccess.body.runManifest.analysisRunId).toBe(withoutAccess.body.runManifest.analysisRunId); // 캐시 hit(재계산 아님)
      expect(withAccess.body.result.continuous[0].boxplot.outlierValues).toBeDefined();
    }, 30000);

    it('권한 부여→회수 전후 — 같은 캐시된 결과라도 매 요청 최신 권한을 그대로 반영한다(캐시가 권한을 같이 캐싱하지 않는다)', async () => {
      await seedKneeCohort();
      const body = { ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive' };

      const before = await authed(request(app()).post('/api/stats/analyze')).send(body);
      expect(before.status).toBe(200);
      expect(before.body.result.continuous[0].boxplot?.outlierValues).toBeUndefined();

      await grant();
      const after = await authed(request(app()).post('/api/stats/analyze')).send(body);
      expect(after.status).toBe(200);
      expect(after.body.runManifest.analysisRunId).toBe(before.body.runManifest.analysisRunId);
      expect(after.body.result.continuous[0].boxplot.outlierValues).toBeDefined();

      await revoke();
      const revoked = await authed(request(app()).post('/api/stats/analyze')).send(body);
      expect(revoked.status).toBe(200);
      expect(revoked.body.runManifest.analysisRunId).toBe(before.body.runManifest.analysisRunId);
      expect(revoked.body.result.continuous[0].boxplot?.outlierValues).toBeUndefined();
    }, 30000);

    // -------------------------------------------------------------------------
    // 끝 구간 병합 PR — 원본 히스토그램(rawHistogram)도 같은 응답시점 merge 단일
    // 지점(finalizeAnalyzeResponse)을 거치는지 4개 경로(생성자·캐시 hit·202→GET·
    // 진행 중 합류자) 전부에서 확인한다. 12명 코호트라 aggregate 히스토그램은 소수셀
    // 억제·병합 대상이 될 수 있지만, 원본은 bin 게이트 없이 그대로여야 한다.
    // -------------------------------------------------------------------------
    const DESCRIPTIVE_BODY = { ...RECIPE_BASE, variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive' };
    const rawCountSum = (body: any) =>
      (body.result.continuous[0].rawHistogram.bins as Array<{ count: number }>).reduce((s, b) => s + b.count, 0);

    async function pollRun(analysisRunId: string): Promise<request.Response> {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const res = await authed(request(app()).get(`/api/stats/runs/${analysisRunId}`));
        if (res.body.status !== 'queued' && res.body.status !== 'running') return res;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`pollRun: ${analysisRunId}가 30초 안에 끝나지 않음`);
    }

    async function withSyncBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
      syncBudget.ms = ms;
      try {
        return await fn();
      } finally {
        syncBudget.ms = null;
      }
    }

    it('rawHistogram — 생성자 경로: 권한이 있으면 붙고(합=n, merged/tailMerged 없음), 감사에 limitedRowFieldsAttached가 남고, DB 캐시(stats_runs.result)에는 없다', async () => {
      await seedKneeCohort();
      await grant();
      const res = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(res.status).toBe(200);
      const c = res.body.result.continuous[0];
      expect(c.rawHistogram).toBeDefined();
      expect(rawCountSum(res.body)).toBe(12);
      expect(c.rawHistogram.merged).toBeUndefined();
      expect(c.rawHistogram.bins.every((b: Record<string, unknown>) => !('tailMerged' in b))).toBe(true);

      const stored = await pool.query<{ result: unknown }>(
        `SELECT result FROM stats_runs WHERE analysis_run_id=$1`,
        [res.body.runManifest.analysisRunId],
      );
      expect(JSON.stringify(stored.rows[0].result)).not.toContain('rawHistogram');

      const audits = await pool.query(
        `SELECT 1 FROM audit_logs WHERE actor_org_id=$1 AND extra->>'analysisRunId'=$2 AND extra->>'limitedRowFieldsAttached'='true'`,
        [orgId, res.body.runManifest.analysisRunId],
      );
      expect(audits.rowCount).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('rawHistogram — 권한이 없으면 생성자·캐시 hit 어느 쪽에도 없다', async () => {
      await seedKneeCohort();
      const first = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(first.status).toBe(200);
      expect(first.body.result.continuous[0].rawHistogram).toBeUndefined();
      const second = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(second.body.runManifest.analysisRunId).toBe(first.body.runManifest.analysisRunId);
      expect(second.body.result.continuous[0].rawHistogram).toBeUndefined();
    }, 30000);

    it('rawHistogram — 감사 실패 시 500이고 응답 바디에 원본이 없다', async () => {
      await seedKneeCohort();
      await grant();
      writeAuditLogStrictSpy
        .mockImplementationOnce(async (...args: Parameters<WriteAuditLogStrictFn>) => {
          const actual = await vi.importActual<typeof import('../middleware/audit')>('../middleware/audit');
          return actual.writeAuditLogStrict(...args);
        })
        .mockRejectedValueOnce(new Error('audit db down'));
      const res = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('rawHistogram');
    }, 30000);

    it('rawHistogram — 캐시 hit 경로: 권한 부여→회수가 다음 응답부터 그대로 반영된다', async () => {
      await seedKneeCohort();
      const before = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(before.body.result.continuous[0].rawHistogram).toBeUndefined();

      await grant();
      const granted = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(granted.body.runManifest.analysisRunId).toBe(before.body.runManifest.analysisRunId);
      expect(rawCountSum(granted.body)).toBe(12);

      await revoke();
      const revoked = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(revoked.body.runManifest.analysisRunId).toBe(before.body.runManifest.analysisRunId);
      expect(revoked.body.result.continuous[0].rawHistogram).toBeUndefined();
    }, 30000);

    it('rawHistogram — 비동기 202 → GET /runs/:id 완료 경로도 조회 시점 권한으로 붙는다', async () => {
      await seedKneeCohort();
      await grant();
      const accepted = await withSyncBudget(0, () => authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY));
      expect(accepted.status).toBe(202);

      const done = await pollRun(accepted.body.analysisRunId);
      expect(done.body.status).toBe('succeeded');
      expect(rawCountSum(done.body)).toBe(12);

      await revoke();
      const afterRevoke = await authed(request(app()).get(`/api/stats/runs/${accepted.body.analysisRunId}`));
      expect(afterRevoke.body.status).toBe('succeeded');
      expect(afterRevoke.body.result.continuous[0].rawHistogram).toBeUndefined();
    }, 40000);

    it('rawHistogram — 진행 중 run에 합류한 요청도 합류자 응답 시점 권한으로 붙는다', async () => {
      await seedKneeCohort();
      // 워커를 멈춰 첫 요청을 queued로 묶어 둔다 → 두 번째 같은 요청이 반드시 joined가 된다.
      worker.stop();
      try {
        const first = await withSyncBudget(0, () => authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY));
        expect(first.status).toBe(202);

        await grant();
        // supertest 요청은 then()이 불릴 때 출발한다 — withSyncBudget 안의 await가 곧바로
        // 요청을 보내고(admission → queued 행에 joined), 워커가 멈춰 있으니 동기 예산
        // 동안 폴링하며 기다린다. 합류자가 admission을 마칠 시간을 준 뒤 워커를 다시 띄운다.
        const joinerPromise = withSyncBudget(20000, () => authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY));
        await new Promise((resolve) => setTimeout(resolve, 500));
        worker = createStatsRunsQueueWorker(pool);
        const joiner = await joinerPromise;
        expect(joiner.status).toBe(200);
        expect(joiner.body.runManifest.analysisRunId).toBe(first.body.analysisRunId);
        expect(rawCountSum(joiner.body)).toBe(12);
      } finally {
        worker.stop();
        worker = createStatsRunsQueueWorker(pool);
      }
    }, 40000);

    it('rawHistogram — 버전이 달라진 과거 실행은 저장된 aggregate만 돌려주고 원본은 붙지 않는다', async () => {
      await seedKneeCohort();
      const res = await authed(request(app()).post('/api/stats/analyze')).send(DESCRIPTIVE_BODY);
      expect(res.status).toBe(200);
      // 과거 버전 코드로 저장된 실행을 흉내낸다(hasVersionDrifted → true).
      await pool.query(
        `UPDATE stats_runs SET execution_digest='stale-digest-from-old-code' WHERE analysis_run_id=$1`,
        [res.body.runManifest.analysisRunId],
      );
      await grant();
      const old = await authed(request(app()).get(`/api/stats/runs/${res.body.runManifest.analysisRunId}`));
      expect(old.status).toBe(200);
      expect(old.body.status).toBe('succeeded');
      expect(old.body.result.continuous[0].rawHistogram).toBeUndefined();
      expect(old.body.result.continuous[0].histogram === null || Array.isArray(old.body.result.continuous[0].histogram?.bins)).toBe(true);
    }, 30000);

    // -------------------------------------------------------------------------
    // 범주형 소수 범주 "기타" 병합 PR — 사용자가 실제로 본 변수(대표 직종명)로 같은 4경로를
    // 확인한다. 용접공·목수·간호사 12명씩 + 잠수부 3명(소수 범주): 기존엔 변수 전체 억제였다.
    // 단독 요청이면 잠수부(3)에 가장 작은 공개 범주 하나(동률이면 범주 키 순서상 첫 번째인
    // 간호사)를 끌어와 "기타"=15명, 이름 붙은 범주는 용접공·목수 2개다.
    // -------------------------------------------------------------------------
    const JOB_KEY = 'job.rollup.longestTenureJobNameNormalized';
    const JOB_BODY = { ...RECIPE_BASE, variableKeys: [JOB_KEY], analysisMode: 'descriptive' };

    async function seedJobNames(): Promise<void> {
      const spec: Array<[string, number]> = [['용접공', 12], ['목수', 12], ['간호사', 12], ['잠수부', 3]];
      for (const [name, count] of spec) {
        for (let i = 0; i < count; i += 1) {
          await insertPatient(
            { data: { shared: { jobs: [{ id: `job-${name}-${i}`, jobName: name, startDate: '2015-01-01', endDate: '2020-01-01' }] }, modules: {}, activeModules: [] } },
            `job-${name}-${i}-${crypto.randomUUID()}`,
          );
        }
      }
    }
    const levelCountSum = (levels: Array<{ count: number }>) => levels.reduce((s, l) => s + l.count, 0);

    it('rawLevels — 권한이 없으면 소수 범주가 "기타"로 합쳐져 공개되고 원본 필드는 없다(캐시 hit도 동일)', async () => {
      await seedJobNames();
      const first = await authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY);
      expect(first.status).toBe(200);
      const d = first.body.result.discrete[0];
      expect(d.suppressed).toBe(false);
      expect(d.n).toBe(39);
      expect(d.levels.map((l: { level: string }) => l.level).sort()).toEqual(['목수', '용접공']);
      expect(d.other).toEqual({ count: 15, proportion: 15 / 39 });
      expect(levelCountSum(d.levels) + d.other.count).toBe(39);
      expect(d.rawLevels).toBeUndefined();
      expect(JSON.stringify(d)).not.toContain('잠수부'); // 소수 범주 이름이 응답에 없다

      const second = await authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY);
      expect(second.body.runManifest.analysisRunId).toBe(first.body.runManifest.analysisRunId);
      expect(second.body.result.discrete[0].rawLevels).toBeUndefined();
    }, 30000);

    it('rawLevels — 생성자 경로: 권한이 있으면 1~9명 범주까지 원본이 붙고, 공개 levels·other는 그대로이며, DB 캐시에는 없고, 감사가 남는다', async () => {
      await seedJobNames();
      await grant();
      const res = await authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY);
      expect(res.status).toBe(200);
      const d = res.body.result.discrete[0];
      expect(d.rawLevels.map((l: { level: string; count: number }) => [l.level, l.count]).sort())
        .toEqual([['간호사', 12], ['목수', 12], ['용접공', 12], ['잠수부', 3]]);
      expect(levelCountSum(d.rawLevels)).toBe(39);
      expect(d.other.count).toBe(15);
      expect(d.levels).toHaveLength(2);

      const stored = await pool.query<{ result: unknown }>(`SELECT result FROM stats_runs WHERE analysis_run_id=$1`, [res.body.runManifest.analysisRunId]);
      expect(JSON.stringify(stored.rows[0].result)).not.toContain('rawLevels');
      expect(JSON.stringify(stored.rows[0].result)).not.toContain('잠수부');

      const audits = await pool.query(
        `SELECT 1 FROM audit_logs WHERE actor_org_id=$1 AND extra->>'analysisRunId'=$2 AND extra->>'limitedRowFieldsAttached'='true'`,
        [orgId, res.body.runManifest.analysisRunId],
      );
      expect(audits.rowCount).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('rawLevels — 감사 실패 시 500이고 응답에 원본이 없다', async () => {
      await seedJobNames();
      await grant();
      writeAuditLogStrictSpy
        .mockImplementationOnce(async (...args: Parameters<WriteAuditLogStrictFn>) => {
          const actual = await vi.importActual<typeof import('../middleware/audit')>('../middleware/audit');
          return actual.writeAuditLogStrict(...args);
        })
        .mockRejectedValueOnce(new Error('audit db down'));
      const res = await authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('rawLevels');
      expect(JSON.stringify(res.body)).not.toContain('잠수부');
    }, 30000);

    it('rawLevels — 캐시 hit와 202→GET 경로: 권한 부여→회수가 다음 응답부터 그대로 반영된다', async () => {
      await seedJobNames();
      const accepted = await withSyncBudget(0, () => authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY));
      expect(accepted.status).toBe(202);
      const done = await pollRun(accepted.body.analysisRunId);
      expect(done.body.status).toBe('succeeded');
      expect(done.body.result.discrete[0].rawLevels).toBeUndefined();
      expect(done.body.result.discrete[0].other.count).toBe(15);

      await grant();
      const viaGet = await authed(request(app()).get(`/api/stats/runs/${accepted.body.analysisRunId}`));
      expect(levelCountSum(viaGet.body.result.discrete[0].rawLevels)).toBe(39);
      const viaCache = await authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY);
      expect(viaCache.body.runManifest.analysisRunId).toBe(accepted.body.analysisRunId);
      expect(levelCountSum(viaCache.body.result.discrete[0].rawLevels)).toBe(39);

      await revoke();
      const revoked = await authed(request(app()).get(`/api/stats/runs/${accepted.body.analysisRunId}`));
      expect(revoked.body.result.discrete[0].rawLevels).toBeUndefined();
    }, 40000);

    it('rawLevels — 진행 중 run에 합류한 요청도 합류자 응답 시점 권한으로 원본이 붙는다', async () => {
      await seedJobNames();
      worker.stop();
      try {
        const first = await withSyncBudget(0, () => authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY));
        expect(first.status).toBe(202);
        await grant();
        const joinerPromise = withSyncBudget(20000, () => authed(request(app()).post('/api/stats/analyze')).send(JOB_BODY));
        await new Promise((resolve) => setTimeout(resolve, 500));
        worker = createStatsRunsQueueWorker(pool);
        const joiner = await joinerPromise;
        expect(joiner.status).toBe(200);
        expect(joiner.body.runManifest.analysisRunId).toBe(first.body.analysisRunId);
        expect(levelCountSum(joiner.body.result.discrete[0].rawLevels)).toBe(39);
      } finally {
        worker.stop();
        worker = createStatsRunsQueueWorker(pool);
      }
    }, 40000);

    it('"기타" 병합은 변수 하나만 요청했을 때만 — 다른 변수와 함께 요청하면 같은 변수가 억제된다(단일 응답 역산 방어)', async () => {
      await seedJobNames();
      const res = await authed(request(app()).post('/api/stats/analyze')).send({
        ...RECIPE_BASE, variableKeys: [JOB_KEY, 'job.rollup.longestTenureYears'], analysisMode: 'descriptive',
      });
      expect(res.status).toBe(200);
      const jobVar = res.body.result.discrete.find((d: { variableKey: string }) => d.variableKey === JOB_KEY);
      expect(jobVar.suppressed).toBe(true);
      expect(jobVar.other).toBeUndefined();
      expect(JSON.stringify(res.body.result)).not.toContain('잠수부');
    }, 30000);
  });
});

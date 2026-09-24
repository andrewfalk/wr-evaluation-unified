// PR4-B1(pr4-b-virtual-pnueli.md 11차 통합본) §검증 계획 — admission→attempt→finish
// 파이프라인의 동시성 보장은 실제 Postgres 잠금(advisory lock, SELECT...FOR UPDATE,
// 부분 유니크 인덱스)으로만 증명 가능하다. statsAnalyze.integration.test.ts/
// statsSnapshot.integration.test.ts와 동일한 패턴(TEST_DATABASE_URL 없으면 전체 skip).
//
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/__tests__/statsRunsQueue.integration.test.ts
//
// 여기서는 admitAnalysisRun(실제 AnalysisContext 필요)까지 가지 않고, stats_runs 행을
// 직접 원하는 상태(created_at/heartbeat_at/cancel_requested_at/execution_digest 등)로
// INSERT한 뒤 finishRun/requeueOrFinish/claimNextQueuedRun/sweep*/requestCancel을 직접
// 호출한다 — 이 함수들은 이미 영속된 행을 다루므로 실제 admission이나 Python 엔진 없이도
// 잠금·재검증·경계값 로직을 정확히 재현할 수 있다(레이스는 "우연히 재현"이 아니라
// "행 상태를 그 레이스가 만드는 정확한 모양으로 직접 세팅"해서 결정적으로 증명한다).
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import type { AnalyzeResult } from '@wr/contracts';

// routes/__tests__/stats.test.ts의 "감사 INSERT가 실패하면 같은 트랜잭션의 stats_runs
// INSERT도 롤백되고 500을 반환한다" 테스트가 admission 도입으로 깨졌다 — 그 원자성
// 보장은 이제 finishRun의 writeTerminalOutcome(상태전이+감사를 한 트랜잭션)이 담당한다.
// writeAuditLogStrict는 기본적으로 실제 구현을 그대로 통과시키고(다른 모든 테스트가
// 실제 감사 기록에 의존), "감사 실패 시 롤백" 테스트만 .mockRejectedValueOnce로 가로챈다.
type WriteAuditLogStrictFn = typeof import('../middleware/audit')['writeAuditLogStrict'];
const writeAuditLogStrictSpy = vi.fn(async (...args: Parameters<WriteAuditLogStrictFn>) => {
  const actual = await vi.importActual<typeof import('../middleware/audit')>('../middleware/audit');
  return actual.writeAuditLogStrict(...args);
});
vi.mock('../middleware/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/audit')>();
  return { ...actual, writeAuditLogStrict: (...args: Parameters<typeof actual.writeAuditLogStrict>) => writeAuditLogStrictSpy(...args) };
});

import {
  finishRun,
  requeueOrFinish,
  claimNextQueuedRun,
  sweepStale,
  sweepQueuedTerminal,
  requestCancel,
  __resetStatsRunsQueueForTests,
} from '../statsRunsQueue';
import { buildPendingStatsRunManifest } from '../statsRunManifest';
import { computeExecutionDigest } from '../statsExecutionDigest';
import config from '../config';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const FAKE_RESULT: AnalyzeResult = { continuous: [], discrete: [] };

describe.skipIf(!TEST_DB_URL)('stats-runs-queue — 실제 Postgres 동시성·경계 (integration)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_statsRunsQueue_org__'],
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_statsRunsQueue_user_${Date.now()}__`, 'x', 'Test Doctor', orgId],
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE actor_org_id = $1`, [orgId]);
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM users WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE actor_org_id = $1`, [orgId]);
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    __resetStatsRunsQueueForTests();
    writeAuditLogStrictSpy.mockClear();
  });

  function digestFor(recipeDigest: string, sourceDigest: string): string {
    return computeExecutionDigest({ organizationId: orgId, requestedBy: userId, recipeDigest, sourceDigest });
  }

  interface InsertRowOverrides {
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    createdAt?: Date;
    startedAt?: Date | null;
    heartbeatAt?: Date | null;
    cancelRequestedAt?: Date | null;
    expiresAt?: Date;
    engineTimeoutMs?: number;
    requeueCount?: number;
    recipeDigest?: string;
    sourceDigest?: string;
    executionDigest?: string;
    cacheable?: boolean;
    result?: AnalyzeResult | null;
    errorCode?: string | null;
    finishedAt?: Date | null;
  }

  async function insertRow(overrides: InsertRowOverrides = {}): Promise<{ id: string; analysisRunId: string; executionDigest: string }> {
    const analysisRunId = crypto.randomUUID();
    const recipeDigest = overrides.recipeDigest ?? `recipe-${analysisRunId}`;
    const sourceDigest = overrides.sourceDigest ?? 'source-x';
    const executionDigest = overrides.executionDigest ?? digestFor(recipeDigest, sourceDigest);
    const status = overrides.status ?? 'queued';
    const snapshotAsOf = new Date().toISOString();
    const manifest = buildPendingStatsRunManifest({
      recipeDigest, sourceDigest, snapshotAsOf, formulaPolicies: {}, analysisMode: 'descriptive', analysisRunId,
    });
    const createdAt = overrides.createdAt ?? new Date();
    const startedAt = overrides.startedAt !== undefined ? overrides.startedAt : (status === 'running' ? new Date() : null);
    const heartbeatAt = overrides.heartbeatAt !== undefined ? overrides.heartbeatAt : (status === 'running' ? new Date() : null);
    const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000);
    const engineTimeoutMs = overrides.engineTimeoutMs ?? 30000;
    const requeueCount = overrides.requeueCount ?? 0;
    const cacheable = overrides.cacheable ?? true;
    // deriveAnalysisContext가 필요로 하는 최소 형태 — 이 테스트 파일은 attempt()/엔진을
    // 실제로 돌리지 않으므로(§ 파일 상단 설명) 내용 자체는 거의 쓰이지 않는다.
    const frozenDataset = {
      recipe: { grain: 'case', filters: [], analysisPurpose: 'association', analysisMode: 'descriptive', variableKeys: [], formulaPolicies: {} },
      dataset: { rows: [], personCount: 0 },
      recipeDigest, sourceDigest, snapshotAsOf,
    };
    const result = overrides.result !== undefined ? overrides.result : (status === 'succeeded' ? FAKE_RESULT : null);
    const errorCode = overrides.errorCode !== undefined ? overrides.errorCode : (status === 'failed' ? 'PROCESS_ERROR' : null);
    const finishedAt = overrides.finishedAt !== undefined ? overrides.finishedAt : (['succeeded', 'failed', 'cancelled'].includes(status) ? new Date() : null);

    await pool.query(
      `INSERT INTO stats_runs (
         organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, result, error_code, frozen_dataset,
         engine_timeout_ms, expires_at, analysis_run_id, created_at, started_at, heartbeat_at,
         cancel_requested_at, requeue_count, finished_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'aggregate',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        orgId, userId, status, recipeDigest, sourceDigest, executionDigest,
        cacheable, JSON.stringify(manifest), result ? JSON.stringify(result) : null, errorCode,
        JSON.stringify(frozenDataset), engineTimeoutMs, expiresAt, analysisRunId, createdAt,
        startedAt, heartbeatAt, overrides.cancelRequestedAt ?? null, requeueCount, finishedAt,
      ],
    );
    return { id: (await rowIdFor(analysisRunId)), analysisRunId, executionDigest };
  }

  async function rowIdFor(analysisRunId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM stats_runs WHERE analysis_run_id=$1`, [analysisRunId]);
    return rows[0].id;
  }

  async function fetchRow(id: string) {
    const { rows } = await pool.query(`SELECT * FROM stats_runs WHERE id=$1`, [id]);
    return rows[0];
  }

  async function auditRowsFor(analysisRunId: string) {
    const { rows } = await pool.query(
      `SELECT action, outcome, extra FROM audit_logs WHERE actor_org_id=$1 AND extra->>'analysisRunId'=$2 ORDER BY id`,
      [orgId, analysisRunId],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // finishRun — origin별 전제조건 재검증(§검증 7)
  // -------------------------------------------------------------------------
  describe('finishRun — 전제조건 재검증', () => {
    it('이미 종결된 행은 즉시 already_terminal을 반환하고 아무것도 바꾸지 않는다', async () => {
      const { id } = await insertRow({ status: 'succeeded' });
      const outcome = await finishRun(pool, id, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } });
      expect(outcome).toBe('already_terminal');
    });

    it('orphan_sweep — heartbeat가 그 사이 갱신돼 신선해지면 precondition_no_longer_met(후보 선정 이후 경합 방어)', async () => {
      const { id } = await insertRow({ status: 'running', heartbeatAt: new Date() }); // 방금 갱신됨
      const outcome = await finishRun(pool, id, { origin: 'orphan_sweep', staleThresholdMs: 1000 });
      expect(outcome).toBe('precondition_no_longer_met');
      const row = await fetchRow(id);
      expect(row.status).toBe('running');
    });

    it('orphan_sweep — 실제로 heartbeat가 stale하면 failed(PROCESS_ERROR)로 종결 + 감사 기록', async () => {
      const { id, analysisRunId } = await insertRow({ status: 'running', heartbeatAt: new Date(Date.now() - 5000) });
      const outcome = await finishRun(pool, id, { origin: 'orphan_sweep', staleThresholdMs: 1000 });
      expect(outcome).toBe('finalized');
      const row = await fetchRow(id);
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('PROCESS_ERROR');
      expect(row.frozen_dataset).toBeNull();
      const audits = await auditRowsFor(analysisRunId);
      expect(audits).toHaveLength(1);
      expect(audits[0].outcome).toBe('failure');
      expect(audits[0].extra.origin).toBe('orphan_sweep');
    });

    it('queue_wait_sweep — created_at이 아직 예산 안이면 precondition_no_longer_met', async () => {
      const { id } = await insertRow({ status: 'queued', createdAt: new Date() });
      const outcome = await finishRun(pool, id, { origin: 'queue_wait_sweep', queueWaitMs: 600000 });
      expect(outcome).toBe('precondition_no_longer_met');
    });

    it('queue_wait_sweep — 예산을 넘겼으면 failed(QUEUE_WAIT_EXCEEDED)로 종결', async () => {
      const { id, analysisRunId } = await insertRow({ status: 'queued', createdAt: new Date(Date.now() - 700000) });
      const outcome = await finishRun(pool, id, { origin: 'queue_wait_sweep', queueWaitMs: 600000 });
      expect(outcome).toBe('finalized');
      const row = await fetchRow(id);
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('QUEUE_WAIT_EXCEEDED');
      const audits = await auditRowsFor(analysisRunId);
      expect(audits[0].extra.origin).toBe('queue_wait_sweep');
    });

    it('queue_wait_sweep — started_at이 이미 있으면(그 사이 claim됨) precondition_no_longer_met', async () => {
      const { id } = await insertRow({ status: 'queued', createdAt: new Date(Date.now() - 700000), startedAt: new Date() });
      const outcome = await finishRun(pool, id, { origin: 'queue_wait_sweep', queueWaitMs: 600000 });
      expect(outcome).toBe('precondition_no_longer_met');
    });

    it('queued_cancel_sweep — cancel_requested_at 없으면 precondition_no_longer_met, 있으면 cancelled로 종결', async () => {
      const { id: idA } = await insertRow({ status: 'queued' });
      expect(await finishRun(pool, idA, { origin: 'queued_cancel_sweep' })).toBe('precondition_no_longer_met');

      const { id: idB, analysisRunId } = await insertRow({ status: 'queued', cancelRequestedAt: new Date() });
      expect(await finishRun(pool, idB, { origin: 'queued_cancel_sweep' })).toBe('finalized');
      const row = await fetchRow(idB);
      expect(row.status).toBe('cancelled');
      const audits = await auditRowsFor(analysisRunId);
      expect(audits[0].extra.origin).toBe('queued_cancel_sweep');
    });

    it('computed — 취소가 요청된 running 행은 succeeded outcome이 와도 cancelled로 덮어써진다(§E 최종수렴)', async () => {
      const { id, analysisRunId } = await insertRow({ status: 'running', cancelRequestedAt: new Date() });
      const outcome = await finishRun(pool, id, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } });
      expect(outcome).toBe('finalized');
      const row = await fetchRow(id);
      expect(row.status).toBe('cancelled');
      expect(row.result).toBeNull();
      const audits = await auditRowsFor(analysisRunId);
      expect(audits[0].extra.runStatus).toBe('cancelled');
    });

    it('computed — 정상 succeeded는 cacheable=true로 종결되고 감사가 1건 남는다(폴링 없는 백그라운드 완결도 감사됨, §검증10)', async () => {
      const { id, analysisRunId } = await insertRow({ status: 'running' });
      const outcome = await finishRun(pool, id, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } });
      expect(outcome).toBe('finalized');
      const row = await fetchRow(id);
      expect(row.status).toBe('succeeded');
      expect(row.cacheable).toBe(true);
      const audits = await auditRowsFor(analysisRunId);
      expect(audits).toHaveLength(1);
      expect(audits[0].outcome).toBe('success');
    });

    // routes/__tests__/stats.test.ts의 "감사 INSERT가 실패하면 같은 트랜잭션의 stats_runs
    // INSERT도 롤백되고 500을 반환한다" 테스트의 실제 등가물 — 그 원자성은 이제
    // writeTerminalOutcome(finishRun 내부)이 담당한다. writeAuditLogStrict가 던지면
    // withWriteTransaction이 ROLLBACK 후 rethrow하므로, 상태 UPDATE도 함께 사라져야 한다.
    it('감사 INSERT가 실패하면 같은 트랜잭션의 상태 UPDATE도 롤백된다(원자성)', async () => {
      const { id } = await insertRow({ status: 'running' });
      writeAuditLogStrictSpy.mockRejectedValueOnce(new Error('audit db down'));

      await expect(
        finishRun(pool, id, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } }),
      ).rejects.toThrow('audit db down');

      const row = await fetchRow(id);
      expect(row.status).toBe('running'); // succeeded로 바뀌지 않고 롤백됨
      expect(row.result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // §검증 4-1/4-3 — 만료 캐시 교체 vs "유효한 다른 succeeded 행과 동시 존재"
  // -------------------------------------------------------------------------
  describe('succeeded 종결 — 같은 execution_digest의 다른 succeeded 행과의 상호작용', () => {
    it('4-1: 만료된 cacheable 성공 행은 DELETE되고 새 행이 cacheable=true로 종결된다', async () => {
      const digest = digestFor('shared-recipe', 'shared-source');
      const expired = await insertRow({
        recipeDigest: 'shared-recipe', sourceDigest: 'shared-source', executionDigest: digest,
        status: 'succeeded', expiresAt: new Date(Date.now() - 3600 * 1000), cacheable: true,
      });
      const { id: newId } = await insertRow({
        recipeDigest: 'shared-recipe', sourceDigest: 'shared-source', executionDigest: digest, status: 'running',
      });

      const outcome = await finishRun(pool, newId, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } });
      expect(outcome).toBe('finalized');

      const newRow = await fetchRow(newId);
      expect(newRow.status).toBe('succeeded');
      expect(newRow.cacheable).toBe(true);
      const oldRow = await fetchRow(expired.id);
      expect(oldRow).toBeUndefined(); // DELETE됨
    });

    it('4-3(9차 핵심 레이스): 유효한 다른 succeeded 행이 이미 있으면 새 행은 cacheable=false로, 자기 analysisRunId·자기 result를 유지한 채 종결된다(유니크 인덱스 위반 없음)', async () => {
      const digest = digestFor('shared-recipe-2', 'shared-source-2');
      const existingValid = await insertRow({
        recipeDigest: 'shared-recipe-2', sourceDigest: 'shared-source-2', executionDigest: digest,
        status: 'succeeded', expiresAt: new Date(Date.now() + 3600 * 1000), cacheable: true,
      });
      const raceResult = { continuous: [], discrete: [], _raceMarker: true } as unknown as AnalyzeResult;
      const { id: newId, analysisRunId: newAnalysisRunId } = await insertRow({
        recipeDigest: 'shared-recipe-2', sourceDigest: 'shared-source-2', executionDigest: digest, status: 'running',
      });

      const outcome = await finishRun(pool, newId, { origin: 'computed', outcome: { kind: 'succeeded', result: raceResult } });
      expect(outcome).toBe('finalized'); // stats_runs_succeeded_uniq 위반으로 throw되지 않음

      const newRow = await fetchRow(newId);
      expect(newRow.status).toBe('succeeded');
      expect(newRow.cacheable).toBe(false); // 유효한 A가 있으므로 자기 자신은 캐시 대상에서 빠짐
      expect(newRow.analysis_run_id).toBe(newAnalysisRunId); // 자기 analysisRunId 유지
      expect(newRow.result).toEqual(raceResult); // 자기가 계산한 result 유지(A의 result로 대체 안 됨)

      const oldRow = await fetchRow(existingValid.id);
      expect(oldRow.status).toBe('succeeded');
      expect(oldRow.cacheable).toBe(true); // A는 그대로 유효한 캐시로 남음
    });
  });

  // -------------------------------------------------------------------------
  // requeueOrFinish — §검증 6
  // -------------------------------------------------------------------------
  describe('requeueOrFinish', () => {
    it('running이 아닌 행은 아무 것도 하지 않는다', async () => {
      const { id } = await insertRow({ status: 'queued' });
      await requeueOrFinish(pool, id);
      const row = await fetchRow(id);
      expect(row.status).toBe('queued');
    });

    it('BUSY 재큐잉 — started_at/heartbeat_at/worker_pid를 초기화하고 requeue_count를 증가시키며 감사는 남기지 않는다', async () => {
      const { id, analysisRunId } = await insertRow({ status: 'running', requeueCount: 2 });
      await requeueOrFinish(pool, id);
      const row = await fetchRow(id);
      expect(row.status).toBe('queued');
      expect(row.started_at).toBeNull();
      expect(row.heartbeat_at).toBeNull();
      expect(row.worker_pid).toBeNull();
      expect(row.requeue_count).toBe(3);
      expect(await auditRowsFor(analysisRunId)).toHaveLength(0); // 종결이 아니므로 감사 없음
    });

    it('requeue_count가 한도(maxRequeueCount)에 도달하면 failed(PROCESS_ERROR)로 종결된다', async () => {
      const { id, analysisRunId } = await insertRow({ status: 'running', requeueCount: config.stats.async.maxRequeueCount });
      await requeueOrFinish(pool, id);
      const row = await fetchRow(id);
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('PROCESS_ERROR');
      const audits = await auditRowsFor(analysisRunId);
      expect(audits[0].extra.origin).toBe('requeue_limit_exceeded');
    });

    it('재큐잉 시도 중 취소가 요청돼 있으면 cancelled로 종결된다', async () => {
      const { id, analysisRunId } = await insertRow({ status: 'running', cancelRequestedAt: new Date() });
      await requeueOrFinish(pool, id);
      const row = await fetchRow(id);
      expect(row.status).toBe('cancelled');
      const audits = await auditRowsFor(analysisRunId);
      expect(audits[0].extra.origin).toBe('requeue_cancel');
    });
  });

  // -------------------------------------------------------------------------
  // claimNextQueuedRun — §검증 4-5/4-6/12
  // -------------------------------------------------------------------------
  describe('claimNextQueuedRun — claim 자격', () => {
    it('cancel_requested_at이 있는 행은 claim하지 않는다', async () => {
      await insertRow({ status: 'queued', cancelRequestedAt: new Date() });
      const claimed = await claimNextQueuedRun(pool, 600000);
      expect(claimed).toBeNull();
    });

    it('이미 만료(expires_at 지남)된 행은 claim하지 않는다', async () => {
      await insertRow({ status: 'queued', expiresAt: new Date(Date.now() - 1000) });
      const claimed = await claimNextQueuedRun(pool, 600000);
      expect(claimed).toBeNull();
    });

    it('claim되면 status=running, started_at/heartbeat_at이 채워진다', async () => {
      const { id } = await insertRow({ status: 'queued' });
      const claimed = await claimNextQueuedRun(pool, 600000);
      expect(claimed?.id).toBe(id);
      expect(claimed?.status).toBe('running');
      expect(claimed?.started_at).not.toBeNull();
      expect(claimed?.heartbeat_at).not.toBeNull();
    });

    it('11차 경계값 — created_at이 cutoff보다 미래(claim 가능 구간)면 claim되고 queue_wait_sweep은 손대지 않는다', async () => {
      const queueWaitMs = 1000;
      const { rows: nowRows } = await pool.query<{ now: Date }>('SELECT now() AS now');
      const cutoff = new Date(nowRows[0].now.getTime() - queueWaitMs);
      const { id } = await insertRow({ status: 'queued', createdAt: new Date(cutoff.getTime() + 50) });

      const claimed = await claimNextQueuedRun(pool, queueWaitMs);
      expect(claimed?.id).toBe(id);

      // 이미 running이므로 queue_wait_sweep 전제조건(status==='queued')에서 걸러진다.
      const outcome = await finishRun(pool, id, { origin: 'queue_wait_sweep', queueWaitMs });
      expect(outcome).toBe('precondition_no_longer_met');
    });

    it('11차 경계값 — created_at이 정확히 cutoff와 같으면(claim `>` 불가·sweep `<=` 가능, 정확한 여집합) claim은 스킵하고 queue_wait_sweep이 종결한다', async () => {
      const queueWaitMs = 1000;
      const { rows: nowRows } = await pool.query<{ now: Date }>('SELECT now() AS now');
      const cutoff = new Date(nowRows[0].now.getTime() - queueWaitMs);
      const { id } = await insertRow({ status: 'queued', createdAt: cutoff });

      // claim 호출 시점의 now()는 cutoff 계산 시점보다 항상 같거나 늦으므로(시간은 거꾸로
      // 안 간다) claim의 자체 cutoff' >= cutoff이고, row.created_at(=cutoff) > cutoff'는
      // 항상 거짓이다 — claim 불가가 결정적으로 보장된다.
      const claimed = await claimNextQueuedRun(pool, queueWaitMs);
      expect(claimed).toBeNull();

      // 같은 이유로 row.created_at(=cutoff) <= cutoff''는 항상 참 — sweep 종결이 결정적으로 보장된다.
      const outcome = await finishRun(pool, id, { origin: 'queue_wait_sweep', queueWaitMs });
      expect(outcome).toBe('finalized');
      const row = await fetchRow(id);
      expect(row.error_code).toBe('QUEUE_WAIT_EXCEEDED');
    });

    it('11차 경계값 — created_at이 cutoff보다 과거(sweep 전용 구간)면 claim은 스킵하고 queue_wait_sweep이 종결한다', async () => {
      const queueWaitMs = 1000;
      const { id } = await insertRow({ status: 'queued', createdAt: new Date(Date.now() - queueWaitMs - 5000) });

      const claimed = await claimNextQueuedRun(pool, queueWaitMs);
      expect(claimed).toBeNull();

      const outcome = await finishRun(pool, id, { origin: 'queue_wait_sweep', queueWaitMs });
      expect(outcome).toBe('finalized');
    });

    it('FOR UPDATE SKIP LOCKED — created_at 오름차순으로 하나만 claim한다', async () => {
      const older = await insertRow({ status: 'queued', createdAt: new Date(Date.now() - 5000) });
      const newer = await insertRow({ status: 'queued', createdAt: new Date(Date.now() - 1000) });
      const claimed1 = await claimNextQueuedRun(pool, 600000);
      expect(claimed1?.id).toBe(older.id);
      const claimed2 = await claimNextQueuedRun(pool, 600000);
      expect(claimed2?.id).toBe(newer.id);
      const claimed3 = await claimNextQueuedRun(pool, 600000);
      expect(claimed3).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // sweepStale/sweepQueuedTerminal — 후보 선정+finishRun 배선 자체의 검증(§검증 7/12)
  // -------------------------------------------------------------------------
  describe('sweep 배선', () => {
    it('sweepStale은 engine_timeout_ms 기준으로 stale한 running 행만 회수하고 신선한 행은 건드리지 않는다', async () => {
      const stale = await insertRow({ status: 'running', engineTimeoutMs: 100, heartbeatAt: new Date(Date.now() - 60000) });
      const fresh = await insertRow({ status: 'running', engineTimeoutMs: 60000, heartbeatAt: new Date() });

      await sweepStale(pool);

      expect((await fetchRow(stale.id)).status).toBe('failed');
      expect((await fetchRow(fresh.id)).status).toBe('running');
    });

    it('sweepQueuedTerminal은 취소요청 queued 행과 대기예산초과 queued 행을 각각 종결시킨다', async () => {
      const cancelled = await insertRow({ status: 'queued', cancelRequestedAt: new Date() });
      const expired = await insertRow({ status: 'queued', createdAt: new Date(Date.now() - config.stats.async.queueWaitMs - 5000) });
      const alive = await insertRow({ status: 'queued', createdAt: new Date() });

      await sweepQueuedTerminal(pool);

      expect((await fetchRow(cancelled.id)).status).toBe('cancelled');
      expect((await fetchRow(expired.id)).status).toBe('failed');
      expect((await fetchRow(expired.id)).error_code).toBe('QUEUE_WAIT_EXCEEDED');
      expect((await fetchRow(alive.id)).status).toBe('queued');
    });
  });

  // -------------------------------------------------------------------------
  // requestCancel — §검증 5(취소 5개 레이스 + 멱등성 중 DB로 증명 가능한 부분)
  // -------------------------------------------------------------------------
  describe('requestCancel', () => {
    it('queued 행 취소 — cancel_requested_at 설정 + 감사 기록 + 200 상당(outcome:cancelled)', async () => {
      const { analysisRunId } = await insertRow({ status: 'queued' });
      const result = await requestCancel(pool, analysisRunId, orgId, userId);
      expect(result.outcome).toBe('cancelled');
      const audits = await auditRowsFor(analysisRunId);
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('stats_run_cancel');
      expect(audits[0].outcome).toBe('success');
    });

    it('running 행 취소도 동일하게 동작한다', async () => {
      const { analysisRunId, id } = await insertRow({ status: 'running' });
      const result = await requestCancel(pool, analysisRunId, orgId, userId);
      expect(result.outcome).toBe('cancelled');
      const row = await fetchRow(id);
      expect(row.cancel_requested_at).not.toBeNull();
      expect(row.status).toBe('running'); // 의도 확정일 뿐 — 실제 종결은 finishRun/워커 몫
    });

    it('이미 취소된 행에 다시 취소를 요청하면 멱등 성공(outcome:cancelled, idempotent:true)', async () => {
      const { analysisRunId } = await insertRow({ status: 'cancelled' });
      const result = await requestCancel(pool, analysisRunId, orgId, userId);
      expect(result.outcome).toBe('cancelled');
      const audits = await auditRowsFor(analysisRunId);
      expect(audits[0].extra.idempotent).toBe(true);
    });

    it('succeeded/failed처럼 이미 종결된 행은 already_terminal(409 상당)', async () => {
      const { analysisRunId: succeededId } = await insertRow({ status: 'succeeded' });
      expect((await requestCancel(pool, succeededId, orgId, userId)).outcome).toBe('already_terminal');

      const { analysisRunId: failedId } = await insertRow({ status: 'failed' });
      expect((await requestCancel(pool, failedId, orgId, userId)).outcome).toBe('already_terminal');
    });

    it('존재하지 않는 analysisRunId는 not_found(404 상당)', async () => {
      const result = await requestCancel(pool, crypto.randomUUID(), orgId, userId);
      expect(result.outcome).toBe('not_found');
    });

    it('다른 조직의 analysisRunId는 not_found로 취급된다(cross-org)', async () => {
      const otherOrg = await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, ['__test_statsRunsQueue_other_org__']);
      try {
        const { analysisRunId } = await insertRow({ status: 'queued' });
        const result = await requestCancel(pool, analysisRunId, otherOrg.rows[0].id, userId);
        expect(result.outcome).toBe('not_found');
      } finally {
        await pool.query(`DELETE FROM organizations WHERE id=$1`, [otherOrg.rows[0].id]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // §검증 5(d) — finishRun과 requestCancel의 동시 커밋 경합. 정확히 어느 쪽이 이기는지는
  // 실제 wall-clock 타이밍에 달려 있어 결정할 수 없지만(그래서 검증 대상은 "결과가
  // 손상되지 않는다"이지 "항상 이런 순서로 이긴다"가 아니다), 두 트랜잭션 모두
  // SELECT...FOR UPDATE/조건부 UPDATE로 같은 행을 잠그므로 직렬화되어 어느 한쪽만
  // 유효한 최종 상태로 남아야 한다(succeeded 또는 cancelled 둘 중 하나, 예외 없이).
  // -------------------------------------------------------------------------
  it('finishRun(succeeded)과 requestCancel을 동시에 걸어도 최종 상태는 손상 없이 하나로 수렴한다', async () => {
    const { id, analysisRunId } = await insertRow({ status: 'running' });

    const [finishOutcome] = await Promise.all([
      finishRun(pool, id, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } }),
      requestCancel(pool, analysisRunId, orgId, userId),
    ]);

    expect(finishOutcome).toBe('finalized'); // finishRun은 cancel_requested_at 유무와 무관하게 항상 스스로 종결시킨다
    const row = await fetchRow(id);
    expect(['succeeded', 'cancelled']).toContain(row.status);
    expect(row.finished_at).not.toBeNull();
    // 두 쓰기 모두 감사를 남기므로(stats_analyze from finishRun, stats_run_cancel from
    // requestCancel — 서로 다른 action) 경합이 있어도 감사 유실은 없어야 한다.
    const { rows: allAudits } = await pool.query(
      `SELECT action FROM audit_logs WHERE actor_org_id=$1 AND extra->>'analysisRunId'=$2 ORDER BY action`,
      [orgId, analysisRunId],
    );
    expect(allAudits.map((r) => r.action)).toEqual(['stats_analyze', 'stats_run_cancel']);
  });
});

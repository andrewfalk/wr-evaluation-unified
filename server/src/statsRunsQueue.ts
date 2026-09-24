// PR4-B1 §C/D/D-1/E — 백그라운드 워커(sweepLoop/claimLoop 독립 루프), finishRun
// (잠금+상태전이+감사를 한 트랜잭션), requeueOrFinish(BUSY 재큐잉), 취소.
// 계획서(pr4-b-virtual-pnueli.md) 11차 통합본 참고.
import type { Pool, PoolClient } from 'pg';
import type { AnalyzeResult } from '@wr/contracts';
import type { AnalysisContext, FrozenAnalysisInput } from './statsAnalysisContext';
import { deriveAnalysisContext } from './statsAnalysisContext';
import { STATS_RUN_COLUMNS, type StatsRunRow } from './statsRunRow';
import {
  buildFailedStatsRunManifest,
  buildCancelledStatsRunManifest,
  toStatsRunManifestSucceeded,
} from './statsRunManifest';
import { canonicalDigest } from './canonicalSerializer';
import { computeExecutionDigest } from './statsExecutionDigest';
import {
  runStatsEngine,
  StatsEngineBusyError,
  StatsEngineCancelledError,
  isEngineSlotAvailable,
  type EngineRunOpts,
} from './statsEngine';
import { buildStatsEngineRequest, computeDescriptiveSuppression } from './statsDescriptiveSuppression';
import { computeBivariateAnalyzeResult } from './statsBivariateSuppression';
import { computeCorrelationMatrixAnalyzeResult } from './statsCorrelationMatrixSuppression';
import { computeRegressionAnalyzeResult } from './statsRegressionSuppression';
import { errorCodeForFailure } from './statsEngineErrorMapping';
import { writeAuditLogStrict, type AuditOutcome } from './middleware/audit';
import { withWriteTransaction } from './db/withWriteTransaction';
import { statsRunExpiresAt } from './statsRunExpiry';
import config from './config';

// ---------------------------------------------------------------------------
// registry — 같은 Node 프로세스 안에서만 유효(statsAnalyzeInFlight.ts·
// videoAnalysisWorker.ts와 동일한 "단일 인스턴스 배포" 전제). 취소가 이 registry에
// 없는 analysisRunId를 찾으면 아무 신호도 보내지 않는다(PID 재사용 위험 회피 —
// DB에 남은 worker_pid로 직접 kill하지 않음).
// ---------------------------------------------------------------------------
interface ActiveRun {
  controller: AbortController;
  pid: number | null;
}
const activeRuns = new Map<string, ActiveRun>();

/** 테스트 전용. */
export function __resetStatsRunsQueueForTests(): void {
  activeRuns.clear();
}
export function __getActiveRunsSizeForTests(): number {
  return activeRuns.size;
}

// ---------------------------------------------------------------------------
// §0 보존정책 — descriptive/bivariate/regression은 limited_row 재구성이 필요하므로
// 성공 후에도 expires_at까지 보존. correlation_matrix만 그 메커니즘이 없으므로
// 성공 확정 직후 즉시 NULL화. 모든 실패/취소/orphan/버전드리프트 종결은
// analysisMode 무관하게 즉시 NULL화.
// ---------------------------------------------------------------------------
function frozenDatasetAfterSuccess(analysisMode: string, frozen: FrozenAnalysisInput | null): FrozenAnalysisInput | null {
  if (analysisMode === 'correlation_matrix') return null;
  return frozen;
}

// ---------------------------------------------------------------------------
// writeTerminalOutcome — §D-1(requeueOrFinish)과 §D(finishRun) 공유 헬퍼. status/
// result/manifest/frozen_dataset을 쓰는 코드가 정확히 한 곳에만 있다.
// ---------------------------------------------------------------------------
type TerminalOutcome =
  | { kind: 'succeeded'; result: AnalyzeResult }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'cancelled' };

async function writeTerminalOutcome(
  client: PoolClient,
  row: StatsRunRow,
  outcome: TerminalOutcome,
  origin: string,
): Promise<'finalized'> {
  const analysisMode = row.manifest.analysisMode ?? 'descriptive';
  const formulaPolicies = row.manifest.formulaPolicies;

  if (outcome.kind === 'succeeded') {
    // 만료된 동일 digest cacheable 성공 행을 먼저 정리(기존 sync computeAndPersist의
    // DELETE-then-write 패턴, statsAnalyzeHandler.ts). 그 후에도 유효한(만료 안 된)
    // cacheable 성공 행이 남아있으면(admission 캐시확인~합류확인 사이 완료 레이스,
    // §D 주석 참고) 이 행은 cacheable=false로 자기 analysisRunId·자기 result를
    // 유지한 채 종결한다 — unique index는 cacheable 행에만 걸리므로 충돌 없음.
    await client.query(
      `DELETE FROM stats_runs
        WHERE organization_id=$1 AND execution_digest=$2 AND status='succeeded' AND cacheable AND expires_at<=now()`,
      [row.organization_id, row.execution_digest],
    );
    const stillValid = await client.query(
      `SELECT 1 FROM stats_runs
        WHERE organization_id=$1 AND execution_digest=$2 AND status='succeeded' AND cacheable AND expires_at>now() AND id != $3`,
      [row.organization_id, row.execution_digest, row.id],
    );
    const cacheable = stillValid.rows.length === 0;

    const resultDigest = canonicalDigest({ result: outcome.result });
    const manifest = toStatsRunManifestSucceeded({
      analysisRunId: row.analysis_run_id,
      snapshotAsOf: row.manifest.snapshotAsOf,
      recipeDigest: row.recipe_digest,
      sourceDigest: row.source_digest,
      resultDigest,
      catalogVersion: row.manifest.catalogVersion,
      extractorVersion: row.manifest.extractorVersion,
      migrationVersion: row.manifest.migrationVersion,
      formulaPolicies,
      estimabilityPolicyVersion: row.manifest.estimabilityPolicyVersion,
      engineVersion: row.manifest.engineVersion,
      serializerVersion: row.manifest.serializerVersion,
      inferenceGatePolicyVersion: row.manifest.inferenceGatePolicyVersion,
      analysisMode: analysisMode as 'descriptive' | 'bivariate' | 'correlation_matrix' | 'regression',
    });
    await client.query(
      `UPDATE stats_runs SET status='succeeded', cacheable=$2, result=$3, manifest=$4,
         finished_at=now(), frozen_dataset=$5 WHERE id=$1`,
      [
        row.id, cacheable, JSON.stringify(outcome.result), JSON.stringify(manifest),
        frozenDatasetAfterSuccess(analysisMode, row.frozen_dataset) ? JSON.stringify(row.frozen_dataset) : null,
      ],
    );
    await writeAuditLogStrict(client, {
      actorUserId: row.requested_by, actorOrgId: row.organization_id, action: 'stats_analyze',
      targetType: 'analysis_recipe', targetId: row.recipe_digest,
      outcome: 'success' as AuditOutcome,
      extra: { analysisRunId: row.analysis_run_id, executionDigest: row.execution_digest, runStatus: 'succeeded', origin },
    });
    return 'finalized';
  }

  if (outcome.kind === 'failed') {
    const manifest = buildFailedStatsRunManifest({
      recipeDigest: row.recipe_digest, sourceDigest: row.source_digest, snapshotAsOf: row.manifest.snapshotAsOf,
      formulaPolicies, analysisMode: analysisMode as 'descriptive' | 'bivariate' | 'correlation_matrix' | 'regression',
      analysisRunId: row.analysis_run_id,
    });
    await client.query(
      `UPDATE stats_runs SET status='failed', error_code=$2, manifest=$3, result=NULL,
         finished_at=now(), frozen_dataset=NULL WHERE id=$1`,
      [row.id, outcome.errorCode, JSON.stringify(manifest)],
    );
    await writeAuditLogStrict(client, {
      actorUserId: row.requested_by, actorOrgId: row.organization_id, action: 'stats_analyze',
      targetType: 'analysis_recipe', targetId: row.recipe_digest,
      outcome: 'failure' as AuditOutcome,
      extra: { analysisRunId: row.analysis_run_id, executionDigest: row.execution_digest, runStatus: 'failed', errorCode: outcome.errorCode, origin },
    });
    return 'finalized';
  }

  // cancelled
  const manifest = buildCancelledStatsRunManifest({
    recipeDigest: row.recipe_digest, sourceDigest: row.source_digest, snapshotAsOf: row.manifest.snapshotAsOf,
    formulaPolicies, analysisMode: analysisMode as 'descriptive' | 'bivariate' | 'correlation_matrix' | 'regression',
    analysisRunId: row.analysis_run_id,
  });
  await client.query(
    `UPDATE stats_runs SET status='cancelled', manifest=$2, result=NULL, error_code=NULL,
       finished_at=now(), frozen_dataset=NULL WHERE id=$1`,
    [row.id, JSON.stringify(manifest)],
  );
  await writeAuditLogStrict(client, {
    actorUserId: row.requested_by, actorOrgId: row.organization_id, action: 'stats_analyze',
    targetType: 'analysis_recipe', targetId: row.recipe_digest,
    outcome: 'failure' as AuditOutcome,
    extra: { analysisRunId: row.analysis_run_id, executionDigest: row.execution_digest, runStatus: 'cancelled', origin },
  });
  return 'finalized';
}

// ---------------------------------------------------------------------------
// §D finishRun — spec.origin별 전제조건을 잠금 안에서 재검증한다. sweep이 후보를
// 잠금 밖에서 고른 뒤 여기 넘기므로, 후보 선정~호출 사이에 조건이 사라졌어도
// 'precondition_no_longer_met'로 안전하게 스킵된다.
// ---------------------------------------------------------------------------
export type FinishSpec =
  | { origin: 'computed'; outcome: TerminalOutcome }
  | { origin: 'orphan_sweep'; staleThresholdMs: number }
  | { origin: 'queue_wait_sweep'; queueWaitMs: number }
  | { origin: 'queued_cancel_sweep' };

export type FinishRunResult = 'finalized' | 'precondition_no_longer_met' | 'already_terminal';

export async function finishRun(pool: Pool, rowId: string, spec: FinishSpec): Promise<FinishRunResult> {
  return withWriteTransaction(pool, async (client) => {
    // queue_wait_sweep 판정은 DB 시계(now()) 기준 계산 컬럼으로 가져온다 — Node
    // Date.now() 산술을 쓰지 않는다(claim의 created_at > cutoff와 경계를 맞추기 위함,
    // 둘 다 같은 SQL now()를 쓰므로 시계 소스가 항상 일치한다).
    const queueWaitMs = spec.origin === 'queue_wait_sweep' ? spec.queueWaitMs : 0;
    const { rows } = await client.query<StatsRunRow & { queue_wait_exceeded: boolean }>(
      `SELECT ${STATS_RUN_COLUMNS},
              (created_at <= now() - ($2 * interval '1 millisecond')) AS queue_wait_exceeded
         FROM stats_runs WHERE id=$1 FOR UPDATE`,
      [rowId, queueWaitMs],
    );
    const row = rows[0];
    if (!row || (['succeeded', 'failed', 'cancelled'] as const).includes(row.status as 'succeeded' | 'failed' | 'cancelled')) {
      return 'already_terminal';
    }

    switch (spec.origin) {
      case 'computed':
        // attempt()가 claim으로 단독 소유하므로 status는 항상 'running'이지만,
        // 검증 비용이 작으므로 방어적으로 한 번 더 확인한다.
        if (row.status !== 'running') return 'precondition_no_longer_met';
        break;
      case 'orphan_sweep':
        if (row.status !== 'running' || !row.heartbeat_at || row.heartbeat_at.getTime() >= Date.now() - spec.staleThresholdMs) {
          return 'precondition_no_longer_met'; // 후보 선정 이후 heartbeat가 갱신됐으면 중단
        }
        break;
      case 'queue_wait_sweep':
        if (row.status !== 'queued' || row.started_at != null || !row.queue_wait_exceeded) {
          return 'precondition_no_longer_met';
        }
        break;
      case 'queued_cancel_sweep':
        if (row.status !== 'queued' || row.cancel_requested_at == null) {
          return 'precondition_no_longer_met';
        }
        break;
    }

    // 취소가 항상 우선한다 — computed의 succeeded/failed조차 덮어쓴다.
    const outcome: TerminalOutcome = row.cancel_requested_at != null
      ? { kind: 'cancelled' }
      : spec.origin === 'computed' ? spec.outcome
      : spec.origin === 'orphan_sweep' ? { kind: 'failed', errorCode: 'PROCESS_ERROR' }
      : spec.origin === 'queue_wait_sweep' ? { kind: 'failed', errorCode: 'QUEUE_WAIT_EXCEEDED' }
      : { kind: 'cancelled' }; // queued_cancel_sweep

    return writeTerminalOutcome(client, row, outcome, spec.origin);
  });
}

// ---------------------------------------------------------------------------
// §D-1 requeueOrFinish — BUSY 재큐잉. writeTerminalOutcome을 공유하므로 취소·한도
// 초과 분기의 종결 로직이 finishRun과 정확히 같은 코드를 탄다.
// ---------------------------------------------------------------------------
export async function requeueOrFinish(pool: Pool, rowId: string): Promise<void> {
  await withWriteTransaction(pool, async (client) => {
    const { rows } = await client.query<StatsRunRow>(
      `SELECT ${STATS_RUN_COLUMNS} FROM stats_runs WHERE id=$1 FOR UPDATE`,
      [rowId],
    );
    const row = rows[0];
    if (!row || row.status !== 'running') return; // 이미 다른 경로가 종결시킴

    if (row.cancel_requested_at != null) {
      await writeTerminalOutcome(client, row, { kind: 'cancelled' }, 'requeue_cancel');
      return;
    }
    if (row.requeue_count >= config.stats.async.maxRequeueCount) {
      await writeTerminalOutcome(client, row, { kind: 'failed', errorCode: 'PROCESS_ERROR' }, 'requeue_limit_exceeded');
      return;
    }
    await client.query(
      `UPDATE stats_runs SET status='queued', started_at=NULL, heartbeat_at=NULL,
         worker_pid=NULL, requeue_count=requeue_count+1 WHERE id=$1`,
      [row.id],
    );
    // 종결이 아니므로 감사 없음 — job은 계속 진행 중.
  });
}

// ---------------------------------------------------------------------------
// claim — videoAnalysisWorker.ts의 claimJob() 패턴(FOR UPDATE SKIP LOCKED)을 그대로
// 가져오되, queueWaitMs 조건을 claim 쪽에도 넣는다 — 안 넣으면 sweepLoop가 아직
//못 치웠을 때 더 자주 도는 claimLoop가 이미 대기예산을 넘긴 행을 먼저 채갈 수
// 있다. claim 가능 구간(created_at > cutoff)과 sweep 종결 가능 구간(created_at <=
// cutoff, finishRun의 queue_wait_exceeded)이 정확히 여집합이 되도록 경계를 맞췄다
// — 둘 다 DB now()를 쓰므로 시계 소스도 일치한다.
// ---------------------------------------------------------------------------
export async function claimNextQueuedRun(pool: Pool, queueWaitMs: number): Promise<StatsRunRow | null> {
  const { rows } = await pool.query<StatsRunRow>(
    `UPDATE stats_runs SET status='running', started_at=now(), heartbeat_at=now()
       WHERE id = (
         SELECT id FROM stats_runs
          WHERE status='queued' AND cancel_requested_at IS NULL AND expires_at>now()
            AND created_at > now() - ($1 * interval '1 millisecond')
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
     RETURNING ${STATS_RUN_COLUMNS}`,
    [queueWaitMs],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// sweepStale — running 행 orphan(heartbeat 만료) 회수. 행별 engine_timeout_ms 기준
// staleThresholdMs를 각 후보마다 계산해 finishRun에 넘긴다(전역 상수 아님).
// ---------------------------------------------------------------------------
export async function sweepStale(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ id: string; engine_timeout_ms: number }>(
    `SELECT id, engine_timeout_ms FROM stats_runs WHERE status='running'`,
  );
  for (const row of rows) {
    const staleThresholdMs = row.engine_timeout_ms + config.stats.killGraceMs + config.stats.async.staleSafetyMs;
    await finishRun(pool, row.id, { origin: 'orphan_sweep', staleThresholdMs });
  }
}

// ---------------------------------------------------------------------------
// sweepQueuedTerminal — queued 취소 확정 + 대기예산초과. 후보를 잠금 없이 조회한
// 뒤 finishRun에 넘긴다(전제조건 재검증은 finishRun 내부에서).
// ---------------------------------------------------------------------------
export async function sweepQueuedTerminal(pool: Pool): Promise<void> {
  const cancelled = await pool.query<{ id: string }>(
    `SELECT id FROM stats_runs WHERE status='queued' AND cancel_requested_at IS NOT NULL`,
  );
  for (const row of cancelled.rows) {
    await finishRun(pool, row.id, { origin: 'queued_cancel_sweep' });
  }

  const expired = await pool.query<{ id: string }>(
    `SELECT id FROM stats_runs WHERE status='queued' AND started_at IS NULL
       AND created_at <= now() - ($1 * interval '1 millisecond')`,
    [config.stats.async.queueWaitMs],
  );
  for (const row of expired.rows) {
    await finishRun(pool, row.id, { origin: 'queue_wait_sweep', queueWaitMs: config.stats.async.queueWaitMs });
  }
}

// ---------------------------------------------------------------------------
// §5 버전 드리프트 — claim 시점에 현재 코드의 버전 상수 전부로 execution_digest를
// 재계산해 행의 execution_digest와 비교한다.
// ---------------------------------------------------------------------------
// GET /runs/:analysisRunId(routes/stats.ts)도 limited_row 재구성 직전 이 함수로
// 버전드리프트를 다시 확인한다(§H — 드리프트 시 attached:false로 저하, 이미 저장된
// aggregate result 자체는 그대로 서빙).
export function hasVersionDrifted(row: StatsRunRow): boolean {
  const recomputed = computeExecutionDigest({
    organizationId: row.organization_id,
    requestedBy: row.requested_by ?? '',
    recipeDigest: row.recipe_digest,
    sourceDigest: row.source_digest,
  });
  return recomputed !== row.execution_digest;
}

// ---------------------------------------------------------------------------
// runEngineFor — analysisMode별로 적절한 엔진 계산 함수를 호출한다. computeAndPersist
// (statsAnalyzeHandler.ts)와 정확히 같은 분기 — 로직 복제가 아니라 같은 compute*
// 함수를 opts와 함께 재사용한다.
// ---------------------------------------------------------------------------
async function runEngineFor(ctx: AnalysisContext, opts: EngineRunOpts): Promise<AnalyzeResult> {
  if (ctx.recipe.analysisMode === 'bivariate') {
    const bivariate = await computeBivariateAnalyzeResult(ctx, opts);
    return { continuous: [], discrete: [], bivariate };
  }
  if (ctx.recipe.analysisMode === 'correlation_matrix') {
    const correlationMatrix = await computeCorrelationMatrixAnalyzeResult(ctx, opts);
    return { continuous: [], discrete: [], correlationMatrix };
  }
  if (ctx.recipe.analysisMode === 'regression') {
    const regression = await computeRegressionAnalyzeResult(ctx, opts);
    return { continuous: [], discrete: [], regression };
  }
  const request = buildStatsEngineRequest(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey);
  const raw = await runStatsEngine(request, opts);
  return computeDescriptiveSuppression(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey, raw);
}

// ---------------------------------------------------------------------------
// §C attempt() — claim된 행 하나를 실행한다. heartbeat(연속실패 카운터 리셋 포함)·
// spawn 직전 재확인(취소+버전드리프트)·BUSY 재큐잉·저장 재시도 루프.
// ---------------------------------------------------------------------------
export async function attempt(pool: Pool, row: StatsRunRow): Promise<void> {
  const controller = new AbortController();
  activeRuns.set(row.analysis_run_id, { controller, pid: null });

  let heartbeatInFlight = false;
  let consecutiveHeartbeatFailures = 0;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    pool.query(`UPDATE stats_runs SET heartbeat_at=now() WHERE id=$1 AND status='running'`, [row.id])
      .then((res) => {
        if ((res.rowCount ?? 0) === 0) { clearInterval(heartbeatTimer); return; }
        consecutiveHeartbeatFailures = 0; // 성공하면 반드시 리셋(실패→성공→실패… 오판 방지)
      })
      .catch((err) => {
        consecutiveHeartbeatFailures += 1;
        console.error('[stats-runs-queue] heartbeat write failed', err);
        if (consecutiveHeartbeatFailures >= config.stats.async.maxConsecutiveHeartbeatFailures) {
          clearInterval(heartbeatTimer);
        }
        // DB 일시 단절을 계산 중단 이유로 쓰지 않는다 — heartbeat만 멈추고 계산은
        // 계속 진행, 결국 sweepStale이 orphan으로 회수할 수 있음을 감수한다.
      })
      .finally(() => { heartbeatInFlight = false; });
  }, config.stats.async.heartbeatIntervalMs);

  let outcome: TerminalOutcome | { kind: 'requeue' };
  try {
    if (!row.frozen_dataset) {
      outcome = { kind: 'failed', errorCode: 'PROCESS_ERROR' };
    } else if (hasVersionDrifted(row)) {
      outcome = { kind: 'failed', errorCode: 'EXECUTION_VERSION_DRIFTED' };
    } else {
      const precheck = await pool.query<{ cancel_requested_at: Date | null }>(
        `SELECT cancel_requested_at FROM stats_runs WHERE id=$1`,
        [row.id],
      );
      if (precheck.rows[0]?.cancel_requested_at) {
        outcome = { kind: 'cancelled' };
      } else {
        const ctxResult = deriveAnalysisContext(row.frozen_dataset, {
          viewerUserId: row.requested_by ?? '',
          viewerOrgId: row.organization_id,
        });
        if (!ctxResult.ok) {
          outcome = { kind: 'failed', errorCode: 'PROCESS_ERROR' };
        } else {
          const result = await runEngineFor(ctxResult.ctx, {
            signal: controller.signal,
            timeoutMs: row.engine_timeout_ms,
            onSpawn: (pid) => {
              const active = activeRuns.get(row.analysis_run_id);
              if (active) active.pid = pid ?? null;
              pool.query(`UPDATE stats_runs SET worker_pid=$2 WHERE id=$1`, [row.id, pid])
                .catch((err) => console.error('[stats-runs-queue] worker_pid persist failed (best-effort)', err));
            },
          });
          outcome = { kind: 'succeeded', result };
        }
      }
    }
  } catch (err) {
    if (err instanceof StatsEngineBusyError) {
      outcome = { kind: 'requeue' }; // 계산 실패가 아니다 — 슬롯을 못 잡았을 뿐
    } else if (err instanceof StatsEngineCancelledError) {
      outcome = { kind: 'cancelled' }; // finishRun이 cancel_requested_at을 다시 확인하므로 결과는 동일
    } else {
      outcome = { kind: 'failed', errorCode: errorCodeForFailure(err) };
    }
  } finally {
    clearInterval(heartbeatTimer);
    activeRuns.delete(row.analysis_run_id);
  }

  const persist = outcome.kind === 'requeue'
    ? () => requeueOrFinish(pool, row.id)
    : () => finishRun(pool, row.id, { origin: 'computed', outcome: outcome as TerminalOutcome });

  for (let attemptNum = 0; attemptNum < config.stats.async.maxFinishPersistRetries; attemptNum += 1) {
    try {
      await persist();
      return;
    } catch (persistErr) {
      console.error('[stats-runs-queue] persist failed, retrying', persistErr);
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attemptNum));
    }
  }
  console.error('[stats-runs-queue] persist exhausted retries — leaving to orphan/queue sweep', row.id);
  // attempt()는 여기서도 reject하지 않는다 — claimTick의 top-level try/catch가 최종 방어선.
}

// ---------------------------------------------------------------------------
// §E 취소 — 의도 UPDATE와 감사를 같은 트랜잭션으로. 커밋 성공 후에만(트랜잭션 밖)
// best-effort 종료 신호.
// ---------------------------------------------------------------------------
export type RequestCancelResult =
  | { outcome: 'cancelled' }
  | { outcome: 'already_terminal' }
  | { outcome: 'not_found' };

export async function requestCancel(
  pool: Pool,
  analysisRunId: string,
  organizationId: string,
  cancelledBy: string,
): Promise<RequestCancelResult> {
  const result = await withWriteTransaction(pool, async (client) => {
    const updated = await client.query<{ id: string; status: string }>(
      `UPDATE stats_runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
              cancelled_by        = COALESCE(cancelled_by, $2)
        WHERE analysis_run_id=$1 AND organization_id=$3 AND status IN ('queued','running')
        RETURNING id, status`,
      [analysisRunId, cancelledBy, organizationId],
    );
    if (updated.rows.length > 0) {
      await writeAuditLogStrict(client, {
        actorUserId: cancelledBy, actorOrgId: organizationId, action: 'stats_run_cancel',
        targetType: 'analysis_recipe', targetId: analysisRunId,
        outcome: 'success' as AuditOutcome,
        extra: { analysisRunId, runStatus: 'cancel_requested' },
      });
      return { outcome: 'cancelled' as const };
    }

    // rowCount=0 — 이미 취소됨(멱등 성공)/이미 succeeded·failed(409)/없음(404) 3갈래.
    const recheck = await client.query<{ status: string }>(
      `SELECT status FROM stats_runs WHERE analysis_run_id=$1 AND organization_id=$2`,
      [analysisRunId, organizationId],
    );
    if (recheck.rows.length === 0) {
      await writeAuditLogStrict(client, {
        actorUserId: cancelledBy, actorOrgId: organizationId, action: 'stats_run_cancel',
        targetType: 'analysis_recipe', targetId: analysisRunId,
        outcome: 'denied' as AuditOutcome, extra: { analysisRunId, reasonCode: 'RUN_NOT_FOUND' },
      });
      return { outcome: 'not_found' as const };
    }
    if (recheck.rows[0].status === 'cancelled') {
      await writeAuditLogStrict(client, {
        actorUserId: cancelledBy, actorOrgId: organizationId, action: 'stats_run_cancel',
        targetType: 'analysis_recipe', targetId: analysisRunId,
        outcome: 'success' as AuditOutcome,
        extra: { analysisRunId, runStatus: 'cancel_requested', idempotent: true },
      });
      return { outcome: 'cancelled' as const };
    }
    await writeAuditLogStrict(client, {
      actorUserId: cancelledBy, actorOrgId: organizationId, action: 'stats_run_cancel',
      targetType: 'analysis_recipe', targetId: analysisRunId,
      outcome: 'denied' as AuditOutcome, extra: { analysisRunId, reasonCode: 'ALREADY_TERMINAL' },
    });
    return { outcome: 'already_terminal' as const };
  });

  if (result.outcome === 'cancelled') {
    // 커밋 성공 후에만(트랜잭션 밖) best-effort 종료 신호. registry에 없으면 아무 것도
    // 하지 않는다 — DB에 남은 worker_pid로 직접 kill하지 않는다(PID 재사용 위험 회피).
    const active = activeRuns.get(analysisRunId);
    active?.controller.abort();
  }
  return result;
}

// ---------------------------------------------------------------------------
// 등록 — 두 개의 독립 루프. videoAnalysisWorker.ts의 setInterval+running boolean
// 재진입가드+.unref()+stop() 패턴을 그대로 따르되, sweep과 claim+attempt를 하나의
// tick으로 묶지 않는다 — 묶으면 attempt()가 수분간 실행되는 동안(B2 prediction
// 워크로드에서 실제로 일어날 일) 다른 queued 작업의 취소 확정·대기예산초과
// sweep까지 덩달아 지연된다.
// ---------------------------------------------------------------------------
export function createStatsRunsQueueWorker(pool: Pool): { stop: () => void } {
  let sweeping = false;
  const sweepTick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await sweepStale(pool);
      await sweepQueuedTerminal(pool);
    } catch (err) {
      console.error('[stats-runs-queue] sweepTick failed', err);
    } finally {
      sweeping = false;
    }
  };

  let claiming = false;
  const claimTick = async () => {
    if (claiming) return;
    claiming = true;
    try {
      // 코드리뷰(2026-09-24) — §C-1(limited_row 진단 재계산)처럼 큐 밖에서 같은
      // 전역 엔진 세마포어를 점유하는 호출이 있으면, 슬롯을 미리 확인하지 않고
      // claim부터 하면 매 tick(claimIntervalMs)마다 "claim(running)→BUSY→
      // requeueOrFinish(다시 queued)"가 반복돼 maxRequeueCount를 몇 초~수십 초
      // 안에 소진하고 PROCESS_ERROR로 잘못 종결된다(대기예산 10분이 한참 남아
      // 있어도). claim 자체를 건너뛰면 그 행은 계속 queued로 남아 대기예산만
      // 소비하고, requeue_count는 claim된 뒤 실제로 겪은 경합에만 쓰인다.
      if (!isEngineSlotAvailable()) return;
      const claimed = await claimNextQueuedRun(pool, config.stats.async.queueWaitMs);
      if (claimed) await attempt(pool, claimed);
    } catch (err) {
      console.error('[stats-runs-queue] claimTick failed', err);
    } finally {
      claiming = false;
    }
  };

  const sweepTimer = setInterval(sweepTick, config.stats.async.sweepIntervalMs);
  sweepTimer.unref();
  const claimTimer = setInterval(claimTick, config.stats.async.claimIntervalMs);
  claimTimer.unref();

  return {
    stop: () => {
      clearInterval(sweepTimer);
      clearInterval(claimTimer);
    },
  };
}

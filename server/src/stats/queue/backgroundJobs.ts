// The stats background jobs a server process starts (moved out of src/index.ts in S8 so the start gate is testable).
import { logger } from '../../logger';
import type { Pool } from 'pg';
import config from '../../config';
import { runStatsRunCleanup } from '../../jobs/statsRunCleanup';
import { isStatsDeploymentGateOpen } from '../policy/workbenchRuntimeState';
import { createStatsRunsQueueWorker } from './runsQueue';

/**
 * Starts the stats_runs cleanup and the queue worker, both on this server's queue namespace — or nothing (null)
 * unless the deployment gate is open (flag ∧ intranet, the same gate as the routes): standalone + flag starts no
 * worker, since the routes are closed there anyway.
 */
export function startStatsBackgroundJobs(pool: Pool): { stop: () => Promise<void> } | null {
  if (!isStatsDeploymentGateOpen()) return null;
  const namespace = config.queueNamespace;

  // PR1 §8 — stats_runs 저장공간 정리. 정확성에는 불필요한 job(§8) — TTL 준수는 요청 시점에 이미
  // 보장되므로 이 job이 늦게 돌거나 꺼져 있어도 idempotency 캐시는 안 깨진다.
  const doStatsRunCleanup = () => {
    runStatsRunCleanup(pool, namespace)
      .then(({ deleted }) => {
        if (deleted > 0) logger.info({ deleted }, '[wr-server] stats-run-cleanup: removed expired stats_runs rows');
      })
      .catch((err) => logger.error({ err }, '[wr-server] stats-run-cleanup error'));
  };
  doStatsRunCleanup();
  const cleanupTimer = setInterval(doStatsRunCleanup, 60 * 60 * 1000);
  cleanupTimer.unref();

  // PR4-B1 — admission→attempt→finish 비동기 job 파이프라인. sweepLoop/claimLoop
  // 독립 등록(계획서 §C — 긴 작업 실행 중에도 다른 queued 작업의 취소·대기초과가
  // 지연되지 않아야 함).
  const worker = createStatsRunsQueueWorker(pool, { namespace });
  logger.info({ namespace }, '[wr-server] stats-runs-queue worker enabled');

  return {
    stop: async () => {
      clearInterval(cleanupTimer);
      await worker.stop();
    },
  };
}

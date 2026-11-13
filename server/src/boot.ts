// The server process (S9): start — migrations, listen, background jobs — and a graceful stop on SIGTERM/SIGINT.
// src/index.ts only calls main(); importing this module starts nothing.
//
// Stop order: stop accepting connections and let the requests in flight finish (server.close) → stop the background
// jobs and workers (a stats run or video job in flight is aborted and goes back to the queue; its subprocess gets
// SIGTERM, then SIGKILL after a grace period) → close the database pools → exit 0. If that takes longer than
// SHUTDOWN_TIMEOUT_MS the process exits 1. A fatal error (uncaughtException / unhandledRejection) runs the same stop
// and exits 1. Docker: the compose `stop_grace_period` is longer than SHUTDOWN_TIMEOUT_MS.
import { createServer, type Server } from 'http';
import type { Pool } from 'pg';
import config from './config';
import { createApp } from './app';
import { createPool } from './db/client';
import { createAuditPool } from './db/auditClient';
import { assertMigrationsApplied, runMigrations } from './db/migrate';
import { assertAuditWritable, assertLeastPrivilege } from './db/roles/startupChecks';
import { logger, type Logger } from './logger';
import { createVideoAnalysisWorker } from './workers/videoAnalysisWorker';
import { runWorkspaceRetention } from './jobs/workspaceRetention';
import { runVideoClipCleanup } from './jobs/videoClipCleanup';
import { createAuditNonceSweeper } from './jobs/emrAuditNonces';
import { createLoginBackoffSweeper } from './jobs/loginBackoff';
import { startStatsBackgroundJobs } from './stats/queue/backgroundJobs';

export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** A background job or worker the shutdown stops. `stop` may wait for the work in flight. */
export interface Stoppable {
  name: string;
  stop(): void | Promise<void>;
}

function intervalJob(name: string, run: () => void, everyMs: number): Stoppable {
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return { name, stop: () => clearInterval(timer) };
}

/** Starts every background job this configuration enables and returns them, so a shutdown can stop each one. */
export function startBackgroundJobs(pool: Pool): Stoppable[] {
  const jobs: Stoppable[] = [];

  // Workspace retention: run once at startup, then every 24 hours.
  // Errors are non-fatal — the server keeps running.
  jobs.push(intervalJob('workspace-retention', () => {
    runWorkspaceRetention(pool)
      .then(({ deleted }) => {
        if (deleted > 0) logger.info({ deleted }, '[wr-server] workspace-retention: removed expired workspaces');
      })
      .catch((err) => logger.error({ err }, '[wr-server] workspace-retention error'));
  }, 24 * 60 * 60 * 1000));

  // EMR audit nonces (SEC-A L11): drop rows past the 24-hour retention, at start and hourly.
  jobs.push({
    name: 'emr-audit-nonce-sweeper',
    ...createAuditNonceSweeper(pool, {
      onError: (err) => logger.error({ err }, '[wr-server] emr-audit-nonce sweep error'),
    }),
  });

  // Login backoff (SEC-B M2): drop unlocked rows untouched for 24 hours, at start and hourly.
  jobs.push({
    name: 'login-backoff-sweeper',
    ...createLoginBackoffSweeper(pool, {
      onError: (err) => logger.error({ err }, '[wr-server] login-backoff sweep error'),
    }),
  });

  // 영상 분석 워커: 플래그 on + (fixtureMode 또는 uploadDir 구성됨)일 때 큐 처리.
  //  - fixtureMode: dev fixture clip 추론. uploadDir: 실 업로드 clip 추론(M3-7a).
  if (config.videoAnalysisEnabled && (config.video.fixtureMode || config.video.uploadDir)) {
    jobs.push({ name: 'video-analysis-worker', ...createVideoAnalysisWorker(pool, {}, { namespace: config.queueNamespace }) });
    logger.info({ fixture: config.video.fixtureMode, upload: !!config.video.uploadDir, namespace: config.queueNamespace }, '[wr-server] video-analysis worker enabled');

    // 영상 임시파일 회수(TTL·orphan): 시작 시 1회 + 1시간 간격. 비치명적.
    jobs.push(intervalJob('video-clip-cleanup', () => {
      runVideoClipCleanup(pool, config.queueNamespace)
        .then(({ clipsExpired, originalsDeleted, artifactsDeleted, sampleFramesDeleted, orphansDeleted }) => {
          const total = originalsDeleted + artifactsDeleted + sampleFramesDeleted + orphansDeleted;
          if (total > 0) logger.info({ clips: clipsExpired, originals: originalsDeleted, artifacts: artifactsDeleted, frames: sampleFramesDeleted, orphans: orphansDeleted }, '[wr-server] video-cleanup');
        })
        .catch((err) => logger.error({ err }, '[wr-server] video-cleanup error'));
    }, 60 * 60 * 1000));
  }

  // 통계 stats_runs 정리 + 큐 워커. 플래그 꺼져 있으면 행 자체가 안 쌓이므로 무의미한
  // 폴링을 안 만든다(video 워커가 videoAnalysisEnabled 조건부 등록하는 것과 동일 논리).
  // S8: 라우트와 같은 배포 게이트(flag ∧ intranet), 이 서버의 queue namespace만 처리.
  const stats = startStatsBackgroundJobs(pool);
  if (stats) jobs.push({ name: 'stats-runs', ...stats });

  return jobs;
}

export interface ShutdownOptions {
  server: Pick<Server, 'close'> & { closeIdleConnections?: () => void };
  jobs: Stoppable[];
  pools: Array<{ name: string; end(): Promise<void> }>;
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: Pick<Logger, 'info' | 'error'>;
}

/**
 * The stop sequence. The returned function runs it once — a second signal while it runs gets the same promise — and
 * then calls `exit` with 0, or 1 if a step failed, the stop was for a fatal error (`exitCode`), or it timed out.
 */
export function createShutdown(options: ShutdownOptions): (reason: string, exitCode?: number) => Promise<void> {
  const { server, jobs, pools } = options;
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? logger;
  let running: Promise<void> | null = null;
  // The highest exit code any call asked for — a fatal error during a SIGTERM stop still makes it 1.
  let requestedCode = 0;

  return (reason, exitCode = 0) => {
    requestedCode = Math.max(requestedCode, exitCode);
    if (running) return running;
    running = (async () => {
      let code = 0;
      const force = setTimeout(() => {
        log.error({ reason, timeoutMs }, 'shutdown timed out — exiting');
        exit(1);
      }, timeoutMs);
      force.unref();

      log.info({ reason }, 'shutdown: closing the HTTP server');
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeIdleConnections?.();
        });
      } catch (err) {
        code = 1;
        log.error({ err }, 'shutdown: closing the HTTP server failed');
      }

      log.info({ jobs: jobs.map((j) => j.name) }, 'shutdown: stopping background jobs');
      const stopped = await Promise.allSettled(jobs.map(async (j) => j.stop()));
      stopped.forEach((result, i) => {
        if (result.status === 'rejected') {
          code = 1;
          log.error({ err: result.reason, job: jobs[i].name }, 'shutdown: stopping a background job failed');
        }
      });

      for (const pool of pools) {
        try {
          await pool.end();
        } catch (err) {
          code = 1;
          log.error({ err, pool: pool.name }, 'shutdown: closing a database pool failed');
        }
      }

      clearTimeout(force);
      code = Math.max(code, requestedCode);
      log.info({ reason, exitCode: code }, 'shutdown complete');
      exit(code);
    })();
    return running;
  };
}

export interface PrepareDatabaseDeps {
  runMigrations: (pool: Pool) => Promise<void>;
  assertMigrationsApplied: (pool: Pool) => Promise<void>;
  assertLeastPrivilege: (pool: Pool) => Promise<void>;
  assertAuditWritable: (pool: Pool) => Promise<void>;
}

const DATABASE_STEPS: PrepareDatabaseDeps = { runMigrations, assertMigrationsApplied, assertLeastPrivilege, assertAuditWritable };

/**
 * The database steps before the server accepts connections (M9). AUTO_MIGRATE=true (development, one superuser
 * role): apply pending migrations, as before. false (role-separated, the production default): the one-shot
 * `migrate` service has applied them as wr_owner; only check that none is pending and that DATABASE_URL's role
 * cannot change the audit log. Both: the role must be able to write audit rows. Throws on the first failure.
 */
export async function prepareDatabase(pool: Pool, autoMigrate: boolean, deps: PrepareDatabaseDeps = DATABASE_STEPS): Promise<void> {
  if (autoMigrate) {
    await deps.runMigrations(pool);
  } else {
    await deps.assertMigrationsApplied(pool);
    await deps.assertLeastPrivilege(pool);
  }
  await deps.assertAuditWritable(pool);
}

export async function main(): Promise<void> {
  const pool = createPool(config.databaseUrl);
  const auditPool = createAuditPool();
  const app = createApp({ pool, auditPool });

  // Migrations (AUTO_MIGRATE) or the role-separated start-up checks, before accepting connections.
  // Fatal: if they fail, the server cannot safely serve requests; the restart policy tries again.
  try {
    await prepareDatabase(pool, config.autoMigrate);
  } catch (err) {
    logger.fatal({ err, autoMigrate: config.autoMigrate }, '[wr-server] Migration failed — shutting down');
    process.exit(1);
  }

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port }, `[wr-server] Listening on http://localhost:${config.port}`);

  const jobs = startBackgroundJobs(pool);
  const shutdown = createShutdown({
    server,
    jobs,
    pools: [{ name: 'app', end: () => pool.end() }, { name: 'audit', end: () => auditPool.end() }],
  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — shutting down');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection — shutting down');
    void shutdown('unhandledRejection', 1);
  });
}

import { createServer } from 'http';
import config from './config';
import { createApp } from './app';
import { createPool } from './db/client';
import { createAuditPool } from './db/auditClient';
import { runMigrations } from './db/migrate';
import { createVideoAnalysisWorker } from './workers/videoAnalysisWorker';
import { runWorkspaceRetention } from './jobs/workspaceRetention';
import { runVideoClipCleanup } from './jobs/videoClipCleanup';
import { runStatsRunCleanup } from './jobs/statsRunCleanup';
import { createAuditNonceSweeper } from './jobs/emrAuditNonces';
import { createLoginBackoffSweeper } from './jobs/loginBackoff';
import { createStatsRunsQueueWorker } from './stats/queue/runsQueue';

// The server process: create the database pools, build the app (src/app.ts — REFACTORING_ROADMAP
// P0-3), then run migrations, listen and start the background jobs.
const pool = createPool(config.databaseUrl);
const auditPool = createAuditPool();
export const app = createApp({ pool, auditPool });

if (require.main === module) {
  // Run pending DB migrations before accepting connections.
  // Fatal: if migrations fail, the server cannot safely serve requests.
  runMigrations(pool)
    .then(() => {
      const server = createServer(app);
      server.listen(config.port, () => {
        console.log(`[wr-server] Listening on http://localhost:${config.port}`);

        // Workspace retention: run once at startup, then every 24 hours.
        // Errors are non-fatal — the server keeps running.
        const doRetention = () => {
          runWorkspaceRetention(pool)
            .then(({ deleted }) => {
              if (deleted > 0) console.log(`[wr-server] workspace-retention: removed ${deleted} expired workspace(s)`);
            })
            .catch((err) => console.error('[wr-server] workspace-retention error', err));
        };
        doRetention();
        setInterval(doRetention, 24 * 60 * 60 * 1000).unref();

        // EMR audit nonces (SEC-A L11): drop rows past the 24-hour retention, at start and hourly.
        // createAuditNonceSweeper returns { stop() }; S9 (graceful shutdown) will keep it and call stop()
        // with the other timers — until then the interval is unref()'d like the jobs above.
        createAuditNonceSweeper(pool, {
          onError: (err) => console.error('[wr-server] emr-audit-nonce sweep error', err),
        });

        // Login backoff (SEC-B M2): drop unlocked rows untouched for 24 hours, at start and hourly.
        createLoginBackoffSweeper(pool, {
          onError: (err) => console.error('[wr-server] login-backoff sweep error', err),
        });

        // 영상 분석 워커: 플래그 on + (fixtureMode 또는 uploadDir 구성됨)일 때 큐 처리.
        //  - fixtureMode: dev fixture clip 추론. uploadDir: 실 업로드 clip 추론(M3-7a).
        if (config.videoAnalysisEnabled && (config.video.fixtureMode || config.video.uploadDir)) {
          createVideoAnalysisWorker(pool);
          console.log(`[wr-server] video-analysis worker enabled (fixture=${config.video.fixtureMode}, upload=${!!config.video.uploadDir})`);

          // 영상 임시파일 회수(TTL·orphan): 시작 시 1회 + 1시간 간격. 비치명적.
          const doVideoCleanup = () => {
            runVideoClipCleanup(pool)
              .then(({ clipsExpired, originalsDeleted, artifactsDeleted, sampleFramesDeleted, orphansDeleted }) => {
                const total = originalsDeleted + artifactsDeleted + sampleFramesDeleted + orphansDeleted;
                if (total > 0) console.log(`[wr-server] video-cleanup: clips=${clipsExpired} originals=${originalsDeleted} artifacts=${artifactsDeleted} frames=${sampleFramesDeleted} orphans=${orphansDeleted}`);
              })
              .catch((err) => console.error('[wr-server] video-cleanup error', err));
          };
          doVideoCleanup();
          setInterval(doVideoCleanup, 60 * 60 * 1000).unref();
        }

        // PR1 §8 — stats_runs 저장공간 정리. 플래그 꺼져 있으면 행 자체가 안 쌓이므로
        // 무의미한 폴링을 안 만든다(video 워커가 videoAnalysisEnabled 조건부 등록하는
        // 것과 동일 논리). 정확성에는 불필요한 job(§8) — TTL 준수는 요청 시점에 이미
        // 보장되므로 이 job이 늦게 돌거나 꺼져 있어도 idempotency 캐시는 안 깨진다.
        if (config.statsWorkbenchEnabled) {
          const doStatsRunCleanup = () => {
            runStatsRunCleanup(pool)
              .then(({ deleted }) => {
                if (deleted > 0) console.log(`[wr-server] stats-run-cleanup: removed ${deleted} expired stats_runs row(s)`);
              })
              .catch((err) => console.error('[wr-server] stats-run-cleanup error', err));
          };
          doStatsRunCleanup();
          setInterval(doStatsRunCleanup, 60 * 60 * 1000).unref();

          // PR4-B1 — admission→attempt→finish 비동기 job 파이프라인. sweepLoop/claimLoop
          // 독립 등록(계획서 §C — 긴 작업 실행 중에도 다른 queued 작업의 취소·대기초과가
          // 지연되지 않아야 함).
          createStatsRunsQueueWorker(pool);
          console.log('[wr-server] stats-runs-queue worker enabled');
        }
      });
    })
    .catch((err) => {
      console.error('[wr-server] Migration failed — shutting down', err);
      process.exit(1);
    });
}

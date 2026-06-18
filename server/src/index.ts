import path from 'path';
import fs from 'fs';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'http';
import cookieParser from 'cookie-parser';
import config from './config';
import { pool } from './db/client';
import { auditPool } from './db/auditClient';
import { runMigrations } from './db/migrate';
import { createAuthRouter } from './routes/auth';
import { createConfigRouter } from './routes/config';
import { createVideoAnalysisRouter } from './routes/videoAnalysis';
import { createVideoAnalysisWorker } from './workers/videoAnalysisWorker';
import { createDevicesRouter } from './routes/devices';
import { createAdminRouter } from './routes/admin';
import { createAuditRouter } from './routes/audit';
import { createWorkspacesRouter } from './routes/workspaces';
import { createPatientsRouter } from './routes/patients';
import { createAutosaveRouter } from './routes/autosave';
import { createAIRouter } from './routes/ai';
import { createPresetsRouter } from './routes/presets';
import { createOpsStatusRouter } from './routes/opsStatus';
import { cspMiddleware } from './middleware/csp';
import { corsMiddleware } from './middleware/corsMiddleware';
import { runWorkspaceRetention } from './jobs/workspaceRetention';
import { runVideoClipCleanup } from './jobs/videoClipCleanup';

export const app = express();
app.set('trust proxy', config.trustProxy);
// Security headers first — applied to every response before any route runs.
app.use(cspMiddleware());
app.use(corsMiddleware());
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'wr-app-server', time: new Date().toISOString() });
});

app.use('/api/auth', createAuthRouter(pool));
app.use('/api/config', createConfigRouter());
app.use('/api/devices', createDevicesRouter(pool));
app.use('/api/admin',      createAdminRouter(pool, auditPool));
app.use('/api/admin/ops',  createOpsStatusRouter(pool));
app.use('/api/audit',      createAuditRouter(pool));
app.use('/api/workspaces', createWorkspacesRouter(pool));
app.use('/api/patients',  createPatientsRouter(pool));
app.use('/api/autosave',  createAutosaveRouter(pool));
app.use('/api/ai',        createAIRouter(pool));
app.use('/api/presets',   createPresetsRouter(pool));
app.use('/api/video-analysis', createVideoAnalysisRouter(pool));

// ---------------------------------------------------------------------------
// Static web SPA (dist/web/) — registered after API routes so API paths win.
// SPA fallback: serve index.html for any non-API GET (React Router handles it).
// The directory is optional; when absent the server runs in API-only mode.
// ---------------------------------------------------------------------------
const WEB_DIR = path.join(__dirname, 'web'); // /app/dist/web in production
if (fs.existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') return next();
    res.sendFile(path.join(WEB_DIR, 'index.html'));
  });
}

// Global JSON error handler — keeps API responses consistent when middleware
// calls next(err) (e.g. DB failures in auth middleware).
// Must be registered after all routes and have exactly 4 parameters.
app.use((err: Error & { type?: string; limit?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.too.large') {
    console.warn('[wr-server] request body too large', { limit: err.limit });
    res.status(413).json({
      code: 'PAYLOAD_TOO_LARGE',
      error: 'Request body is too large',
    });
    return;
  }
  console.error('[wr-server] unhandled error', err);
  res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
});

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

        // 영상 분석 워커: 플래그 on + (fixtureMode 또는 uploadDir 구성됨)일 때 큐 처리.
        //  - fixtureMode: dev fixture clip 추론. uploadDir: 실 업로드 clip 추론(M3-7a).
        if (config.videoAnalysisEnabled && (config.video.fixtureMode || config.video.uploadDir)) {
          createVideoAnalysisWorker(pool);
          console.log(`[wr-server] video-analysis worker enabled (fixture=${config.video.fixtureMode}, upload=${!!config.video.uploadDir})`);

          // 영상 임시파일 회수(TTL·orphan): 시작 시 1회 + 1시간 간격. 비치명적.
          const doVideoCleanup = () => {
            runVideoClipCleanup(pool)
              .then(({ clipsExpired, originalsDeleted, artifactsDeleted, orphansDeleted }) => {
                const total = originalsDeleted + artifactsDeleted + orphansDeleted;
                if (total > 0) console.log(`[wr-server] video-cleanup: clips=${clipsExpired} originals=${originalsDeleted} artifacts=${artifactsDeleted} orphans=${orphansDeleted}`);
              })
              .catch((err) => console.error('[wr-server] video-cleanup error', err));
          };
          doVideoCleanup();
          setInterval(doVideoCleanup, 60 * 60 * 1000).unref();
        }
      });
    })
    .catch((err) => {
      console.error('[wr-server] Migration failed — shutting down', err);
      process.exit(1);
    });
}

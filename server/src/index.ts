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
import { createDevicesRouter } from './routes/devices';
import { createAdminRouter } from './routes/admin';
import { createAuditRouter } from './routes/audit';
import { createWorkspacesRouter } from './routes/workspaces';
import { createPatientsRouter } from './routes/patients';
import { createAutosaveRouter } from './routes/autosave';
import { createAIRouter } from './routes/ai';
import { cspMiddleware } from './middleware/csp';
import { corsMiddleware } from './middleware/corsMiddleware';
import { runWorkspaceRetention } from './jobs/workspaceRetention';

export const app = express();
app.set('trust proxy', config.trustProxy);
// Security headers first — applied to every response before any route runs.
app.use(cspMiddleware());
app.use(corsMiddleware());
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'wr-app-server', time: new Date().toISOString() });
});

app.use('/api/auth', createAuthRouter(pool));
app.use('/api/config', createConfigRouter());
app.use('/api/devices', createDevicesRouter(pool));
app.use('/api/admin',      createAdminRouter(pool, auditPool));
app.use('/api/audit',      createAuditRouter(pool));
app.use('/api/workspaces', createWorkspacesRouter(pool));
app.use('/api/patients',  createPatientsRouter(pool));
app.use('/api/autosave',  createAutosaveRouter(pool));
app.use('/api/ai',        createAIRouter(pool));

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
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
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
      });
    })
    .catch((err) => {
      console.error('[wr-server] Migration failed — shutting down', err);
      process.exit(1);
    });
}

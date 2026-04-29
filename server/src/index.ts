import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'http';
import cookieParser from 'cookie-parser';
import config from './config';
import { pool } from './db/client';
import { createAuthRouter } from './routes/auth';
import { createConfigRouter } from './routes/config';
import { createDevicesRouter } from './routes/devices';
import { createAdminRouter } from './routes/admin';
import { createAuditRouter } from './routes/audit';
import { createWorkspacesRouter } from './routes/workspaces';
import { createAutosaveRouter } from './routes/autosave';
import { cspMiddleware } from './middleware/csp';
import { corsMiddleware } from './middleware/corsMiddleware';

export const app = express();
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
app.use('/api/admin',      createAdminRouter(pool));
app.use('/api/audit',      createAuditRouter(pool));
app.use('/api/workspaces', createWorkspacesRouter(pool));
app.use('/api/autosave',  createAutosaveRouter(pool));

// Global JSON error handler — keeps API responses consistent when middleware
// calls next(err) (e.g. DB failures in auth middleware).
// Must be registered after all routes and have exactly 4 parameters.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[wr-server] unhandled error', err);
  res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
});

if (require.main === module) {
  const server = createServer(app);
  server.listen(config.port, () => {
    console.log(`[wr-server] Listening on http://localhost:${config.port}`);
  });
}

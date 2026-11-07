// Express application factory (REFACTORING_ROADMAP P0-3).
//
// Builds the whole app — security headers, CORS, body parsing, every API router, the update feed,
// the static web SPA and the JSON error handler — from injected dependencies, so tests can start
// the real app with their own pools (G5) and importing this module never creates or connects a
// database pool. Process start-up (migrations, listen, background jobs) stays in index.ts.
//
// The registration ORDER below is part of the behaviour and was moved unchanged from index.ts:
// security headers first; /updates before the SPA catch-all; the error handler last.
// P1-01 added the request id (right after trust proxy) and the /api JSON 404 (after the routers).
import path from 'path';
import fs from 'fs';
import express, { type Express, type Router } from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'pg';
import config from './config';
import { createAuthRouter } from './routes/auth';
import { createConfigRouter } from './routes/config';
import { createVideoAnalysisRouter } from './routes/videoAnalysis';
import { createDevicesRouter } from './routes/devices';
import { createAdminRouter } from './routes/admin';
import { createAuditRouter } from './routes/audit';
import { createWorkspacesRouter } from './routes/workspaces';
import { createPatientsRouter } from './routes/patients';
import { createAutosaveRouter } from './routes/autosave';
import { createAIRouter } from './routes/ai';
import { createPresetsRouter } from './routes/presets';
import { createCapabilityGrantsRouter } from './routes/capabilityGrants';
import { createOpsStatusRouter } from './routes/opsStatus';
import { createUpdatesRouter } from './routes/updates';
import { createStatsRouter } from './routes/stats';
import { cspMiddleware, noStoreMiddleware } from './middleware/csp';
import { corsMiddleware } from './middleware/corsMiddleware';
import { requestIdMiddleware } from './http/requestId';
import { apiNotFound } from './http/notFound';
import { createErrorHandler } from './http/errorHandler';
import defaultLogger, { type Logger } from './logger';

// JSON body limit per API mount (SEC-A L2). Before 7.2.0 one app-wide parser accepted 10 MB on every
// route. Now only the routes that carry whole patients take the large limit (JSON_BODY_LIMIT,
// default 10mb): patient save, workspace save (a 500-patient workspace measured 1.5–4 MB),
// autosave, and video-analysis apply (it sends the patient's whole data). Everything else 256 KB;
// AI 2 MB (input + a report of up to 60,000 characters); stats 1 MB (recipes).
const SMALL_BODY = '256kb';
export const API_BODY_LIMITS = {
  '/api/auth':           SMALL_BODY,
  '/api/config':         SMALL_BODY,
  '/api/devices':        SMALL_BODY,
  '/api/admin/ops':      SMALL_BODY,
  '/api/admin':          SMALL_BODY,
  '/api/audit':          SMALL_BODY,
  '/api/workspaces':     config.jsonBodyLimit,
  '/api/patients':       config.jsonBodyLimit,
  '/api/autosave':       config.jsonBodyLimit,
  '/api/ai':             '2mb',
  '/api/presets':        SMALL_BODY,
  '/api/capabilities':   SMALL_BODY,
  '/api/video-analysis': config.jsonBodyLimit,
  '/api/stats':          '1mb',
} as const satisfies Record<string, string>;
type ApiPrefix = keyof typeof API_BODY_LIMITS;

export interface AppDeps {
  pool: Pool;
  /** Read-only pool for audit log queries (wr_audit_reader role). */
  auditPool: Pool;
  /** Built web SPA directory; defaults to <dist>/web next to the compiled server. */
  webDir?: string;
  /** Logger for the error handler; defaults to the process logger (logger.ts). */
  logger?: Logger;
}

export function createApp({
  pool,
  auditPool,
  webDir: webDirOption = path.join(__dirname, 'web'),
  logger = defaultLogger,
}: AppDeps): Express {
  // Absolute, so express.static and res.sendFile (which requires an absolute path) agree.
  const webDir = path.resolve(webDirOption);
  const app = express();
  app.set('trust proxy', config.trustProxy);
  // Request id before anything that can answer or fail, so every response and error log has one.
  app.use(requestIdMiddleware());
  // Security headers first — applied to every response before any route runs.
  app.use(cspMiddleware());
  app.use(corsMiddleware());
  // No app-wide JSON parser: each API mount below names its own body limit (SEC-A L2).
  app.use(cookieParser());
  app.use('/api', noStoreMiddleware());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'wr-app-server', time: new Date().toISOString() });
  });

  // Every API mount gets its own express.json with the limit from API_BODY_LIMITS (SEC-A L2), so a
  // router cannot end up without a parser or with the large limit by accident (app.test checks).
  const mount = (prefix: ApiPrefix, router: Router) => {
    app.use(prefix, express.json({ limit: API_BODY_LIMITS[prefix] }), router);
  };
  mount('/api/auth', createAuthRouter(pool));
  mount('/api/config', createConfigRouter());
  mount('/api/devices', createDevicesRouter(pool));
  // ops before admin: the admin router now runs auth + admin for every path under it (router.use),
  // so mounting it first would check the session twice for /api/admin/ops/* (S4 / P1-15).
  mount('/api/admin/ops',  createOpsStatusRouter(pool));
  mount('/api/admin',      createAdminRouter(pool, auditPool));
  mount('/api/audit',      createAuditRouter(pool));
  mount('/api/workspaces', createWorkspacesRouter(pool));
  mount('/api/patients',  createPatientsRouter(pool));
  mount('/api/autosave',  createAutosaveRouter(pool));
  mount('/api/ai',        createAIRouter(pool));
  mount('/api/presets',   createPresetsRouter(pool));
  mount('/api/capabilities', createCapabilityGrantsRouter(pool));
  mount('/api/video-analysis', createVideoAnalysisRouter(pool));
  mount('/api/stats', createStatsRouter(pool));
  // Unknown /api paths: JSON 404 (P1-01). After every API router, before /updates and the SPA.
  app.use('/api', apiNotFound());

  // 트랙 2 — electron-updater 정적 배포 경로(설치본/latest.yml/canary.yml/blockmap/정책 파일).
  // /api/* 는 아니지만 반드시 아래 SPA catch-all보다 먼저 등록해야 한다 — 순서가 바뀌면
  // /updates/* 요청이 catch-all에 잡혀 index.html(200 OK)을 받는, 원인 파악이 어려운 버그가 된다.
  app.use('/updates', createUpdatesRouter());

  // ---------------------------------------------------------------------------
  // Static web SPA (dist/web/) — registered after API routes so API paths win.
  // SPA fallback: serve index.html for any non-API GET (React Router handles it).
  // The directory is optional; when absent the server runs in API-only mode.
  // ---------------------------------------------------------------------------
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/health') return next();
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  // Central JSON error handler (http/errorHandler.ts) — maps whatever a route or middleware
  // forwarded with next(err) (asyncHandler, auth middleware DB failures, body-parser 413).
  // Must be registered after all routes.
  app.use(createErrorHandler(logger));

  return app;
}

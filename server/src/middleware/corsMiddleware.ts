import cors from 'cors';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import config from '../config';

// Null, file://, and app:// origins are always blocked regardless of allowlist.
const BLOCKED_ORIGINS = new Set(['null', 'file://', 'app://']);

function buildAllowlist(): Set<string> {
  const list = new Set(config.cors.origins);
  if (config.env !== 'production') {
    list.add('http://localhost:5173');
  }
  return list;
}

// Wraps the cors package so that rejected origins produce 403 CORS_ORIGIN_DENIED
// rather than a thrown Error that propagates to the global 500 handler.
// Same-origin requests (no Origin header) are always allowed.
export function corsMiddleware(): RequestHandler {
  const allowlist  = buildAllowlist();
  const corsHandler = cors({
    origin: true, // actual enforcement done in the guard below; cors just reflects
    credentials:    true,
    methods:        ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'],
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    // No Origin header → same-origin or server-to-server → always allow.
    if (!origin) {
      corsHandler(req, res, next);
      return;
    }

    if (BLOCKED_ORIGINS.has(origin) || !allowlist.has(origin)) {
      res.status(403).json({ code: 'CORS_ORIGIN_DENIED', error: 'Origin not allowed' });
      return;
    }

    corsHandler(req, res, next);
  };
}

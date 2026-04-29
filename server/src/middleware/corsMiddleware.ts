import cors from 'cors';
import type { RequestHandler } from 'express';
import config from '../config';

// Null, file://, and app:// origins are always blocked in production.
// In non-production environments, localhost:5173 (Vite dev server) is allowed.
const BLOCKED_ORIGINS = new Set(['null', 'file://', 'app://']);

function buildAllowlist(): string[] {
  const list = [...config.cors.origins];
  if (config.env !== 'production') {
    list.push('http://localhost:5173');
  }
  return list;
}

export function corsMiddleware(): RequestHandler {
  const allowlist = buildAllowlist();

  return cors({
    origin(origin, callback) {
      // Same-origin requests (e.g. Electron same-origin, server-side) have no
      // Origin header — always allow.
      if (!origin) return callback(null, true);

      if (BLOCKED_ORIGINS.has(origin)) {
        return callback(new Error(`CORS: blocked origin ${origin}`));
      }

      if (allowlist.includes(origin)) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin not allowed: ${origin}`));
    },
    credentials: true,
    methods:     ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'],
  });
}

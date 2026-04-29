import crypto from 'crypto';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { hashToken } from './sessionStore';

export const CSRF_COOKIE = 'wr_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateCsrf(
  headerValue: string | string[] | undefined,
  storedHash: string
): boolean {
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!token) return false;
  return hashToken(token) === storedHash;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export function setCsrfCookie(res: Response, rawToken: string, secure: boolean): void {
  res.cookie(CSRF_COOKIE, rawToken, {
    httpOnly: false, // JS must be able to read this to attach to X-CSRF-Token header
    secure,
    sameSite: 'strict',
    path: '/',
  });
}

export function clearCsrfCookie(res: Response, secure: boolean): void {
  res.cookie(CSRF_COOKIE, '', {
    httpOnly: false,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}

// ---------------------------------------------------------------------------
// Reissue helper  (used by POST /api/auth/csrf route — T11)
//
// Called when the wr_csrf cookie is missing (e.g. after browser data clear).
// The endpoint is exempt from CSRF middleware because the token doesn't exist
// yet; it is protected by:
//   1. HttpOnly wr_refresh cookie auth (SameSite=Strict blocks cross-site)
//   2. Origin header whitelist check (in CORS middleware)
//   3. Rate limit (10 req/min/IP)
// ---------------------------------------------------------------------------
export async function reissueCsrfToken(
  pool: Pool,
  sessionId: string,
  res: Response,
  secure: boolean
): Promise<void> {
  const newToken = crypto.randomBytes(32).toString('hex');

  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE sessions SET csrf_token_hash = $1 WHERE id = $2',
      [hashToken(newToken), sessionId]
    );
  } finally {
    client.release();
  }

  setCsrfCookie(res, newToken, secure);
}

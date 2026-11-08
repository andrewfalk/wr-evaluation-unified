// Session routes: refresh, logout, me, CSRF reissue.
// Split out of routes/auth.ts (S5 P1-32); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import config from '../../config';
import { verifySession, isPastAbsoluteLifetime, rotateSession, revokeSessionFamily } from '../../auth/sessionStore';
import { hashToken } from '../../auth/sessionStore';
import { generateAccessToken } from '../../auth/tokens';
import { setCsrfCookie, reissueCsrfToken, CSRF_HEADER, validateCsrf } from '../../auth/csrf';
import { SESSION_EXPIRED_BODY } from '../../middleware/auth';
import { auditLogout, auditRefreshFail, auditRefreshSuccess } from '../../middleware/audit';
import { sessionOf } from '../../http/authz';
import { REFRESH_COOKIE, isSecure, AuthUserRow, toUserPayload, setRefreshCookie, clearAuthCookies } from './shared';

// ---------------------------------------------------------------------------
// Route: POST /api/auth/refresh
// ---------------------------------------------------------------------------
export async function refresh(pool: Pool, req: Request, res: Response): Promise<void> {
  const oldRefreshToken: string | undefined = req.cookies?.[REFRESH_COOKIE];
  if (!oldRefreshToken) {
    auditRefreshFail(pool, req, 'NO_REFRESH_TOKEN');
    res.status(401).json({ code: 'NO_REFRESH_TOKEN', error: 'Refresh token cookie missing' });
    return;
  }

  // Validate CSRF before rotation: lookup session to get stored csrfTokenHash.
  // Uses a brief non-transactional read; rotation itself is atomic.
  const client = await pool.connect();
  let csrfTokenHash: string | null = null;
  let sessionUserId: string | null = null;
  try {
    const existing = await verifySession(client, oldRefreshToken);
    if (!existing) {
      if (await isPastAbsoluteLifetime(client, oldRefreshToken)) {
        auditRefreshFail(pool, req, 'SESSION_EXPIRED');
        res.status(401).json(SESSION_EXPIRED_BODY);
        return;
      }
      auditRefreshFail(pool, req, 'SESSION_INVALID');
      res.status(401).json({ code: 'SESSION_INVALID', error: 'Refresh token invalid or expired' });
      return;
    }
    csrfTokenHash = existing.csrfTokenHash;
    sessionUserId = existing.userId;
  } finally {
    client.release();
  }

  if (!validateCsrf(req.headers[CSRF_HEADER], csrfTokenHash!)) {
    auditRefreshFail(pool, req, 'CSRF_INVALID');
    res.status(403).json({ code: 'CSRF_INVALID', error: 'Invalid or missing CSRF token' });
    return;
  }

  // Fetch current user info before rotation so disabled accounts stop refreshing
  // immediately and no fresh session is issued for them.
  const userClient = await pool.connect();
  let userRow: AuthUserRow | null = null;
  try {
    const { rows } = await userClient.query<AuthUserRow>(
      `SELECT id AS user_id, role, name, organization_id, must_change_password, disabled_at
       FROM users WHERE id = $1`,
      [sessionUserId]
    );
    userRow = rows[0] ?? null;
  } finally {
    userClient.release();
  }

  if (!userRow) {
    res.status(401).json({ code: 'USER_NOT_FOUND', error: 'Associated user not found' });
    return;
  }

  if (userRow.disabled_at != null) {
    auditRefreshFail(pool, req, 'USER_DISABLED');
    res.status(401).json({ code: 'USER_DISABLED', error: 'User account is disabled' });
    return;
  }

  const newSession = await rotateSession(
    pool,
    oldRefreshToken,
    { userAgent: req.headers['user-agent'], ip: req.ip },
    config.auth.refreshTokenTtl
  );

  if (!newSession) {
    // The lineage can reach its absolute lifetime between verifySession above and the strict check in
    // rotateSession; report that as SESSION_EXPIRED rather than as a concurrent rotation.
    if (await isPastAbsoluteLifetime(pool, oldRefreshToken)) {
      auditRefreshFail(pool, req, 'SESSION_EXPIRED');
      res.status(401).json(SESSION_EXPIRED_BODY);
      return;
    }
    // Token was already rotated by a concurrent request (race condition resolved)
    auditRefreshFail(pool, req, 'SESSION_ALREADY_ROTATED');
    res.status(401).json({ code: 'SESSION_ALREADY_ROTATED', error: 'Session was already rotated' });
    return;
  }

  const { token: accessToken, expiresAt: accessExpiresAt } = generateAccessToken({
    sub:                userRow.user_id,
    sessionId:          newSession.sessionId,
    orgId:              userRow.organization_id,
    role:               userRow.role,
    name:               userRow.name,
    mustChangePassword: userRow.must_change_password,
    csrfHash:           hashToken(newSession.csrfToken),
  });

  setRefreshCookie(res, newSession.refreshToken, newSession.expiresAt, newSession.persistentCookie);
  setCsrfCookie(res, newSession.csrfToken, isSecure);

  auditRefreshSuccess(pool, req, userRow.user_id, userRow.organization_id, newSession.sessionId);

  res.status(200).json({
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    user: toUserPayload(userRow),
  });
}

// ---------------------------------------------------------------------------
// Route: POST /api/auth/logout
//
// Authenticates via the wr_refresh cookie (like /refresh and /csrf), not the
// Bearer access token — logout must work even when the access token has
// already expired, without needing a token refresh first. Refreshing just to
// log out creates a race: a slow refresh can complete after the client gave
// up waiting and reset locally, silently reviving the very session logout
// was trying to kill (or, worse, landing after a subsequent re-login and
// clobbering a different session's cookies/token). Not requiring a fresh
// access token here removes that whole class of race — see auth epoch
// guards in useAuthSync.js for the (now secondary) client-side backstop.
//
// Idempotent: a missing or already-invalid refresh cookie is treated as
// "already logged out" (200), not an error — there's nothing to revoke.
//
// The actual revoke goes through revokeSessionFamily() rather than a plain
// "find session, then revoke that id" — a concurrent /refresh (e.g. another
// tab, or a different generation of the same lineage) can otherwise leave a
// newly-rotated session untouched and fully valid. CSRF is also validated
// inside that same call/transaction rather than as a separate pre-check
// here — see its comment in sessionStore.ts for why both matter.
// ---------------------------------------------------------------------------
export async function logout(pool: Pool, req: Request, res: Response): Promise<void> {
  const rawRefreshToken: string | undefined = req.cookies?.[REFRESH_COOKIE];
  if (!rawRefreshToken) {
    auditLogout(pool, req);
    clearAuthCookies(res);
    res.status(200).json({ ok: true });
    return;
  }

  const result = await revokeSessionFamily(pool, rawRefreshToken, req.headers[CSRF_HEADER]);

  if (result.status === 'csrf_invalid') {
    res.status(403).json({ code: 'CSRF_INVALID', error: 'Invalid or missing CSRF token' });
    return;
  }

  if (result.status === 'not_found') {
    auditLogout(pool, req);
    clearAuthCookies(res);
    res.status(200).json({ ok: true });
    return;
  }

  const userClient = await pool.connect();
  let organizationId: string | null = null;
  try {
    const { rows } = await userClient.query<{ organization_id: string | null }>(
      `SELECT organization_id FROM users WHERE id = $1`,
      [result.userId]
    );
    organizationId = rows[0]?.organization_id ?? null;
  } finally {
    userClient.release();
  }

  auditLogout(pool, req, result.userId, organizationId, result.sessionId);
  clearAuthCookies(res);
  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Route: GET /api/auth/me
// ---------------------------------------------------------------------------
export async function me(pool: Pool, req: Request, res: Response): Promise<void> {
  const { userId, organizationId, role, name, mustChangePassword } = sessionOf(req);

  let org: { id: string; name: string } | null = null;
  if (organizationId) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM organizations WHERE id = $1',
        [organizationId]
      );
      org = rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  res.status(200).json({
    user: { id: userId, name, role, organizationId, mustChangePassword },
    org,
    capabilities: {
      autosave:            true,
      workspaces:          true,
      patients:            true,
      ai:                  config.ai.enabled,
      isAdmin:             role === 'admin',
      localFallbackAllowed: config.localFallbackAllowed,
    },
  });
}

// ---------------------------------------------------------------------------
// Route: POST /api/auth/csrf  (exempt from CSRF middleware)
// ---------------------------------------------------------------------------
export async function csrfReissue(pool: Pool, req: Request, res: Response): Promise<void> {
  // This endpoint must be called with a valid refresh cookie.
  // Validate the refresh token to authenticate the request.
  const rawRefreshToken: string | undefined = req.cookies?.[REFRESH_COOKIE];
  if (!rawRefreshToken) {
    res.status(401).json({ code: 'NO_REFRESH_TOKEN', error: 'Refresh token cookie missing' });
    return;
  }

  const client = await pool.connect();
  let sessionId: string | null = null;
  let sessionUserId: string | null = null;
  try {
    const existing = await verifySession(client, rawRefreshToken);
    if (!existing) {
      if (await isPastAbsoluteLifetime(client, rawRefreshToken)) {
        res.status(401).json(SESSION_EXPIRED_BODY);
        return;
      }
      res.status(401).json({ code: 'SESSION_INVALID', error: 'Refresh token invalid or expired' });
      return;
    }
    sessionId = existing.sessionId;
    sessionUserId = existing.userId;
  } finally {
    client.release();
  }

  // Fetch user info to generate the new access token.
  const userClient = await pool.connect();
  let userRow: AuthUserRow | null = null;
  try {
    const { rows } = await userClient.query<AuthUserRow>(
      `SELECT id AS user_id, role, name, organization_id, must_change_password, disabled_at
       FROM users WHERE id = $1`,
      [sessionUserId]
    );
    userRow = rows[0] ?? null;
  } finally {
    userClient.release();
  }

  if (!userRow) {
    res.status(401).json({ code: 'USER_NOT_FOUND', error: 'Associated user not found' });
    return;
  }

  if (userRow.disabled_at != null) {
    res.status(401).json({ code: 'USER_DISABLED', error: 'User account is disabled' });
    return;
  }

  // Reissue CSRF cookie and get new raw token so we can embed its hash in a
  // fresh access token. Without a new access token the old csrfHash inside the
  // JWT would mismatch the new CSRF cookie, breaking every subsequent mutating
  // request with 403.
  const newCsrfToken = await reissueCsrfToken(pool, sessionId!, res, isSecure);

  const { token: accessToken, expiresAt: accessExpiresAt } = generateAccessToken({
    sub:                sessionUserId!,
    sessionId:          sessionId!,
    orgId:              userRow.organization_id,
    role:               userRow.role,
    name:               userRow.name,
    mustChangePassword: userRow.must_change_password,
    csrfHash:           hashToken(newCsrfToken),
  });

  res.status(200).json({
    ok: true,
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    user: toUserPayload(userRow),
  });
}

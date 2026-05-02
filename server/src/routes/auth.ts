import bcrypt from 'bcrypt';
import { Router, type Request, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import config from '../config';
import { LocalDbAuthProvider } from '../auth/LocalDbAuthProvider';
import {
  createSession,
  verifySession,
  rotateSession,
  revokeSession,
} from '../auth/sessionStore';
import { hashToken } from '../auth/sessionStore';
import { generateAccessToken } from '../auth/tokens';
import {
  setCsrfCookie,
  clearCsrfCookie,
  reissueCsrfToken,
  CSRF_HEADER,
  validateCsrf,
} from '../auth/csrf';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { loginRateLimit, csrfRateLimit } from '../middleware/rateLimit';
import { auditLogin, auditLogout, auditRefreshFail, auditRefreshSuccess, writeAuditLog } from '../middleware/audit';
import { checkPasswordPolicy, isPasswordReused, appendPasswordHistory } from '../auth/passwordPolicy';

const REFRESH_COOKIE = 'wr_refresh';

const isSecure = config.env === 'production';

interface AuthUserRow {
  user_id: string;
  role: string;
  name: string;
  organization_id: string | null;
  must_change_password: boolean;
  disabled_at: string | null;
}

function toUserPayload(user: {
  user_id: string;
  name: string;
  role: string;
  organization_id: string | null;
  must_change_password: boolean;
}) {
  return {
    id:                 user.user_id,
    name:               user.name,
    role:               user.role,
    organizationId:     user.organization_id,
    mustChangePassword: user.must_change_password,
  };
}

function setRefreshCookie(res: Response, rawToken: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, rawToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

function clearAuthCookies(res: Response): void {
  const opts = { httpOnly: true, secure: isSecure, sameSite: 'strict' as const, path: '/', maxAge: 0 };
  res.cookie(REFRESH_COOKIE, '', opts);
  clearCsrfCookie(res, isSecure);
}

// ---------------------------------------------------------------------------
// Route: POST /api/auth/login
// ---------------------------------------------------------------------------
const LoginBody = z.object({
  loginId:  z.string().min(1),
  password: z.string().min(1),
});

async function login(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    auditLogin(pool, req, 'failure');
    res.status(400).json({ code: 'INVALID_BODY', error: 'loginId and password are required' });
    return;
  }

  const provider = new LocalDbAuthProvider(pool);
  const creds = await provider.verifyCredentials(parsed.data.loginId, parsed.data.password);
  if (!creds) {
    auditLogin(pool, req, 'failure');
    res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid login ID or password' });
    return;
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const session = await createSession(
      client,
      creds.userId,
      { userAgent: req.headers['user-agent'], ip: req.ip },
      config.auth.refreshTokenTtl
    );

    // Record last login
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [creds.userId]);

    await client.query('COMMIT');

    const { token: accessToken, expiresAt: accessExpiresAt } = generateAccessToken({
      sub:                creds.userId,
      sessionId:          session.sessionId,
      orgId:              creds.organizationId,
      role:               creds.role,
      name:               creds.name,
      mustChangePassword: creds.mustChangePassword,
      csrfHash:           hashToken(session.csrfToken),
    });

    setRefreshCookie(res, session.refreshToken, session.expiresAt);
    setCsrfCookie(res, session.csrfToken, isSecure);

    auditLogin(pool, req, 'success', creds.userId, creds.organizationId);

    res.status(200).json({
      user: {
        id:                 creds.userId,
        name:               creds.name,
        role:               creds.role,
        organizationId:     creds.organizationId,
        mustChangePassword: creds.mustChangePassword,
      },
      accessToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/auth/refresh
// ---------------------------------------------------------------------------
async function refresh(pool: Pool, req: Request, res: Response): Promise<void> {
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

  setRefreshCookie(res, newSession.refreshToken, newSession.expiresAt);
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
// ---------------------------------------------------------------------------
async function logout(pool: Pool, req: Request, res: Response): Promise<void> {
  const sessionId = req.sessionInfo?.sessionId;
  if (sessionId) {
    const client = await pool.connect();
    try {
      await revokeSession(client, sessionId);
    } finally {
      client.release();
    }
  }
  auditLogout(pool, req);
  clearAuthCookies(res);
  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Route: GET /api/auth/me
// ---------------------------------------------------------------------------
async function me(pool: Pool, req: Request, res: Response): Promise<void> {
  const { userId, organizationId, role, name, mustChangePassword } = req.sessionInfo!;

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
async function csrfReissue(pool: Pool, req: Request, res: Response): Promise<void> {
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

// ---------------------------------------------------------------------------
// Route: POST /api/auth/change-password
// ---------------------------------------------------------------------------
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(1),
});

async function changePassword(pool: Pool, req: Request, res: Response): Promise<void> {
  const parse = ChangePasswordBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const { currentPassword, newPassword } = parse.data;
  const { userId, organizationId, sessionId, csrfTokenHash } = req.sessionInfo!;

  // Policy check first (fast path before DB round-trip)
  const policy = checkPasswordPolicy(newPassword);
  if (!policy.ok) {
    res.status(400).json({ code: 'PASSWORD_POLICY_VIOLATION', error: policy.error });
    return;
  }

  const client = await pool.connect();
  let updatedUser: {
    id: string; name: string; role: string;
    organization_id: string | null; must_change_password: boolean;
  } | null = null;
  try {
    const { rows } = await client.query<{
      password_hash:    string;
      password_history: string[];
    }>(
      `SELECT password_hash, password_history FROM users WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) {
      res.status(401).json({ code: 'UNAUTHORIZED', error: 'User not found' });
      return;
    }
    const { password_hash, password_history } = rows[0];

    // Verify current password
    const currentValid = await bcrypt.compare(currentPassword, password_hash);
    if (!currentValid) {
      writeAuditLog(pool, {
        actorUserId: userId,
        actorOrgId:  organizationId ?? null,
        action:      'auth_change_password_fail',
        outcome:     'denied',
        ip:          req.ip ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        extra:       { reason: 'wrong_current_password' },
      });
      res.status(401).json({ code: 'WRONG_CURRENT_PASSWORD', error: 'Current password is incorrect' });
      return;
    }

    // Check history (includes current hash)
    const historyToCheck = [...(password_history ?? []), password_hash];
    if (await isPasswordReused(newPassword, historyToCheck)) {
      res.status(400).json({
        code:  'PASSWORD_RECENTLY_USED',
        error: '최근 사용한 비밀번호는 다시 사용할 수 없습니다.',
      });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    const newHistory = appendPasswordHistory(historyToCheck, newHash);

    // Update password, clear must_change_password, revoke all other sessions
    await client.query('BEGIN');
    const { rows: updatedRows } = await client.query<{
      id: string; name: string; role: string;
      organization_id: string | null; must_change_password: boolean;
    }>(
      `UPDATE users
       SET password_hash = $1, password_history = $2, must_change_password = false
       WHERE id = $3
       RETURNING id, name, role, organization_id, must_change_password`,
      [newHash, newHistory, userId]
    );
    updatedUser = updatedRows[0] ?? null;
    // Revoke all sessions except the current one
    await client.query(
      `UPDATE sessions SET invalidated_at = now()
       WHERE user_id = $1 AND id != $2 AND invalidated_at IS NULL`,
      [userId, req.sessionInfo!.sessionId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  writeAuditLog(pool, {
    actorUserId: userId,
    actorOrgId:  organizationId ?? null,
    action:      'auth_change_password',
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  if (!updatedUser) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'User not found' });
    return;
  }

  const { token: accessToken, expiresAt: accessExpiresAt } = generateAccessToken({
    sub:                updatedUser.id,
    sessionId,
    orgId:              updatedUser.organization_id,
    role:               updatedUser.role,
    name:               updatedUser.name,
    mustChangePassword: updatedUser.must_change_password,
    csrfHash:           csrfTokenHash,
  });

  res.status(200).json({
    ok: true,
    user: {
      id:                 updatedUser.id,
      name:               updatedUser.name,
      role:               updatedUser.role,
      organizationId:     updatedUser.organization_id,
      mustChangePassword: updatedUser.must_change_password,
    },
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

export function createAuthRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);

  // Unauthenticated
  router.post('/login',   loginRateLimit(), (req, res) => login(pool, req, res).catch(() => res.status(500).json(internalError())));
  router.post('/refresh', (req, res) => refresh(pool, req, res).catch(() => res.status(500).json(internalError())));

  // /csrf is exempt from csrfMiddleware (wr_csrf cookie is missing when called).
  // Protected by: HttpOnly wr_refresh cookie (SameSite=Strict), Origin check
  // (CORS middleware), and rate limit below.
  router.post('/csrf', csrfRateLimit(), (req, res) => csrfReissue(pool, req, res).catch(() => res.status(500).json(internalError())));

  // Requires valid access token + live DB session check
  router.get('/me', auth, (req, res) => me(pool, req, res).catch(() => res.status(500).json(internalError())));

  // logout: auth + CSRF (mutating POST)
  router.post('/logout', auth, csrfMiddleware, (req, res) => logout(pool, req, res).catch(() => res.status(500).json(internalError())));

  // change-password: auth + CSRF (mutating POST)
  router.post('/change-password', auth, csrfMiddleware, (req, res) => changePassword(pool, req, res).catch(() => res.status(500).json(internalError())));

  return router;
}

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
import { authMiddleware } from '../middleware/auth';

const REFRESH_COOKIE = 'wr_refresh';

const isSecure = config.env === 'production';

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
    res.status(400).json({ code: 'INVALID_BODY', error: 'loginId and password are required' });
    return;
  }

  const provider = new LocalDbAuthProvider(pool);
  const creds = await provider.verifyCredentials(parsed.data.loginId, parsed.data.password);
  if (!creds) {
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
    res.status(401).json({ code: 'NO_REFRESH_TOKEN', error: 'Refresh token cookie missing' });
    return;
  }

  // Validate CSRF before rotation: lookup session to get stored csrfTokenHash.
  // Uses a brief non-transactional read; rotation itself is atomic.
  const client = await pool.connect();
  let csrfTokenHash: string | null = null;
  try {
    const existing = await verifySession(client, oldRefreshToken);
    if (!existing) {
      res.status(401).json({ code: 'SESSION_INVALID', error: 'Refresh token invalid or expired' });
      return;
    }
    csrfTokenHash = existing.csrfTokenHash;
  } finally {
    client.release();
  }

  if (!validateCsrf(req.headers[CSRF_HEADER], csrfTokenHash!)) {
    res.status(403).json({ code: 'CSRF_INVALID', error: 'Invalid or missing CSRF token' });
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
    res.status(401).json({ code: 'SESSION_ALREADY_ROTATED', error: 'Session was already rotated' });
    return;
  }

  // Fetch user info for the new access token
  interface UserRow {
    user_id: string; role: string; name: string;
    organization_id: string | null; must_change_password: boolean;
  }
  const userClient = await pool.connect();
  let userRow: UserRow | null = null;
  try {
    const { rows } = await userClient.query<UserRow>(
      `SELECT u.id AS user_id, u.role, u.name, u.organization_id, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [newSession.sessionId]
    );
    userRow = rows[0] ?? null;
  } finally {
    userClient.release();
  }

  if (!userRow) {
    res.status(401).json({ code: 'USER_NOT_FOUND', error: 'Associated user not found' });
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

  res.status(200).json({ accessToken, accessExpiresAt: accessExpiresAt.toISOString() });
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
  try {
    const existing = await verifySession(client, rawRefreshToken);
    if (!existing) {
      res.status(401).json({ code: 'SESSION_INVALID', error: 'Refresh token invalid or expired' });
      return;
    }
    sessionId = existing.sessionId;
  } finally {
    client.release();
  }

  await reissueCsrfToken(pool, sessionId!, res, isSecure);
  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

export function createAuthRouter(pool: Pool): Router {
  const router = Router();

  // Unauthenticated
  router.post('/login',   (req, res) => login(pool, req, res).catch(() => res.status(500).json(internalError())));
  router.post('/refresh', (req, res) => refresh(pool, req, res).catch(() => res.status(500).json(internalError())));

  // /csrf is exempt from CSRF middleware and uses refresh cookie for auth
  // (called when access token is expired and csrf cookie is lost)
  router.post('/csrf',    (req, res) => csrfReissue(pool, req, res).catch(() => res.status(500).json(internalError())));

  // Requires valid access token
  router.post('/logout', authMiddleware, (req, res) => logout(pool, req, res).catch(() => res.status(500).json(internalError())));
  router.get('/me',      authMiddleware, (req, res) => me(pool, req, res).catch(() => res.status(500).json(internalError())));

  return router;
}

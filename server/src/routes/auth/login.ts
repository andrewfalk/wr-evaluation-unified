// POST /api/auth/login — per-login-ID backoff (SEC-B M2) and session creation.
// Split out of routes/auth.ts (S5 P1-32); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import config from '../../config';
import { LocalDbAuthProvider } from '../../auth/LocalDbAuthProvider';
import { claimLoginAttempt, clearLoginFailures, loginIdHash } from '../../auth/loginBackoff';
import { createSession } from '../../auth/sessionStore';
import { hashToken } from '../../auth/sessionStore';
import { generateAccessToken } from '../../auth/tokens';
import { setCsrfCookie } from '../../auth/csrf';
import { auditLogin } from '../../middleware/audit';
import { isSecure, setRefreshCookie } from './shared';

// ---------------------------------------------------------------------------
// Route: POST /api/auth/login
// ---------------------------------------------------------------------------
const LoginBody = z.object({
  loginId:    z.string().min(1),
  password:   z.string().min(1),
  // false (the default since 7.2.0, SEC-B M3) = the refresh cookie is a session cookie, cleared when the
  // browser or the Electron app closes. The web login form sends true only when "로그인 유지" is ticked.
  rememberMe: z.boolean().default(false),
});

export async function login(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    auditLogin(pool, req, 'failure');
    res.status(400).json({ code: 'INVALID_BODY', error: 'loginId and password are required' });
    return;
  }

  // Per-login-ID lockout (SEC-B M2). The attempt is counted as a failure before the password is
  // checked, in one statement that also refuses a locked ID, so parallel requests (from any number of
  // IPs) cannot get more than the threshold of guesses past an unlocked ID. A locked ID costs no bcrypt,
  // and a correct password does not get through while locked. Unknown IDs go through the same steps.
  const backoffKey = loginIdHash(parsed.data.loginId);
  const auditExtra = { loginIdHash: backoffKey.slice(0, 16) };
  const claim = await claimLoginAttempt(pool, backoffKey);
  if (!claim.allowed) {
    auditLogin(pool, req, 'failure', null, null, { ...auditExtra, reason: 'locked' });
    res.setHeader('Retry-After', String(claim.retryAfterSec));
    res.status(429).json({
      code:          'LOGIN_LOCKED',
      error:         'Too many failed login attempts for this login ID, please try again later',
      retryAfterSec: claim.retryAfterSec,
    });
    return;
  }

  const provider = new LocalDbAuthProvider(pool);
  const creds = await provider.verifyCredentials(parsed.data.loginId, parsed.data.password);
  if (!creds) {
    // Already counted by claimLoginAttempt.
    auditLogin(pool, req, 'failure', null, null, auditExtra);
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
      config.auth.refreshTokenTtl,
      parsed.data.rememberMe,
      undefined, // a login starts a new lineage
      new Date(Date.now() + config.auth.sessionAbsoluteTtl * 1000),
    );

    // Record last login
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [creds.userId]);

    // A success clears the login ID's failure count, in the same transaction as the new session.
    await clearLoginFailures(client, backoffKey);

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

    setRefreshCookie(res, session.refreshToken, session.expiresAt, session.persistentCookie);
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

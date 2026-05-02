import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { verifyAccessToken } from '../auth/tokens';

// authMiddleware checks both JWT validity AND live session status in the DB.
// A small DB read per request is acceptable on a hospital intranet (<100 concurrent
// users) and ensures logout / password-change revocation is immediate.
export function createAuthMiddleware(pool: Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ code: 'UNAUTHORIZED', error: 'Bearer token required' });
      return;
    }

    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      res.status(401).json({ code: 'TOKEN_INVALID', error: 'Invalid or expired access token' });
      return;
    }

    // Verify the session is still alive (not invalidated by logout / password change).
    // Also confirms user_id matches the token subject as defence-in-depth.
    // Note: revoked_at (rotation grace) is intentionally NOT checked here — the
    // access token remains valid until its own JWT expiry after a normal refresh.
    let rows: { disabled_at: string | null }[];
    try {
      ({ rows } = await pool.query<{ disabled_at: string | null }>(
        `SELECT u.disabled_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = $1
           AND s.user_id = $2
           AND s.invalidated_at IS NULL
           AND s.expires_at > now()`,
        [payload.sessionId, payload.sub]
      ));
    } catch (err) {
      next(err);
      return;
    }

    if (rows.length === 0) {
      res.status(401).json({ code: 'SESSION_REVOKED', error: 'Session has been revoked or expired' });
      return;
    }

    if (rows[0].disabled_at != null) {
      res.status(401).json({ code: 'USER_DISABLED', error: 'User account is disabled' });
      return;
    }

    req.sessionInfo = {
      sessionId:          payload.sessionId,
      userId:             payload.sub,
      csrfTokenHash:      payload.csrfHash,
      organizationId:     payload.orgId,
      role:               payload.role,
      name:               payload.name,
      mustChangePassword: payload.mustChangePassword,
    };

    next();
  };
}

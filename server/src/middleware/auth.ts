import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../auth/tokens';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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
}

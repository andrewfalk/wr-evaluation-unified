import type { Request, Response, NextFunction } from 'express';
import { CSRF_HEADER, validateCsrf } from '../auth/csrf';

const SAFE_METHODS  = new Set(['GET', 'HEAD', 'OPTIONS']);

// POST /api/auth/csrf is called precisely when the csrf cookie is missing,
// so it is exempt. All other mutating routes must pass the check.
const EXEMPT_PATHS  = new Set(['/api/auth/csrf']);

export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  if (EXEMPT_PATHS.has(req.path)) {
    return next();
  }

  // sessionInfo is attached by the auth middleware (T11).
  // If it is absent here, auth failed before CSRF — return 401.
  const session = req.sessionInfo;
  if (!session) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Authentication required' });
    return;
  }

  if (!validateCsrf(req.headers[CSRF_HEADER], session.csrfTokenHash)) {
    res.status(403).json({ code: 'CSRF_INVALID', error: 'Invalid or missing CSRF token' });
    return;
  }

  next();
}

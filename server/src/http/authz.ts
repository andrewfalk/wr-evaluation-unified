// Authorization building blocks, defined once (REFACTORING_ROADMAP S4 / P1-15). Routers compose
// these instead of repeating the checks inline:
//
//   router.use(requireAuth(pool), requireAdmin());                       // admin-only router
//   router.use(requireFeature(() => getStatsWorkbenchAvailability().available));
//   router.post('/x', requireCsrf, requireOrg(), asyncHandler(async (req, res) => {
//     const session = sessionOf(req);                                    // typed, no `!`
//     … req.orgId …
//   }));
//
// requireAuth / requireAdmin / requireCsrf re-export the existing middleware unchanged; the rest is
// new. P1-16 replaces `req.sessionInfo!` and the inline organization checks with sessionOf/requireOrg.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createAuthMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/adminOnly';
import { csrfMiddleware } from '../middleware/csrf';
import { AppError } from './errors';

export type SessionInfo = NonNullable<Request['sessionInfo']>;

/** Bearer token + live session check (middleware/auth.ts, unchanged). */
export const requireAuth = createAuthMiddleware;

/** 403 `FORBIDDEN` unless the session role is admin (middleware/adminOnly.ts, unchanged). Use after requireAuth. */
export const requireAdmin = adminOnly;

/** Double-submit CSRF check for state-changing requests (middleware/csrf.ts, unchanged). */
export const requireCsrf = csrfMiddleware;

/**
 * The authenticated session. Routes behind requireAuth always have one; if a route forgot
 * requireAuth this throws 401 instead of reading `undefined` (the `req.sessionInfo!` it replaces).
 */
export function sessionOf(req: Request): SessionInfo {
  if (!req.sessionInfo) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return req.sessionInfo;
}

/**
 * 403 `FORBIDDEN` 'Organization context required' when the session has no organization (the
 * super-administrator account); otherwise sets `req.orgId`. Use after requireAuth.
 *
 * Not for routes where a missing organization is valid — e.g. the workspace list answers an empty
 * list, capability grants and the autosave endpoints accept it, and the admin super-administrator
 * paths use `?? null`. Those keep their own handling.
 */
export function requireOrg(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const orgId = req.sessionInfo?.organizationId ?? null;
    if (orgId === null) {
      res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
      return;
    }
    req.orgId = orgId;
    next();
  };
}

/**
 * 404 `NOT_FOUND` for every route behind it while the feature is closed — the feature's existence is
 * not revealed (same convention as cross-organization 404s). `isOpen` is read on each request (the
 * stats workbench availability can change at runtime). It must return a boolean: pass
 * `() => getStatsWorkbenchAvailability().available`, not the availability object.
 */
export function requireFeature(isOpen: () => boolean): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (isOpen() !== true) {
      res.status(404).json({ code: 'NOT_FOUND', error: 'Not found' });
      return;
    }
    next();
  };
}

import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Rejects requests from non-admin users with 403.
// Must be used after createAuthMiddleware so req.sessionInfo is populated.
export function adminOnly(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.sessionInfo?.role !== 'admin') {
      res.status(403).json({ code: 'FORBIDDEN', error: 'Admin access required' });
      return;
    }
    next();
  };
}

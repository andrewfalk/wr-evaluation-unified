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
// new. P1-16 replaced the non-null assertions on req.sessionInfo and the inline organization
// checks with sessionOf/requireOrg.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createAuthMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/adminOnly';
import type { Pool } from 'pg';
import { csrfMiddleware } from '../middleware/csrf';
import { isAssignedOrAdmin } from '../db/patientLocks';
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
 * requireAuth this throws 401 instead of reading `undefined` (what the non-null assertion on
 * req.sessionInfo it replaces would have done).
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
 * The organization set by requireOrg(). If a route forgot requireOrg this throws the same 403
 * requireOrg would have sent (fail-closed) instead of reading `undefined`.
 */
export function orgIdOf(req: Request): string {
  if (typeof req.orgId !== 'string') {
    throw new AppError(403, 'FORBIDDEN', 'Organization context required');
  }
  return req.orgId;
}

/**
 * Patient write access for routes with the patient id in `:id` (PATCH/DELETE /api/patients/:id, the
 * lease lock, identity correction). The former middleware/patientAccess.ts assignedDoctorOrAdmin,
 * unchanged: 403 without an organization; admin passes without a lookup; otherwise the patient must
 * exist in the session's organization (else 404 `PATIENT_NOT_FOUND` — another organization's patient
 * is not revealed) and the session must be its assigned doctor (else 403). The decision is
 * isAssignedOrAdmin (db/patientLocks.ts), the same function the transactions re-check with after
 * locking the row (assertAssignedOrAdmin) — this middleware is the fast rejection, not the final
 * guard. Use after requireAuth.
 *
 * Only 'write' exists: the read paths query the patient in their handlers already, and the video
 * routes take the patient id from the validated body, so a 'read' middleware would only add a
 * second query (S4 / P1-17).
 */
export function requirePatientAccess(pool: Pool, _mode: 'write'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = sessionOf(req);
    const orgId = session.organizationId;
    const { id } = req.params;

    if (orgId === null) {
      res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
      return;
    }

    // admin needs no lookup (same short-circuit as before); the transaction re-check still runs.
    if (session.role === 'admin') {
      next();
      return;
    }

    try {
      const { rows } = await pool.query<{ assigned_doctor_user_id: string | null }>(
        `SELECT assigned_doctor_user_id FROM patient_records
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [id, orgId]
      );

      if (rows.length === 0) {
        res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
        return;
      }

      if (!isAssignedOrAdmin(session, rows[0].assigned_doctor_user_id)) {
        res.status(403).json({
          code: 'FORBIDDEN',
          error: 'Only the assigned doctor can modify this patient',
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
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

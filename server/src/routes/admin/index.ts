// Admin router: auth + admin role for the whole router, then the routes of each admin area.
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import { Router } from 'express';
import type { Pool } from 'pg';
import { csrfMiddleware } from '../../middleware/csrf';
import { requireAdmin, requireAuth, requireOrg } from '../../http/authz';
import { asyncHandler } from '../../http/asyncHandler';
import { listDevices, approveDevice, revokeDevice } from './devices';
import { listAuditLogs } from './audit';
import { purgeWorkspace } from './workspacesPurge';
import { listUsers, createUser, resetUserPassword, disableUser, enableUser } from './users';
import { listSignupRequests, approveSignupRequest, rejectSignupRequest } from './signupRequests';
import { listAllPresets, setPresetsVisibility } from './presets';
import { getOrgSettings, updateOrgSettings } from './orgSettings';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAdminRouter(pool: Pool, auditPool: Pool): Router {
  const router = Router();
  // Every admin route requires auth + admin role — once, for the whole router (fail-closed: a route
  // added later cannot forget it, S4 / P1-15). Mutating routes also require CSRF.
  router.use(requireAuth(pool), requireAdmin());
  // requireOrg() only on /org-settings: the other admin handlers read `organizationId ?? null` on
  // purpose — a null organization is the super-administrator, who sees every organization.
  router.get(
    '/devices',
    asyncHandler((req, res) => listDevices(pool, req, res))
  );

  router.post(
    '/devices/:id/approve',
    csrfMiddleware,
    asyncHandler((req, res) => approveDevice(pool, req, res))
  );

  router.post(
    '/devices/:id/revoke',
    csrfMiddleware,
    asyncHandler((req, res) => revokeDevice(pool, req, res))
  );

  router.get(
    '/audit',
    asyncHandler((req, res) => listAuditLogs(pool, auditPool, req, res))
  );

  router.delete(
    '/workspaces/:id/purge',
    csrfMiddleware,
    asyncHandler((req, res) => purgeWorkspace(pool, req, res))
  );

  router.get(
    '/users',
    asyncHandler((req, res) => listUsers(pool, req, res))
  );

  router.post(
    '/users',
    csrfMiddleware,
    asyncHandler((req, res) => createUser(pool, req, res))
  );

  router.post(
    '/users/:id/reset-password',
    csrfMiddleware,
    asyncHandler((req, res) => resetUserPassword(pool, req, res))
  );

  router.post(
    '/users/:id/disable',
    csrfMiddleware,
    asyncHandler((req, res) => disableUser(pool, req, res))
  );

  router.post(
    '/users/:id/enable',
    csrfMiddleware,
    asyncHandler((req, res) => enableUser(pool, req, res))
  );

  router.get(
    '/org-settings',
    requireOrg(),
    asyncHandler((req, res) => getOrgSettings(pool, req, res))
  );

  router.patch(
    '/org-settings',
    csrfMiddleware, requireOrg(),
    asyncHandler((req, res) => updateOrgSettings(pool, req, res))
  );

  router.get(
    '/presets',
    asyncHandler((req, res) => listAllPresets(pool, req, res))
  );

  router.post(
    '/presets/visibility',
    csrfMiddleware,
    asyncHandler((req, res) => setPresetsVisibility(pool, req, res))
  );

  router.get(
    '/signup-requests',
    asyncHandler((req, res) => listSignupRequests(pool, req, res))
  );

  router.post(
    '/signup-requests/:id/approve',
    csrfMiddleware,
    asyncHandler((req, res) => approveSignupRequest(pool, req, res))
  );

  router.post(
    '/signup-requests/:id/reject',
    csrfMiddleware,
    asyncHandler((req, res) => rejectSignupRequest(pool, req, res))
  );

  return router;
}

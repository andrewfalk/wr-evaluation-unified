// Workspaces router: auth, organisation and the route table.
// Split out of routes/workspaces.ts (S5 P1-31); handler bodies unchanged.
import { Router } from 'express';
import type { Pool } from 'pg';
import { createAuthMiddleware } from '../../middleware/auth';
import { csrfMiddleware } from '../../middleware/csrf';
import { auditMiddleware } from '../../middleware/audit';
import { asyncHandler } from '../../http/asyncHandler';
import { requireOrg } from '../../http/authz';
import { listWorkspaces, getWorkspace, saveWorkspace, deleteWorkspace } from './routes';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createWorkspacesRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);
  const audit  = (action: string) =>
    auditMiddleware(pool, action, 'workspace', (req) => req.params.id ?? null);

  router.get(
    '/',
    auth, audit('workspace_list'),
    asyncHandler((req, res) => listWorkspaces(pool, req, res))
  );

  router.get(
    '/:id',
    auth, audit('workspace_load'), requireOrg(),
    asyncHandler((req, res) => getWorkspace(pool, req, res))
  );

  router.post(
    '/',
    auth, csrfMiddleware, audit('workspace_save'), requireOrg(),
    asyncHandler((req, res) => saveWorkspace(pool, req, res))
  );

  router.put(
    '/:id',
    auth, csrfMiddleware, audit('workspace_overwrite'), requireOrg(),
    asyncHandler((req, res) => saveWorkspace(pool, req, res, {
      workspaceId: req.params.id,
      statusCode: 200,
    }))
  );

  router.delete(
    '/:id',
    auth, csrfMiddleware, audit('workspace_delete'), requireOrg(),
    asyncHandler((req, res) => deleteWorkspace(pool, req, res))
  );

  return router;
}

// Exported by routes/workspaces.ts before the split; keep the module surface.
export { normalizeWorkspacePatients, type WorkspaceDateFailure, type NormalizeWorkspaceResult } from './normalize';
export type { SkipReason, UpsertOutcome } from '../../domain/patients/patientRecordsService';

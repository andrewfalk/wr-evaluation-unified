// Admin console: hard purge of a workspace snapshot.
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { sessionOf } from '../../http/authz';
import { writeAuditLog } from '../../middleware/audit';

// ---------------------------------------------------------------------------
// DELETE /api/admin/workspaces/:id/purge
// Hard-deletes a workspace row immediately (bypasses the 5-year retention window).
// Org-scoped: an admin with an org can only purge workspaces in their org.
// ---------------------------------------------------------------------------
export async function purgeWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = sessionOf(req);
  const orgId   = session.organizationId ?? null;

  const { rows } = await pool.query<{ id: string }>(
    `DELETE FROM workspaces
     WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)
     RETURNING id`,
    [id, orgId]
  );

  if (rows.length === 0) {
    res.status(404).json({ code: 'WORKSPACE_NOT_FOUND', error: 'Workspace not found' });
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_workspace_purge',
    targetType:  'workspace',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(204).end();
}

// Admin console: preset list across the organization and visibility changes.
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { sessionOf } from '../../http/authz';
import { writeAuditLog } from '../../middleware/audit';

// ---------------------------------------------------------------------------
// GET /api/admin/presets
// Org-wide preset list (including other users' private presets) for the admin
// preset-sharing manager. Excludes `modules` (not needed in the list view and
// minimizes exposure). org=null superadmin sees all orgs — same convention as
// listUsers; organizationId is returned so the UI can identify cross-org rows.
// ---------------------------------------------------------------------------
interface AdminPresetRow {
  id:              string;
  organization_id: string | null;
  job_name:        string;
  category:        string;
  description:     string;
  visibility:      string;
  revision:        number;
  owner_user_id:   string | null;
  owner_name:      string | null;
  updated_at:      Date | null;
}

export async function listAllPresets(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId = req.sessionInfo?.organizationId ?? null;
  const { rows } = await pool.query<AdminPresetRow>(
    `SELECT cp.id, cp.organization_id, cp.job_name, cp.category, cp.description,
            cp.visibility, cp.revision, cp.owner_user_id, u.name AS owner_name, cp.updated_at
     FROM custom_presets cp
     LEFT JOIN users u ON u.id = cp.owner_user_id
     WHERE cp.deleted_at IS NULL AND ($1::uuid IS NULL OR cp.organization_id = $1)
     ORDER BY cp.updated_at DESC`,
    [orgId]
  );
  res.status(200).json({
    presets: rows.map((p) => ({
      id:             p.id,
      organizationId: p.organization_id,
      jobName:        p.job_name,
      category:       p.category,
      description:    p.description,
      visibility:     p.visibility,
      revision:       p.revision,
      ownerUserId:    p.owner_user_id,
      ownerName:      p.owner_name,
      updatedAt:      p.updated_at,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/presets/visibility
// Bulk set visibility for selected presets (org-scoped). `visibility <> $2`
// skips rows already at the target so revisions aren't bumped needlessly.
// ---------------------------------------------------------------------------
const setPresetsVisibilitySchema = z.object({
  ids:        z.array(z.string().uuid()).min(1).max(500),
  visibility: z.enum(['private', 'organization']),
});

export async function setPresetsVisibility(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = setPresetsVisibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parsed.error.issues });
    return;
  }

  const session = sessionOf(req);
  const orgId   = session.organizationId ?? null;
  // Dedupe so `requested` reflects distinct targets even if the body repeats ids.
  const ids        = [...new Set(parsed.data.ids)];
  const visibility = parsed.data.visibility;

  const { rows } = await pool.query<{ id: string }>(
    `UPDATE custom_presets
     SET visibility = $2, revision = revision + 1, updated_at = now()
     WHERE id = ANY($1::uuid[])
       AND deleted_at IS NULL
       AND ($3::uuid IS NULL OR organization_id = $3)
       AND visibility <> $2
     RETURNING id`,
    [ids, visibility, orgId]
  );

  const updatedIds = rows.map((r) => r.id);
  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_presets_set_visibility',
    targetType:  'custom_preset',
    targetId:    null,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
    extra:       { requested: ids.length, updated: updatedIds.length, visibility, requestedPresetIds: ids, updatedPresetIds: updatedIds },
  });

  res.status(200).json({ requested: ids.length, updated: updatedIds.length });
}

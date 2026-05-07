import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { CreatePresetBodySchema as CreateBody, UpdatePresetBodySchema as UpdateBody } from '@wr/contracts/preset';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { writeAuditLog } from '../middleware/audit';

// ---------------------------------------------------------------------------
// Row → client shape
// ---------------------------------------------------------------------------

type PresetRow = Record<string, unknown>;

function toClient(row: PresetRow) {
  const toIso = (v: unknown) =>
    v instanceof Date ? v.toISOString() : (v as string | null) ?? null;
  return {
    id:          row['id'],
    jobName:     row['job_name'],
    category:    row['category'],
    description: row['description'],
    visibility:  row['visibility'],
    revision:    row['revision'],
    modules:     row['modules'] ?? {},
    ownerUserId: row['owner_user_id'],
    source:      'custom',
    createdAt:   toIso(row['created_at']),
    updatedAt:   toIso(row['updated_at']),
  };
}

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function listPresets(pool: Pool, req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = req.sessionInfo!;
  if (!organizationId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const { rows } = await pool.query(
    `SELECT * FROM custom_presets
     WHERE deleted_at IS NULL
       AND organization_id = $1
       AND (owner_user_id = $2 OR visibility = 'organization')
     ORDER BY updated_at DESC`,
    [organizationId, userId],
  );

  res.json({ presets: rows.map(r => toClient(r as PresetRow)) });
}

async function createPreset(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parsed.error.issues });
    return;
  }

  const { organizationId, userId } = req.sessionInfo!;
  if (!organizationId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const { jobName, category, description, visibility, modules } = parsed.data;

  // Idempotent: return existing preset if one with same identity already exists.
  const { rows: existing } = await pool.query(
    `SELECT * FROM custom_presets
     WHERE deleted_at IS NULL
       AND organization_id = $1
       AND owner_user_id   = $2
       AND job_name        = $3
       AND category        = $4
       AND description     = $5
     LIMIT 1`,
    [organizationId, userId, jobName, category, description],
  );
  if (existing.length > 0) {
    res.status(200).json({ preset: toClient(existing[0] as PresetRow) });
    return;
  }

  const id = randomUUID();
  let insertedRows: PresetRow[];
  try {
    const { rows } = await pool.query(
      `INSERT INTO custom_presets
         (id, organization_id, owner_user_id, job_name, category, description, visibility, modules)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [id, organizationId, userId, jobName, category, description, visibility, JSON.stringify(modules)],
    );
    insertedRows = rows as PresetRow[];
  } catch (err: unknown) {
    // Concurrent create hit the unique index — return the existing preset idempotently.
    if ((err as { code?: string }).code === '23505') {
      const { rows: dup } = await pool.query(
        `SELECT * FROM custom_presets
         WHERE deleted_at IS NULL
           AND organization_id = $1 AND owner_user_id = $2
           AND job_name = $3 AND category = $4 AND description = $5
         LIMIT 1`,
        [organizationId, userId, jobName, category, description],
      );
      res.status(200).json({ preset: toClient((dup[0] ?? {}) as PresetRow) });
      return;
    }
    throw err;
  }

  await writeAuditLog(pool, {
    actorUserId: userId,
    actorOrgId:  organizationId,
    action:      'preset.create',
    targetType:  'custom_preset',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] as string ?? null,
  });

  res.status(201).json({ preset: toClient(insertedRows[0]) });
}

async function updatePreset(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parsed.error.issues });
    return;
  }

  const { organizationId, userId } = req.sessionInfo!;
  if (!organizationId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const { id } = req.params;
  const ifMatchRaw = req.headers['if-match'];
  if (!ifMatchRaw) {
    res.status(428).json({ code: 'PRECONDITION_REQUIRED', error: 'If-Match header required' });
    return;
  }

  const ifMatch = parseInt(ifMatchRaw as string, 10);
  if (!Number.isInteger(ifMatch) || ifMatch < 1) {
    res.status(400).json({ code: 'INVALID_IF_MATCH', error: 'If-Match must be a positive integer' });
    return;
  }

  const { rows: found } = await pool.query(
    `SELECT * FROM custom_presets WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (found.length === 0) {
    res.status(404).json({ code: 'NOT_FOUND', error: 'Preset not found' });
    return;
  }

  const row = found[0] as PresetRow;
  if (row['organization_id'] !== organizationId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Not your organization' });
    return;
  }
  // Only the owner may edit — even org-visible presets are write-protected to
  // non-owners until explicit collaborative-edit permissions are introduced.
  if (row['owner_user_id'] !== userId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Cannot edit this preset' });
    return;
  }

  const { jobName, category, description, visibility, modules, replaceModules } = parsed.data;

  const mergedModules =
    modules !== undefined
      ? (replaceModules ? modules : { ...(row['modules'] as object), ...modules })
      : row['modules'];

  // Atomic revision check inside the UPDATE prevents stale writes when two
  // requests pass the SELECT checks simultaneously.
  const { rows: updated } = await pool.query(
    `UPDATE custom_presets SET
       job_name    = COALESCE($1, job_name),
       category    = COALESCE($2, category),
       description = COALESCE($3, description),
       visibility  = COALESCE($4, visibility),
       modules     = $5,
       revision    = revision + 1,
       updated_at  = now()
     WHERE id = $6 AND revision = $7 AND deleted_at IS NULL
     RETURNING *`,
    [
      jobName     ?? null,
      category    ?? null,
      description ?? null,
      visibility  ?? null,
      JSON.stringify(mergedModules),
      id,
      ifMatch,
    ],
  );

  if (updated.length === 0) {
    res.status(409).json({ code: 'REVISION_CONFLICT', error: 'Preset was modified concurrently' });
    return;
  }

  await writeAuditLog(pool, {
    actorUserId: userId,
    actorOrgId:  organizationId,
    action:      'preset.update',
    targetType:  'custom_preset',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] as string ?? null,
  });

  res.json({ preset: toClient(updated[0] as PresetRow) });
}

async function deletePreset(pool: Pool, req: Request, res: Response): Promise<void> {
  const { organizationId, userId } = req.sessionInfo!;
  if (!organizationId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const { id } = req.params;

  // ?revision=N is required — prevents stale cross-device deletes.
  const revisionRaw = req.query['revision'];
  if (revisionRaw === undefined) {
    res.status(428).json({ code: 'PRECONDITION_REQUIRED', error: 'revision query parameter required' });
    return;
  }
  const clientRevision = parseInt(revisionRaw as string, 10);
  if (!Number.isInteger(clientRevision) || clientRevision < 1) {
    res.status(400).json({ code: 'INVALID_REVISION', error: 'revision must be a positive integer' });
    return;
  }

  // SELECT for 404/403 checks before the atomic soft-delete.
  const { rows: found } = await pool.query(
    `SELECT * FROM custom_presets WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (found.length === 0) {
    res.status(404).json({ code: 'NOT_FOUND', error: 'Preset not found' });
    return;
  }

  const row = found[0] as PresetRow;
  if (row['organization_id'] !== organizationId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Not your organization' });
    return;
  }
  if (row['owner_user_id'] !== userId) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Can only delete your own presets' });
    return;
  }

  // Atomic soft-delete: revision in WHERE prevents a stale delete racing with a PATCH.
  const { rows: deleted } = await pool.query(
    `UPDATE custom_presets SET deleted_at = now()
     WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3
       AND revision = $4 AND deleted_at IS NULL
     RETURNING id`,
    [id, organizationId, userId, clientRevision],
  );
  if (deleted.length === 0) {
    res.status(409).json({ code: 'REVISION_CONFLICT', error: 'Preset was modified concurrently' });
    return;
  }

  await writeAuditLog(pool, {
    actorUserId: userId,
    actorOrgId:  organizationId,
    action:      'preset.delete',
    targetType:  'custom_preset',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] as string ?? null,
  });

  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createPresetsRouter(pool: Pool) {
  const router = Router();
  const auth   = createAuthMiddleware(pool);

  router.get('/',    auth,              (req, res) => listPresets(pool, req, res).catch(() => res.status(500).json(internalError())));
  router.post('/',   auth, csrfMiddleware, (req, res) => createPreset(pool, req, res).catch(() => res.status(500).json(internalError())));
  router.patch('/:id', auth, csrfMiddleware, (req, res) => updatePreset(pool, req, res).catch(() => res.status(500).json(internalError())));
  router.delete('/:id', auth, csrfMiddleware, (req, res) => deletePreset(pool, req, res).catch(() => res.status(500).json(internalError())));

  return router;
}

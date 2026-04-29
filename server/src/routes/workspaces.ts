import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { auditMiddleware } from '../middleware/audit';

// ---------------------------------------------------------------------------
// POST /api/workspaces body schema
// Mirrors SaveWorkspaceRequestSchema from shared/contracts/workspace.ts.
// Defined locally to avoid a runtime dependency on the built contracts package.
// patients is z.unknown() — snapshot semantics: we store whatever the client
// sends without re-validating every patient field on the server side.
// ---------------------------------------------------------------------------
const SaveBody = z.object({
  name:     z.string().min(1, 'Workspace name is required'),
  patients: z.array(z.unknown()),
});

interface WorkspaceRow {
  id:               string;
  name:             string;
  created_at:       Date;
  patient_ids:      string[];
  snapshot_payload: unknown;
}

// Extracts UUIDs from the patients array so patient_ids stays queryable for
// ?view=current. Only well-formed UUIDs are included; local string IDs are skipped.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function extractPatientIds(patients: unknown[]): string[] {
  const ids: string[] = [];
  for (const p of patients) {
    if (typeof p === 'object' && p !== null && 'id' in p) {
      const id = (p as Record<string, unknown>).id;
      if (typeof id === 'string' && UUID_RE.test(id)) ids.push(id);
    }
  }
  return ids;
}

function toItem(row: WorkspaceRow) {
  const patients = Array.isArray(row.snapshot_payload) ? row.snapshot_payload : [];
  return {
    id:      row.id,
    name:    row.name,
    count:   patients.length,
    savedAt: row.created_at.toISOString(),
    patients,
  };
}

async function listQuery(pool: Pool, orgId: string, userId: string): Promise<WorkspaceRow[]> {
  const { rows } = await pool.query<WorkspaceRow>(
    `SELECT id, name, created_at, patient_ids, snapshot_payload
     FROM workspaces
     WHERE organization_id = $1 AND owner_user_id = $2
     ORDER BY created_at DESC`,
    [orgId, userId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// GET /api/workspaces
// ---------------------------------------------------------------------------
async function listWorkspaces(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;

  // Superadmin (null org) has no org-scoped workspace bucket.
  if (orgId === null) {
    res.status(200).json({ items: [] });
    return;
  }

  const rows = await listQuery(pool, orgId, session.userId);
  res.status(200).json({ items: rows.map(toItem) });
}

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id
// Default: snapshot_payload (frozen at save time)
// ?view=current: re-fetch live patient records by patient_ids
// ---------------------------------------------------------------------------
async function getWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const session   = req.sessionInfo!;
  const orgId     = session.organizationId;
  const { id }    = req.params;
  const isCurrent = req.query['view'] === 'current';

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const { rows } = await pool.query<WorkspaceRow>(
    `SELECT id, name, created_at, patient_ids, snapshot_payload
     FROM workspaces
     WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3`,
    [id, orgId, session.userId]
  );

  if (rows.length === 0) {
    res.status(404).json({ code: 'WORKSPACE_NOT_FOUND', error: 'Workspace not found' });
    return;
  }

  const row = rows[0];

  if (!isCurrent) {
    res.status(200).json(toItem(row));
    return;
  }

  // ?view=current — load latest payloads from patient_records.
  // IDs not found in patient_records (deleted patients) are returned as
  // { id, redacted: true } stubs; the UI grays these out with a notice.
  const patientIds: string[] = row.patient_ids ?? [];
  let currentPatients: unknown[];

  if (patientIds.length === 0) {
    currentPatients = [];
  } else {
    interface PatientRecordRow { id: string; deleted_at: Date | null; payload: unknown; }
    const { rows: prRows } = await pool.query<PatientRecordRow>(
      `SELECT id, deleted_at, payload
       FROM patient_records
       WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
      [patientIds, orgId]
    );

    const found = new Map(prRows.map((r) => [r.id, r]));
    currentPatients = patientIds.map((pid) => {
      const rec = found.get(pid);
      // Deleted (soft-delete) or never-migrated patient → redacted stub
      if (!rec || rec.deleted_at !== null) return { id: pid, redacted: true };
      return rec.payload;
    });
  }

  res.status(200).json({
    id:       row.id,
    name:     row.name,
    count:    patientIds.length,
    savedAt:  row.created_at.toISOString(),
    patients: currentPatients,
    view:     'current',
  });
}

// ---------------------------------------------------------------------------
// POST /api/workspaces
// Body: { name, patients }
// Stores snapshot, returns refreshed list.
// ---------------------------------------------------------------------------
async function saveWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const parse = SaveBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const { name, patients } = parse.data;
  const patientIds = extractPatientIds(patients);

  await pool.query(
    `INSERT INTO workspaces (organization_id, owner_user_id, name, patient_ids, snapshot_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [orgId, session.userId, name, patientIds, JSON.stringify(patients)]
  );

  const rows = await listQuery(pool, orgId, session.userId);
  res.status(201).json({ items: rows.map(toItem) });
}

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id
// Returns refreshed list after deletion.
// ---------------------------------------------------------------------------
async function deleteWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  const { id }  = req.params;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const result = await pool.query(
    `DELETE FROM workspaces
     WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3`,
    [id, orgId, session.userId]
  );

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ code: 'WORKSPACE_NOT_FOUND', error: 'Workspace not found' });
    return;
  }

  const rows = await listQuery(pool, orgId, session.userId);
  res.status(200).json({ items: rows.map(toItem) });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

export function createWorkspacesRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);
  const audit  = (action: string) =>
    auditMiddleware(pool, action, 'workspace', (req) => req.params.id ?? null);

  router.get(
    '/',
    auth, audit('workspace_list'),
    (req, res) => listWorkspaces(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.get(
    '/:id',
    auth, audit('workspace_load'),
    (req, res) => getWorkspace(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/',
    auth, csrfMiddleware, audit('workspace_save'),
    (req, res) => saveWorkspace(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.delete(
    '/:id',
    auth, csrfMiddleware, audit('workspace_delete'),
    (req, res) => deleteWorkspace(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  return router;
}

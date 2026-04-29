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

// ---------------------------------------------------------------------------
// Patient metadata extraction helpers
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Resolve the authoritative server-side UUID for a patient.
// Phase 3 (patient 1급 API) assigns sync.serverId. Until then, patient.id
// is used as the row ID. This function ensures patient_ids[] and
// patient_records.id are consistent across both phases.
function resolvePatientId(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return null;
  const raw = p as Record<string, unknown>;
  const sync = raw['sync'];
  if (typeof sync === 'object' && sync !== null) {
    const serverId = (sync as Record<string, unknown>)['serverId'];
    if (isUuid(serverId)) return serverId;
  }
  return isUuid(raw['id']) ? (raw['id'] as string) : null;
}

// Extracts UUIDs for the workspaces.patient_ids column.
// Prefers sync.serverId (server-assigned) over patient.id (local UUID).
function extractPatientIds(patients: unknown[]): string[] {
  const ids: string[] = [];
  for (const p of patients) {
    const id = resolvePatientId(p);
    if (id) ids.push(id);
  }
  return ids;
}

// Metadata extracted from a patient object for patient_records upsert.
interface PatientMeta {
  id:              string;
  name:            string;
  patientNo:       string | null;
  birthDate:       string | null;
  evaluationDate:  string | null;
  activeModules:   string[];
  diagnosesCodes:  string[];
  jobsNames:       string[];
  payload:         unknown;
}

// Safely pull metadata fields out of an unknown patient object.
// Returns null if the patient cannot be identified or has no name (NOT NULL in DB).
function extractPatientMeta(p: unknown): PatientMeta | null {
  const id = resolvePatientId(p);
  if (!id) return null;

  if (typeof p !== 'object' || p === null) return null;
  const raw    = p as Record<string, unknown>;
  const data   = typeof raw['data'] === 'object' && raw['data'] !== null
    ? raw['data'] as Record<string, unknown>
    : null;
  const shared = data && typeof data['shared'] === 'object' && data['shared'] !== null
    ? data['shared'] as Record<string, unknown>
    : null;

  const name = typeof shared?.['name'] === 'string' ? (shared['name'] as string).trim() : '';
  if (!name) return null; // name is NOT NULL in DB

  const diagnoses = Array.isArray(shared?.['diagnoses']) ? shared!['diagnoses'] as unknown[] : [];
  const jobs      = Array.isArray(shared?.['jobs'])      ? shared!['jobs']      as unknown[] : [];
  const mods      = Array.isArray(data?.['activeModules']) ? data!['activeModules'] as unknown[] : [];

  return {
    id,
    name,
    patientNo:      typeof shared?.['patientNo']      === 'string' ? shared!['patientNo']      as string : null,
    birthDate:      typeof shared?.['birthDate']      === 'string' && (shared['birthDate'] as string).trim()
      ? shared!['birthDate'] as string : null,
    evaluationDate: typeof shared?.['evaluationDate'] === 'string' && (shared['evaluationDate'] as string).trim()
      ? shared!['evaluationDate'] as string : null,
    activeModules:  mods.filter((m): m is string => typeof m === 'string'),
    diagnosesCodes: diagnoses
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => d['code'])
      .filter((c): c is string => typeof c === 'string'),
    jobsNames: jobs
      .filter((j): j is Record<string, unknown> => typeof j === 'object' && j !== null)
      .map((j) => j['jobName'])
      .filter((n): n is string => typeof n === 'string'),
    payload: p,
  };
}

// Upsert a single patient into patient_records. Errors are logged but not thrown
// so that a single malformed patient does not block the whole workspace save.
// The WHERE clause on ON CONFLICT ensures we never overwrite another org's patient.
async function upsertPatientRecord(
  pool: Pool, orgId: string, userId: string, meta: PatientMeta,
): Promise<void> {
  await pool.query(
    `INSERT INTO patient_records
       (id, organization_id, owner_user_id, name, patient_no,
        birth_date, evaluation_date, active_modules, diagnoses_codes,
        jobs_names, revision, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)
     ON CONFLICT (id) DO UPDATE SET
       name             = EXCLUDED.name,
       patient_no       = EXCLUDED.patient_no,
       birth_date       = EXCLUDED.birth_date,
       evaluation_date  = EXCLUDED.evaluation_date,
       active_modules   = EXCLUDED.active_modules,
       diagnoses_codes  = EXCLUDED.diagnoses_codes,
       jobs_names       = EXCLUDED.jobs_names,
       revision         = patient_records.revision + 1,
       payload          = EXCLUDED.payload,
       deleted_at       = NULL
     WHERE patient_records.organization_id = EXCLUDED.organization_id`,
    [
      meta.id, orgId, userId, meta.name,
      meta.patientNo,
      meta.birthDate       ? meta.birthDate       : null,
      meta.evaluationDate  ? meta.evaluationDate  : null,
      meta.activeModules,
      meta.diagnosesCodes,
      meta.jobsNames,
      JSON.stringify(meta.payload),
    ]
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
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
// Stores snapshot AND upserts patient_records so ?view=current works immediately.
// patient_records upserts are best-effort — failures are logged but do not block
// the workspace save; the snapshot remains the primary source of truth.
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

  // Primary operation: insert workspace snapshot.
  await pool.query(
    `INSERT INTO workspaces (organization_id, owner_user_id, name, patient_ids, snapshot_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [orgId, session.userId, name, patientIds, JSON.stringify(patients)]
  );

  // Secondary (best-effort): decompose patients into patient_records so that
  // ?view=current returns live data immediately after the first workspace save.
  // Failures are logged per patient and do not roll back the workspace row.
  const metas = patients.map(extractPatientMeta).filter((m): m is PatientMeta => m !== null);
  const results = await Promise.allSettled(
    metas.map((meta) => upsertPatientRecord(pool, orgId, session.userId, meta))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('[workspaces] patient_records upsert failed', {
        patientId: metas[i].id,
        err: r.reason,
      });
    }
  });

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

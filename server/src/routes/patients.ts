import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { auditMiddleware } from '../middleware/audit';
import {
  PatientIdentityConflictError,
  resolvePatientPersonId,
  type PatientPersonWarning,
  type QueryRunner,
} from '../db/patientPersons';

// ---------------------------------------------------------------------------
// Schemas — defined locally, mirroring shared/contracts/patient.ts structure
// without a hard runtime dependency on the built contracts package.
// ---------------------------------------------------------------------------

const CreateBody = z.object({
  id:        z.string().uuid().optional(),
  phase:     z.enum(['intake', 'evaluation']).default('intake'),
  createdAt: z.string().optional(),
  data: z.object({
    shared:        z.record(z.string(), z.unknown()),
    modules:       z.record(z.string(), z.unknown()).default({}),
    activeModules: z.array(z.string()).default([]),
  }),
});

const PatchBody = z.object({
  phase: z.enum(['intake', 'evaluation']).optional(),
  data: z.object({
    shared:        z.record(z.string(), z.unknown()),
    modules:       z.record(z.string(), z.unknown()),
    activeModules: z.array(z.string()),
  }).optional(),
});

// ---------------------------------------------------------------------------
// DB row interface
// ---------------------------------------------------------------------------

interface PatientRow {
  id:              string;
  organization_id: string;
  patient_person_id: string;
  owner_user_id:   string;
  name:            string;
  patient_no:      string | null;
  birth_date:      string | null;
  injury_date:     string | null;
  evaluation_date: string | null;
  active_modules:  string[];
  diagnoses_codes: string[];
  jobs_names:      string[];
  revision:        number;
  created_at:      Date;
  updated_at:      Date;
  payload:         unknown;
}

const SELECT_COLS = `
  id, organization_id, patient_person_id, owner_user_id, name, patient_no, birth_date,
  injury_date, evaluation_date, active_modules, diagnoses_codes, jobs_names,
  revision, created_at, updated_at, payload`;

interface PgErrorLike {
  code?:       string;
  constraint?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Rejects "1abc", "0", "-1", "". Returns null on invalid input.
function parsePositiveInt(val: unknown): number | null {
  const s = String(val ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 ? n : null;
}

function isUniqueViolation(err: unknown): err is PgErrorLike {
  return (err as PgErrorLike | null)?.code === '23505';
}

function uniqueConflictResponse(err: PgErrorLike): { code: string; error: string } {
  if (err.constraint === 'patient_persons_org_patient_no_uniq') {
    return {
      code:  'PATIENT_PERSON_CONFLICT',
      error: 'A patient with this patient number already exists in this organization',
    };
  }
  return { code: 'CONFLICT', error: 'A patient with this ID already exists' };
}

function identityConflictResponse(): { code: string; error: string } {
  return {
    code:  'PATIENT_IDENTITY_CONFLICT',
    error: 'This patient number belongs to an existing patient with a different birth date',
  };
}

interface ExtractedMeta {
  name:           string;
  patientNo:      string | null;
  birthDate:      string | null;
  injuryDate:     string | null;
  evaluationDate: string | null;
  activeModules:  string[];
  diagnosesCodes: string[];
  jobsNames:      string[];
}

function extractMeta(data: Record<string, unknown>): ExtractedMeta {
  const shared = typeof data['shared'] === 'object' && data['shared'] !== null
    ? (data['shared'] as Record<string, unknown>) : {};
  const diags = Array.isArray(shared['diagnoses']) ? shared['diagnoses'] as unknown[] : [];
  const jobs  = Array.isArray(shared['jobs'])      ? shared['jobs']      as unknown[] : [];

  return {
    name:           strOrNull(shared['name']) ?? '',
    patientNo:      strOrNull(shared['patientNo']),
    birthDate:      strOrNull(shared['birthDate']),
    injuryDate:     strOrNull(shared['injuryDate']),
    evaluationDate: strOrNull(shared['evaluationDate']),
    activeModules:  Array.isArray(data['activeModules'])
      ? (data['activeModules'] as unknown[]).filter((m): m is string => typeof m === 'string')
      : [],
    diagnosesCodes: diags
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => d['code'])
      .filter((c): c is string => typeof c === 'string'),
    jobsNames: jobs
      .filter((j): j is Record<string, unknown> => typeof j === 'object' && j !== null)
      .map((j) => j['jobName'])
      .filter((n): n is string => typeof n === 'string'),
  };
}

function toResponse(row: PatientRow, warnings: PatientPersonWarning[] = []): Record<string, unknown> {
  const base = typeof row.payload === 'object' && row.payload !== null
    ? (row.payload as Record<string, unknown>) : {};

  return {
    ...base,
    id: row.id,
    sync: {
      serverId:    row.id,
      revision:    row.revision,
      syncStatus:  'synced',
      lastSyncedAt: row.updated_at.toISOString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/patients
// Supports: q (name/patientNo ILIKE), diagnosesCode, jobName, module,
//           limit (default 20, max 100), offset (default 0).
// ---------------------------------------------------------------------------
async function listPatients(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const q            = typeof req.query['q']            === 'string' ? req.query['q'].trim()            : '';
  const diagCode     = typeof req.query['diagnosesCode'] === 'string' ? req.query['diagnosesCode'].trim() : '';
  const jobName      = typeof req.query['jobName']       === 'string' ? req.query['jobName'].trim()       : '';
  const moduleFilter = typeof req.query['module']        === 'string' ? req.query['module'].trim()        : '';

  const rawLimit  = Number(req.query['limit']  ?? 20);
  const rawOffset = Number(req.query['offset'] ?? 0);
  const limit     = !isFinite(rawLimit)  || rawLimit  < 1 ? 20 : Math.min(rawLimit,  100);
  const offset    = !isFinite(rawOffset) || rawOffset < 0 ? 0  : rawOffset;

  const filterParams: unknown[] = [orgId];
  const conditions: string[] = ['organization_id = $1', 'deleted_at IS NULL'];

  if (q) {
    filterParams.push(`%${q}%`);
    const idx = filterParams.length;
    conditions.push(`(name ILIKE $${idx} OR patient_no ILIKE $${idx})`);
  }
  if (diagCode) {
    filterParams.push(diagCode);
    conditions.push(`$${filterParams.length} = ANY(diagnoses_codes)`);
  }
  if (jobName) {
    filterParams.push(`%${jobName}%`);
    conditions.push(
      `EXISTS (SELECT 1 FROM unnest(jobs_names) _j WHERE _j ILIKE $${filterParams.length})`
    );
  }
  if (moduleFilter) {
    filterParams.push(moduleFilter);
    conditions.push(`$${filterParams.length} = ANY(active_modules)`);
  }

  const where = conditions.join(' AND ');

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<PatientRow>(
      `SELECT ${SELECT_COLS}
       FROM patient_records
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
      [...filterParams, limit, offset]
    ),
    pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM patient_records WHERE ${where}`,
      filterParams
    ),
  ]);

  res.status(200).json({
    items:  rows.map((row) => toResponse(row)),
    total:  parseInt(countRows[0]?.total ?? '0', 10),
    limit,
    offset,
  });
}

// ---------------------------------------------------------------------------
// GET /api/patients/:id
// ---------------------------------------------------------------------------
async function getPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  const { id }  = req.params;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const { rows } = await pool.query<PatientRow>(
    `SELECT ${SELECT_COLS}
     FROM patient_records
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [id, orgId]
  );

  if (rows.length === 0) {
    res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    return;
  }

  res.status(200).json(toResponse(rows[0]));
}

// ---------------------------------------------------------------------------
// POST /api/patients
// Requires Idempotency-Key header.
//
// All DB work (slot reservation, patient INSERT, idempotency finalization) runs
// in a single transaction so a crash or error automatically rolls back the slot,
// letting the client retry with the same key. Expired slots are pruned inside
// the transaction so they never block a fresh retry.
// ---------------------------------------------------------------------------
async function createPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const idempKey = typeof req.headers['idempotency-key'] === 'string'
    ? req.headers['idempotency-key'].trim() : null;

  if (!idempKey) {
    res.status(400).json({ code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'Idempotency-Key header is required' });
    return;
  }

  // Validate body before touching the DB so a bad request never reserves a slot.
  const parse = CreateBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }

  const { id: clientId, phase, createdAt, data } = parse.data;
  const meta = extractMeta(data as Record<string, unknown>);

  if (!meta.name) {
    res.status(400).json({ code: 'NAME_REQUIRED', error: 'Patient name (data.shared.name) is required' });
    return;
  }

  const patientId   = clientId ?? randomUUID();
  const fullPayload = { id: patientId, phase, createdAt: createdAt ?? new Date().toISOString(), data };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Prune any expired slot for this key so an expired key is always retryable.
    await client.query(
      `DELETE FROM idempotency_keys WHERE key = $1 AND user_id = $2 AND expires_at <= now()`,
      [idempKey, session.userId]
    );

    // Reserve the slot. ON CONFLICT DO NOTHING: only one concurrent request wins.
    const reserve = await client.query(
      `INSERT INTO idempotency_keys (key, user_id, org_id, status, body)
       VALUES ($1,$2,$3,0,'null'::jsonb)
       ON CONFLICT (key, user_id) DO NOTHING`,
      [idempKey, session.userId, orgId]
    );

    if ((reserve.rowCount ?? 0) === 0) {
      // A non-expired slot exists. Read it before rolling back the transaction.
      const { rows: existing } = await client.query<{ status: number; body: unknown }>(
        `SELECT status, body FROM idempotency_keys WHERE key = $1 AND user_id = $2`,
        [idempKey, session.userId]
      );
      await client.query('ROLLBACK');

      if (existing.length === 0 || existing[0].status === 0) {
        // Another in-flight transaction holds the slot (uncommitted, so invisible
        // to our SELECT) or just committed a status=0 row — both mean in-progress.
        res.status(409).json({ code: 'IDEMPOTENCY_IN_PROGRESS', error: 'A request with this Idempotency-Key is already in progress. Please retry shortly.' });
        return;
      }
      // Completed response — replay it.
      res.status(existing[0].status as number).json(existing[0].body);
      return;
    }

    // We own the slot. All remaining work is inside the same transaction so any
    // failure triggers a ROLLBACK that also removes the slot, keeping the key free.
    const { personId, warnings } = await resolvePatientPersonId(client as QueryRunner, orgId, meta);

    await client.query(
      `INSERT INTO patient_records
         (id, organization_id, patient_person_id, owner_user_id, name, patient_no,
          birth_date, injury_date, evaluation_date, active_modules, diagnoses_codes,
          jobs_names, revision, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13)`,
      [
        patientId, orgId, personId, session.userId,
        meta.name, meta.patientNo,
        meta.birthDate, meta.injuryDate, meta.evaluationDate,
        meta.activeModules, meta.diagnosesCodes, meta.jobsNames,
        JSON.stringify(fullPayload),
      ]
    );

    const { rows: newRows } = await client.query<PatientRow>(
      `SELECT ${SELECT_COLS} FROM patient_records WHERE id = $1`,
      [patientId]
    );

    const body = toResponse(newRows[0], warnings);

    await client.query(
      `UPDATE idempotency_keys SET status = $3, body = $4
       WHERE key = $1 AND user_id = $2`,
      [idempKey, session.userId, 201, JSON.stringify(body)]
    );

    await client.query('COMMIT');
    res.status(201).json(body);
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PatientIdentityConflictError) {
      res.status(409).json(identityConflictResponse());
      return;
    }
    if (isUniqueViolation(err)) {
      res.status(409).json(uniqueConflictResponse(err));
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/patients/:id
// Requires If-Match: <revision> header. Returns 409 on mismatch.
// ---------------------------------------------------------------------------
async function patchPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  const { id }  = req.params;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const ifMatch = req.headers['if-match'];
  if (!ifMatch) {
    res.status(400).json({ code: 'IF_MATCH_REQUIRED', error: 'If-Match header with current revision is required' });
    return;
  }
  const expectedRevision = parsePositiveInt(ifMatch);
  if (expectedRevision === null) {
    res.status(400).json({ code: 'INVALID_IF_MATCH', error: 'If-Match must be a positive integer revision' });
    return;
  }

  const parse = PatchBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: current } = await client.query<PatientRow>(
      `SELECT ${SELECT_COLS}
       FROM patient_records
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [id, orgId]
    );

    if (current.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }

    if (current[0].revision !== expectedRevision) {
      await client.query('ROLLBACK');
      res.status(409).json({
        code:            'CONFLICT',
        error:           'Revision mismatch. Fetch the latest version before retrying.',
        currentRevision: current[0].revision,
      });
      return;
    }

    const { phase, data } = parse.data;

    const existingPayload = typeof current[0].payload === 'object' && current[0].payload !== null
      ? (current[0].payload as Record<string, unknown>) : {};

    const newPayload: Record<string, unknown> = {
      ...existingPayload,
      ...(phase !== undefined ? { phase }  : {}),
      ...(data  !== undefined ? { data }   : {}),
    };

    const mergedData = typeof newPayload['data'] === 'object' && newPayload['data'] !== null
      ? (newPayload['data'] as Record<string, unknown>) : {};
    const meta = extractMeta(mergedData);

    if (!meta.name) {
      await client.query('ROLLBACK');
      res.status(400).json({ code: 'NAME_REQUIRED', error: 'Patient name (data.shared.name) is required' });
      return;
    }

    const { personId, warnings } = await resolvePatientPersonId(client as QueryRunner, orgId, meta, current[0].patient_person_id);

    // WHERE clause includes revision to catch concurrent modification between read and write.
    const { rows: updated } = await client.query<PatientRow>(
      `UPDATE patient_records SET
         patient_person_id = $3,
         name              = $4,
         patient_no        = $5,
         birth_date        = $6,
         injury_date       = $7,
         evaluation_date   = $8,
         active_modules    = $9,
         diagnoses_codes   = $10,
         jobs_names        = $11,
         revision          = revision + 1,
         payload           = $12
       WHERE id = $1 AND organization_id = $2 AND revision = $13 AND deleted_at IS NULL
       RETURNING ${SELECT_COLS}`,
      [
        id, orgId, personId,
        meta.name, meta.patientNo,
        meta.birthDate, meta.injuryDate, meta.evaluationDate,
        meta.activeModules, meta.diagnosesCodes, meta.jobsNames,
        JSON.stringify(newPayload),
        expectedRevision,
      ]
    );

    if (updated.length === 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        code:  'CONFLICT',
        error: 'Concurrent modification detected. Please retry.',
      });
      return;
    }

    await client.query('COMMIT');
    res.status(200).json(toResponse(updated[0], warnings));
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PatientIdentityConflictError) {
      res.status(409).json(identityConflictResponse());
      return;
    }
    if (isUniqueViolation(err)) {
      res.status(409).json(uniqueConflictResponse(err));
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/patients/:id?revision=N
// Soft-delete (sets deleted_at). Within the same transaction, redacts the
// deleted patient's PHI from every workspace snapshot in this org so that
// { id, redacted: true } stubs remain without exposing name/birth_date/etc.
// Returns 409 on revision mismatch.
// ---------------------------------------------------------------------------
async function deletePatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  const { id }  = req.params;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const revParam = req.query['revision'];
  if (!revParam) {
    res.status(400).json({ code: 'REVISION_REQUIRED', error: 'revision query parameter is required' });
    return;
  }
  const revision = parsePositiveInt(revParam);
  if (revision === null) {
    res.status(400).json({ code: 'INVALID_REVISION', error: 'revision must be a positive integer' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE patient_records
       SET deleted_at = now()
       WHERE id = $1 AND organization_id = $2 AND revision = $3 AND deleted_at IS NULL`,
      [id, orgId, revision]
    );

    if ((result.rowCount ?? 0) === 0) {
      const { rows } = await client.query<{ revision: number; deleted_at: Date | null }>(
        `SELECT revision, deleted_at FROM patient_records
         WHERE id = $1 AND organization_id = $2`,
        [id, orgId]
      );
      await client.query('ROLLBACK');
      if (rows.length === 0 || rows[0].deleted_at !== null) {
        res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      } else {
        res.status(409).json({
          code:            'CONFLICT',
          error:           'Revision mismatch.',
          currentRevision: rows[0].revision,
        });
      }
      return;
    }

    // Redact deleted patient's PHI from workspace snapshots in this org.
    // Intentionally does NOT filter by patient_ids: legacy/migration-incomplete
    // workspaces may have patient data in snapshot_payload but an empty or
    // stale patient_ids array. The EXISTS sub-query scans jsonb content directly
    // so that PHI is removed regardless of patient_ids correctness.
    await client.query(
      `UPDATE workspaces
       SET snapshot_payload = (
         SELECT jsonb_agg(
           CASE
             WHEN (p->>'id') = $2 OR (p->'sync'->>'serverId') = $2
             THEN jsonb_build_object('id', $2, 'redacted', true)
             ELSE p
           END
         )
         FROM jsonb_array_elements(snapshot_payload) AS p
       )
       WHERE organization_id = $1
         AND jsonb_typeof(snapshot_payload) = 'array'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(snapshot_payload) AS p
           WHERE (p->>'id') = $2 OR (p->'sync'->>'serverId') = $2
         )`,
      [orgId, id]
    );

    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

export function createPatientsRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);
  const audit  = (action: string) =>
    auditMiddleware(pool, action, 'patient', (req) => req.params.id ?? null);

  router.get(
    '/',
    auth, audit('patient_list'),
    (req, res) => listPatients(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.get(
    '/:id',
    auth, audit('patient_read'),
    (req, res) => getPatient(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/',
    auth, csrfMiddleware, audit('patient_create'),
    (req, res) => createPatient(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.patch(
    '/:id',
    auth, csrfMiddleware, audit('patient_update'),
    (req, res) => patchPatient(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.delete(
    '/:id',
    auth, csrfMiddleware, audit('patient_delete'),
    (req, res) => deletePatient(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  return router;
}

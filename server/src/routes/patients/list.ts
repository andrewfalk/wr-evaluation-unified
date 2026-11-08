// GET /api/patients and /api/patients/doctor-counts — list scopes.
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { orgIdOf, sessionOf } from '../../http/authz';
import { PatientRow, SELECT_COLS } from './schemas';
import { toResponse } from './shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ListScope = 'all' | 'mine' | 'unassigned' | 'invalid' | { doctorId: string };

// Resolve the ?scope= query param to a strict, validated scope.
// A specific doctorId is accepted only when that user actually owns patients in the
// organisation — this keeps the roster (GET /doctor-counts) and selectable scopes
// consistent, including inactive/former doctors who still have assigned patients.
async function resolveListScope(
  pool: Pool,
  orgId: string,
  session: { role: string; userId: string },
  requested: unknown
): Promise<ListScope> {
  const rs = typeof requested === 'string' ? requested : '';
  if (rs === '')            return session.role === 'doctor' ? 'mine' : 'all';
  if (rs === 'all')         return 'all';
  if (rs === 'mine')        return 'mine';
  if (rs === '__unassigned__') return 'unassigned';
  // Anything else must look like a userId AND own patients in this org, else invalid.
  if (!UUID_RE.test(rs)) return 'invalid';
  const { rows } = await pool.query(
    `SELECT 1 FROM patient_records
     WHERE organization_id = $1 AND deleted_at IS NULL AND assigned_doctor_user_id = $2
     LIMIT 1`,
    [orgId, rs]
  );
  return rows.length > 0 ? { doctorId: rs } : 'invalid';
}

// ---------------------------------------------------------------------------
// GET /api/patients/doctor-counts
// Lightweight per-doctor patient-count roster for the dashboard scope dropdown.
// Returns only { userId, name, count } + unassignedCount — no PHI / payloads.
// ---------------------------------------------------------------------------
export async function getDoctorCounts(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId   = orgIdOf(req);

  const { rows } = await pool.query<{ user_id: string | null; name: string | null; count: number }>(
    `SELECT pr.assigned_doctor_user_id AS user_id, u.name AS name, COUNT(*)::int AS count
     FROM patient_records pr
     LEFT JOIN users u
       ON u.id = pr.assigned_doctor_user_id
      AND u.organization_id = pr.organization_id
     WHERE pr.organization_id = $1 AND pr.deleted_at IS NULL
     GROUP BY pr.assigned_doctor_user_id, u.name`,
    [orgId]
  );

  let unassignedCount = 0;
  const doctors: { userId: string; name: string | null; count: number }[] = [];
  for (const row of rows) {
    const count = Number(row.count);
    if (row.user_id === null) {
      unassignedCount += count;
      continue;
    }
    doctors.push({ userId: row.user_id, name: row.name ?? null, count });
  }
  doctors.sort((a, b) => b.count - a.count);

  res.status(200).json({ doctors, unassignedCount });
}

// ---------------------------------------------------------------------------
// GET /api/patients
// Supports: q (name/patientNo ILIKE), diagnosesCode, jobName, module,
//           limit (default 20, max 100), offset (default 0).
// ---------------------------------------------------------------------------
export async function listPatients(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);

  const q            = typeof req.query['q']            === 'string' ? req.query['q'].trim()            : '';
  const diagCode     = typeof req.query['diagnosesCode'] === 'string' ? req.query['diagnosesCode'].trim() : '';
  const jobName      = typeof req.query['jobName']       === 'string' ? req.query['jobName'].trim()       : '';
  const moduleFilter = typeof req.query['module']        === 'string' ? req.query['module'].trim()        : '';
  // Resolve the requested scope with strict validation. Invalid/unknown scopes must
  // NOT silently fall back to 'all' — they resolve to an empty result set instead.
  // Allowed: 'all' | 'mine' | '__unassigned__' | a valid org doctor userId.
  const scope = await resolveListScope(pool, orgId, session, req.query['scope']);

  const rawLimit  = Number(req.query['limit']  ?? 20);
  const rawOffset = Number(req.query['offset'] ?? 0);
  const limit     = !isFinite(rawLimit)  || rawLimit  < 1 ? 20 : Math.min(rawLimit,  100);
  const offset    = !isFinite(rawOffset) || rawOffset < 0 ? 0  : rawOffset;

  const filterParams: unknown[] = [orgId];
  const conditions: string[] = ['organization_id = $1', 'deleted_at IS NULL'];

  // scope filter:
  //  - 'all'          → no extra condition (whole organisation)
  //  - 'mine'         → assigned to the current user
  //  - 'unassigned'   → no assigned doctor
  //  - { doctorId }   → assigned to a specific (validated) doctor
  //  - 'invalid'      → match nothing (never falls back to 'all')
  if (scope === 'mine') {
    filterParams.push(session.userId);
    conditions.push(`assigned_doctor_user_id = $${filterParams.length}`);
  } else if (scope === 'unassigned') {
    conditions.push('assigned_doctor_user_id IS NULL');
  } else if (typeof scope === 'object') {
    filterParams.push(scope.doctorId);
    conditions.push(`assigned_doctor_user_id = $${filterParams.length}`);
  } else if (scope === 'invalid') {
    conditions.push('FALSE');
  }

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

  const [{ rows }, { rows: countRows }, { rows: unassignedRows }, { rows: orgRows }] = await Promise.all([
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
    pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM patient_records
       WHERE organization_id = $1 AND deleted_at IS NULL AND assigned_doctor_user_id IS NULL`,
      [orgId]
    ),
    pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM patient_records
       WHERE organization_id = $1 AND deleted_at IS NULL`,
      [orgId]
    ),
  ]);

  res.status(200).json({
    items:           rows.map((row) => toResponse(row)),
    total:           parseInt(countRows[0]?.total    ?? '0', 10),
    unassignedCount: parseInt(unassignedRows[0]?.total ?? '0', 10),
    orgPatientCount: parseInt(orgRows[0]?.total       ?? '0', 10),
    limit,
    offset,
  });
}

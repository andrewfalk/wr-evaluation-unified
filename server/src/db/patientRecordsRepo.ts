// The only place that writes patient_records (REFACTORING_ROADMAP S7). S7-1…7 moved each write path's SQL
// here verbatim; S7-8a merged the copies: one visibility predicate, one row shape (SELECT_COLS), one INSERT,
// one payload UPDATE.
//
// Every function runs on the caller's transaction (`db` is its client) and takes no other lock than its own
// statement's. The locking order is the caller's: see the S7 plan §3 (domain/patients/*).
import type { QueryRunner } from './queryRunner';
import type { CompletionColumns, VerificationColumns } from '../completionTracking';

/**
 * A live patient of the organization — `$1` the patient id, `$2` the organization id. The one copy of the
 * predicate the patient routes, the lock anchor and the write paths use for "this patient, if it exists for
 * the caller".
 */
export const VISIBLE_BY_ID = `id = $1 AND organization_id = $2 AND deleted_at IS NULL`;

export interface PatientRow {
  id:                      string;
  organization_id:         string;
  patient_person_id:       string;
  owner_user_id:           string;
  assigned_doctor_user_id: string | null;
  name:                    string;
  patient_no:              string | null;
  birth_date:              string | null;
  injury_date:             string | null;
  evaluation_date:         string | null;
  active_modules:          string[];
  diagnoses_codes:         string[];
  jobs_names:              string[];
  revision:                number;
  created_at:              Date;
  updated_at:              Date;
  payload:                 unknown;
  completion_status:                    string;
  server_observed_modules_complete_at:  Date | null;
  completion_source:                    string | null;
  completion_client_build_version:      string | null;
  completion_client_schema_version:     number | null;
  server_verified_modules_complete_at:    Date | null;
  completion_verification_engine_version: string | null;
}

export const SELECT_COLS = `
  id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
  name, patient_no, birth_date, injury_date, evaluation_date, active_modules,
  diagnoses_codes, jobs_names, revision, created_at, updated_at, payload,
  completion_status, server_observed_modules_complete_at, completion_source,
  completion_client_build_version, completion_client_schema_version,
  server_verified_modules_complete_at, completion_verification_engine_version`;

/** A row read whether or not it is soft-deleted. */
export type PatientRowAnyState = PatientRow & { deleted_at: Date | null };

// ---------------------------------------------------------------------------------------------------
// Reads and locks
// ---------------------------------------------------------------------------------------------------

/**
 * The lock anchor of every patient write and lease-lock transaction: the live patient's row FOR UPDATE, so
 * that later checks of patient_locks in the same transaction see the latest committed state. Or none.
 */
export async function lockAnchor(
  db: QueryRunner, id: string, orgId: string,
): Promise<{ id: string; assigned_doctor_user_id: string | null } | undefined> {
  const { rows } = await db.query<{ id: string; assigned_doctor_user_id: string | null }>(
    `SELECT id, assigned_doctor_user_id FROM patient_records
     WHERE ${VISIBLE_BY_ID} FOR UPDATE`,
    [id, orgId]
  );
  return rows[0];
}

/** The live patient's full row FOR UPDATE (PATCH and the video apply take it as their anchor) — or none. */
export async function lockLive(db: QueryRunner, id: string, orgId: string): Promise<PatientRow | undefined> {
  const { rows } = await db.query<PatientRow>(
    `SELECT ${SELECT_COLS}
     FROM patient_records
     WHERE ${VISIBLE_BY_ID}
     FOR UPDATE`,
    [id, orgId]
  );
  return rows[0];
}

/**
 * The patient's row in the organization, deleted or not, FOR UPDATE — or none. The workspace save takes it
 * under its per-id advisory lock; a soft-deleted row is returned too (the caller skips it).
 */
export async function lockAnyState(db: QueryRunner, id: string, orgId: string): Promise<PatientRowAnyState | undefined> {
  const { rows } = await db.query<PatientRowAnyState>(
    `SELECT ${SELECT_COLS}, deleted_at
     FROM patient_records
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [id, orgId]
  );
  return rows[0];
}

/**
 * The patient's row in the organization, deleted or not, not locked — or none. The idempotent replay of a
 * video apply answers with it; a delete that matched no row tells "gone" from "revision moved" with it.
 */
export async function selectAnyState(db: QueryRunner, id: string, orgId: string): Promise<PatientRowAnyState | undefined> {
  const { rows } = await db.query<PatientRowAnyState>(
    `SELECT ${SELECT_COLS}, deleted_at
     FROM patient_records
     WHERE id = $1 AND organization_id = $2`,
    [id, orgId]
  );
  return rows[0];
}

/** The patient's full row by id (no organization or deleted_at filter — the caller just wrote it). */
export async function selectById(db: QueryRunner, id: string): Promise<PatientRow | undefined> {
  const { rows } = await db.query<PatientRow>(
    `SELECT ${SELECT_COLS} FROM patient_records WHERE id = $1`,
    [id]
  );
  return rows[0];
}

/** The live patient's assigned doctor and that doctor's name (not locked) — or none. */
export async function selectPreviousDoctor(
  db: QueryRunner, id: string, orgId: string,
): Promise<{ assigned_doctor_user_id: string | null; previous_doctor_name: string | null } | undefined> {
  const { rows } = await db.query<{ assigned_doctor_user_id: string | null; previous_doctor_name: string | null }>(
    `SELECT pr.assigned_doctor_user_id, u.name AS previous_doctor_name
     FROM (SELECT assigned_doctor_user_id FROM patient_records WHERE ${VISIBLE_BY_ID}) pr
     LEFT JOIN users u ON u.id = pr.assigned_doctor_user_id`,
    [id, orgId]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------------

/** The meta columns copied out of the payload (name, number, dates, module/diagnosis/job lists). */
export interface PatientMetaColumns {
  personId: string;
  name: string;
  patientNo: string | null;
  birthDate: string | null;
  injuryDate: string | null;
  evaluationDate: string | null;
  activeModules: string[];
  diagnosesCodes: string[];
  jobsNames: string[];
}

export interface InsertPatient {
  id: string;
  orgId: string;
  ownerUserId: string;
  assignedDoctorUserId: string | null;
  meta: PatientMetaColumns;
  payloadJson: string;
  completion: CompletionColumns;
  verification: VerificationColumns;
}

/**
 * A new patient at revision 1. No ON CONFLICT: an id that exists (live or deleted) fails with 23505 — the
 * caller answers 409 or reports skipped(error), never overwrites without the authorization check.
 */
export async function insertPatient(db: QueryRunner, w: InsertPatient): Promise<PatientRow> {
  const { meta } = w;
  const { rows } = await db.query<PatientRow>(
    `INSERT INTO patient_records
       (id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
        name, patient_no, birth_date, injury_date, evaluation_date,
        active_modules, diagnoses_codes, jobs_names, revision, payload,
        completion_status, server_observed_modules_complete_at, completion_source,
        completion_client_build_version, completion_client_schema_version,
        server_verified_modules_complete_at, completion_verification_engine_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING ${SELECT_COLS}`,
    [
      w.id, w.orgId, meta.personId, w.ownerUserId, w.assignedDoctorUserId,
      meta.name, meta.patientNo, meta.birthDate, meta.injuryDate, meta.evaluationDate,
      meta.activeModules, meta.diagnosesCodes, meta.jobsNames, w.payloadJson,
      w.completion.completion_status, w.completion.server_observed_modules_complete_at, w.completion.completion_source,
      w.completion.completion_client_build_version, w.completion.completion_client_schema_version,
      w.verification.server_verified_modules_complete_at, w.verification.completion_verification_engine_version,
    ]
  );
  return rows[0];
}

export interface UpdatePayload {
  id: string;
  orgId: string;
  /** The revision the caller checked; no row when it moved on (or the patient is gone). */
  expectedRevision: number;
  payloadJson: string;
  completion: CompletionColumns;
  verification: VerificationColumns;
  /** Also rewrite the meta columns (PATCH, workspace save). The video apply leaves them as they are. */
  meta?: PatientMetaColumns;
  /**
   * Workspace save only: assign this doctor when the patient has none (`COALESCE(assigned_doctor_user_id, …)`).
   * Omitted, the assigned doctor is not touched.
   */
  assignIfUnassigned?: string | null;
}

/**
 * The payload write of PATCH, the video apply and the workspace save: payload, completion columns and
 * (optionally) the meta columns, revision + 1, while the live patient is still at `expectedRevision`.
 *
 * completion_status is the current state and is overwritten. The completion provenance columns (observed
 * time, source, client versions, verification time, engine version) keep their first value — COALESCE
 * keeps the stored one, so a microsecond `now()` value is not replaced by a millisecond JS Date.
 * nextCompletionColumns / nextVerificationColumns only produce new values while the stored ones are null.
 */
export async function updatePayload(db: QueryRunner, w: UpdatePayload): Promise<PatientRow | undefined> {
  const params: unknown[] = [
    w.id, w.orgId, w.expectedRevision, w.payloadJson,
    w.completion.completion_status,
    w.completion.server_observed_modules_complete_at,
    w.completion.completion_source,
    w.completion.completion_client_build_version,
    w.completion.completion_client_schema_version,
    w.verification.server_verified_modules_complete_at,
    w.verification.completion_verification_engine_version,
  ];
  const sets = [
    `revision = revision + 1`,
    `payload = $4`,
    `completion_status = $5`,
    `server_observed_modules_complete_at = COALESCE(server_observed_modules_complete_at, $6)`,
    `completion_source = COALESCE(completion_source, $7)`,
    `completion_client_build_version = COALESCE(completion_client_build_version, $8)`,
    `completion_client_schema_version = COALESCE(completion_client_schema_version, $9)`,
    `server_verified_modules_complete_at = COALESCE(server_verified_modules_complete_at, $10)`,
    `completion_verification_engine_version = COALESCE(completion_verification_engine_version, $11)`,
  ];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (w.meta) {
    const m = w.meta;
    sets.push(
      `patient_person_id = ${bind(m.personId)}`,
      `name = ${bind(m.name)}`,
      `patient_no = ${bind(m.patientNo)}`,
      `birth_date = ${bind(m.birthDate)}`,
      `injury_date = ${bind(m.injuryDate)}`,
      `evaluation_date = ${bind(m.evaluationDate)}`,
      `active_modules = ${bind(m.activeModules)}`,
      `diagnoses_codes = ${bind(m.diagnosesCodes)}`,
      `jobs_names = ${bind(m.jobsNames)}`,
    );
  }
  if (w.assignIfUnassigned !== undefined) {
    sets.push(`assigned_doctor_user_id = COALESCE(assigned_doctor_user_id, ${bind(w.assignIfUnassigned)})`);
  }
  const { rows } = await db.query<PatientRow>(
    `UPDATE patient_records SET
       ${sets.join(',\n       ')}
     WHERE ${VISIBLE_BY_ID} AND revision = $3
     RETURNING ${SELECT_COLS}`,
    params
  );
  return rows[0];
}

/**
 * Soft delete at `revision` (the revision is not bumped). `rowCount` 0 when the revision moved on or the
 * patient is already gone (the caller tells them apart); `personId` is the deleted case's person.
 */
export async function softDelete(
  db: QueryRunner, id: string, orgId: string, revision: number,
): Promise<{ rowCount: number; personId: string | null | undefined }> {
  const result = await db.query<{ patient_person_id: string | null }>(
    `UPDATE patient_records
     SET deleted_at = now()
     WHERE ${VISIBLE_BY_ID} AND revision = $3
     RETURNING patient_person_id`,
    [id, orgId, revision]
  );
  return { rowCount: result.rowCount ?? 0, personId: result.rows[0]?.patient_person_id };
}

/**
 * Assigned doctor (and payload data.shared.doctorName) of a live patient, revision + 1. No revision
 * condition — an administrative change. None when the patient is gone.
 */
export async function setAssignment(
  db: QueryRunner, w: { id: string; orgId: string; assignedUserId: string | null; doctorName: string },
): Promise<{ id: string; revision: number } | undefined> {
  const { rows } = await db.query<{ id: string; revision: number }>(
    `UPDATE patient_records
     SET assigned_doctor_user_id = $3,
         payload  = jsonb_set(payload, '{data,shared,doctorName}', to_jsonb($4::text), true),
         revision = revision + 1
     WHERE ${VISIBLE_BY_ID}
     RETURNING id, revision`,
    [w.id, w.orgId, w.assignedUserId, w.doctorName]
  );
  return rows[0];
}

/**
 * Birth date (column and payload data.shared.birthDate) of every live case of the person, revision + 1 —
 * else another client would write the old payload back at the old revision. The ids of the updated cases.
 */
export async function correctBirthDateForPerson(
  db: QueryRunner, personId: string, orgId: string, birthDate: string,
): Promise<string[]> {
  const updated = await db.query<{ id: string }>(
    `UPDATE patient_records
     SET birth_date = $3::date,
         payload    = jsonb_set(payload, '{data,shared,birthDate}', to_jsonb($3::text), true),
         revision   = revision + 1
     WHERE patient_person_id = $1 AND organization_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [personId, orgId, birthDate]
  );
  return updated.rows.map(r => r.id);
}

// ---------------------------------------------------------------------------------------------------
// Reads outside a transaction (S7-8b — the copies of the visibility predicate in the routes)
// ---------------------------------------------------------------------------------------------------

/** The live patient's full row (GET /api/patients/:id) — or none. */
export async function selectLive(db: QueryRunner, id: string, orgId: string): Promise<PatientRow | undefined> {
  const { rows } = await db.query<PatientRow>(
    `SELECT ${SELECT_COLS}
     FROM patient_records
     WHERE ${VISIBLE_BY_ID}`,
    [id, orgId]
  );
  return rows[0];
}

/**
 * The live patient's assigned doctor, not locked — the access checks before a transaction
 * (requirePatientAccess, the video analysis patient check). Or none.
 */
export async function selectAssignment(
  db: QueryRunner, id: string, orgId: string,
): Promise<{ id: string; assigned_doctor_user_id: string | null } | undefined> {
  const { rows } = await db.query<{ id: string; assigned_doctor_user_id: string | null }>(
    `SELECT id, assigned_doctor_user_id FROM patient_records
     WHERE ${VISIBLE_BY_ID}`,
    [id, orgId]
  );
  return rows[0];
}

// The only place that writes patient_records (REFACTORING_ROADMAP S7). While S7 moves the write paths here
// one PR at a time, each function is the moved SQL verbatim — same text, same parameters, same order — so
// the order-based route tests keep passing; S7-8a merges the copies.
//
// Every function runs on the caller's transaction (`db` is its client). Locking order is the caller's:
// see the S7 plan §3.
import type { QueryRunner } from './queryRunner';
import type { CompletionColumns, VerificationColumns } from '../completionTracking';

// ---------------------------------------------------------------------------------------------------
// Workspace save (S7-1, from routes/workspaces/upsert.ts)
// ---------------------------------------------------------------------------------------------------

export type SnapshotExistingRow =
  { patient_person_id: string | null; deleted_at: Date | null; revision: number; assigned_doctor_user_id: string | null }
    & CompletionColumns & VerificationColumns;

/**
 * The patient's row in the organization, deleted or not, locked FOR UPDATE — or none. The workspace save
 * takes it under its per-id advisory lock; a soft-deleted row is returned too (the caller skips it).
 */
export async function lockAnyStateForUpdate(db: QueryRunner, id: string, orgId: string): Promise<SnapshotExistingRow | undefined> {
  const existing = await db.query<SnapshotExistingRow>(
    `SELECT patient_person_id, deleted_at, revision, assigned_doctor_user_id,
            completion_status, server_observed_modules_complete_at, completion_source,
            completion_client_build_version, completion_client_schema_version,
            server_verified_modules_complete_at, completion_verification_engine_version
     FROM patient_records
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [id, orgId]
  );
  return existing.rows[0];
}

/** Columns the workspace save writes (both its UPDATE and its INSERT). */
export interface SnapshotWrite {
  id: string;
  orgId: string;
  personId: string;
  name: string;
  patientNo: string | null;
  birthDate: string | null;
  injuryDate: string | null;
  evaluationDate: string | null;
  activeModules: string[];
  diagnosesCodes: string[];
  jobsNames: string[];
  assignedDoctorUserId: string | null;
  payloadJson: string;
  /** completion_status, observed_at, source, build version, schema version, verified_at, engine version. */
  completionTail: unknown[];
}

export interface SnapshotWritten {
  revision: number;
  assigned_doctor_user_id: string | null;
}

/**
 * UPDATE from a workspace save. Only when the revision is still `expectedRevision` (else no row: the
 * caller reports a conflict). The assigned doctor is kept when set; the completion provenance columns
 * keep their first value (COALESCE); the owner does not change.
 */
export async function updateFromSnapshot(db: QueryRunner, w: SnapshotWrite, expectedRevision: number): Promise<SnapshotWritten | undefined> {
  const updated = await db.query<SnapshotWritten>(
    `UPDATE patient_records SET
         patient_person_id       = $3,
         name                    = $4,
         patient_no              = $5,
         birth_date              = $6,
         injury_date             = $7,
         evaluation_date         = $8,
         active_modules          = $9,
         diagnoses_codes         = $10,
         jobs_names              = $11,
         assigned_doctor_user_id = COALESCE(assigned_doctor_user_id, $12),
         revision                = revision + 1,
         payload                 = $13,
         completion_status                   = $14,
         server_observed_modules_complete_at = COALESCE(server_observed_modules_complete_at, $15),
         completion_source                   = COALESCE(completion_source, $16),
         completion_client_build_version     = COALESCE(completion_client_build_version, $17),
         completion_client_schema_version    = COALESCE(completion_client_schema_version, $18),
         server_verified_modules_complete_at    = COALESCE(server_verified_modules_complete_at, $19),
         completion_verification_engine_version = COALESCE(completion_verification_engine_version, $20)
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND revision = $21
       RETURNING revision, assigned_doctor_user_id`,
    [
      w.id, w.orgId, w.personId, w.name, w.patientNo, w.birthDate, w.injuryDate, w.evaluationDate,
      w.activeModules, w.diagnosesCodes, w.jobsNames, w.assignedDoctorUserId, w.payloadJson,
      ...w.completionTail, expectedRevision,
    ]
  );
  return updated.rows[0];
}

/**
 * INSERT from a workspace save, revision 1, owned by `ownerUserId`. No ON CONFLICT: the same id created
 * meanwhile by another path fails with 23505 (the caller reports it as skipped(error)) instead of being
 * overwritten without the authorization check.
 */
export async function insertFromSnapshot(db: QueryRunner, w: SnapshotWrite, ownerUserId: string): Promise<SnapshotWritten> {
  const inserted = await db.query<SnapshotWritten>(
    `INSERT INTO patient_records
         (id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
          name, patient_no, birth_date, injury_date, evaluation_date,
          active_modules, diagnoses_codes, jobs_names, revision, payload,
          completion_status, server_observed_modules_complete_at, completion_source,
          completion_client_build_version, completion_client_schema_version,
          server_verified_modules_complete_at, completion_verification_engine_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING revision, assigned_doctor_user_id`,
    [
      w.id, w.orgId, w.personId, ownerUserId, w.assignedDoctorUserId, w.name, w.patientNo,
      w.birthDate, w.injuryDate, w.evaluationDate,
      w.activeModules, w.diagnosesCodes, w.jobsNames, w.payloadJson,
      ...w.completionTail,
    ]
  );
  return inserted.rows[0];
}

// ---------------------------------------------------------------------------------------------------
// Video analysis apply (S7-2, from routes/videoAnalysis/apply.ts)
// ---------------------------------------------------------------------------------------------------

/** The patient columns the video apply reads back and answers with. */
export interface ApplyPatientRow extends CompletionColumns, VerificationColumns {
  id: string; revision: number; payload: unknown; created_at: Date; updated_at: Date;
}

/**
 * The patient as stored, for answering an idempotent replay of an apply. Not locked and not filtered on
 * deleted_at (the replay answers what was applied).
 */
export async function selectForIdempotentApply(db: QueryRunner, id: string, orgId: string): Promise<ApplyPatientRow | undefined> {
  const { rows: cur } = await db.query<ApplyPatientRow>(
    `SELECT id, revision, payload, created_at, updated_at,
                completion_status, server_observed_modules_complete_at, completion_source,
                completion_client_build_version, completion_client_schema_version,
                server_verified_modules_complete_at, completion_verification_engine_version
         FROM patient_records
         WHERE id = $1 AND organization_id = $2`,
    [id, orgId]
  );
  return cur[0];
}

/** The live (not deleted) patient locked FOR UPDATE for an apply, with its assigned doctor — or none. */
export async function lockForApply(
  db: QueryRunner, id: string, orgId: string,
): Promise<(ApplyPatientRow & { assigned_doctor_user_id: string | null }) | undefined> {
  const { rows: pats } = await db.query<ApplyPatientRow & { assigned_doctor_user_id: string | null }>(
    `SELECT id, revision, payload, created_at, updated_at, assigned_doctor_user_id,
              completion_status, server_observed_modules_complete_at, completion_source,
              completion_client_build_version, completion_client_schema_version,
              server_verified_modules_complete_at, completion_verification_engine_version
       FROM patient_records
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
    [id, orgId]
  );
  return pats[0];
}

export interface VideoApplyWrite {
  id: string;
  orgId: string;
  payloadJson: string;
  expectedRevision: number;
  completion: CompletionColumns;
  verification: VerificationColumns;
}

/**
 * Payload and completion columns from a video apply, revision + 1 — only while the revision is still
 * `expectedRevision` and the patient is not deleted (else no row). The meta columns do not change.
 */
export async function updateFromVideoApply(db: QueryRunner, w: VideoApplyWrite): Promise<ApplyPatientRow | undefined> {
  const { rows: updated } = await db.query<ApplyPatientRow>(
    `UPDATE patient_records SET
         payload = $3, revision = revision + 1,
         completion_status                   = $5,
         server_observed_modules_complete_at = $6,
         completion_source                   = $7,
         completion_client_build_version     = $8,
         completion_client_schema_version    = $9,
         server_verified_modules_complete_at    = $10,
         completion_verification_engine_version = $11
       WHERE id = $1 AND organization_id = $2 AND revision = $4 AND deleted_at IS NULL
       RETURNING id, revision, payload, created_at, updated_at,
                 completion_status, server_observed_modules_complete_at, completion_source,
                 completion_client_build_version, completion_client_schema_version,
                 server_verified_modules_complete_at, completion_verification_engine_version`,
    [
      w.id, w.orgId, w.payloadJson, w.expectedRevision,
      w.completion.completion_status,
      w.completion.server_observed_modules_complete_at,
      w.completion.completion_source,
      w.completion.completion_client_build_version,
      w.completion.completion_client_schema_version,
      w.verification.server_verified_modules_complete_at,
      w.verification.completion_verification_engine_version,
    ]
  );
  return updated[0];
}

// ---------------------------------------------------------------------------------------------------
// Patient create (S7-3, from routes/patients/create.ts). PatientRow and SELECT_COLS moved here from
// routes/patients/schemas.ts, which re-exports them.
// ---------------------------------------------------------------------------------------------------

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

export interface CreateWrite {
  id: string;
  orgId: string;
  personId: string;
  ownerUserId: string;
  assignedDoctorUserId: string | null;
  meta: {
    name: string; patientNo: string | null; birthDate: string | null; injuryDate: string | null; evaluationDate: string | null;
    activeModules: string[]; diagnosesCodes: string[]; jobsNames: string[];
  };
  payloadJson: string;
  completion: CompletionColumns;
  verification: VerificationColumns;
}

/** INSERT of a new patient, revision 1. No ON CONFLICT: an existing id fails with 23505. */
export async function insertFromCreate(db: QueryRunner, w: CreateWrite): Promise<void> {
  const { meta } = w;
  await db.query(
      `INSERT INTO patient_records
         (id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
          name, patient_no, birth_date, injury_date, evaluation_date,
          active_modules, diagnoses_codes, jobs_names, revision, payload,
          completion_status, server_observed_modules_complete_at, completion_source,
          completion_client_build_version, completion_client_schema_version,
          server_verified_modules_complete_at, completion_verification_engine_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      w.id, w.orgId, w.personId, w.ownerUserId, w.assignedDoctorUserId,
      meta.name, meta.patientNo,
      meta.birthDate, meta.injuryDate, meta.evaluationDate,
      meta.activeModules, meta.diagnosesCodes, meta.jobsNames,
      w.payloadJson,
      w.completion.completion_status, w.completion.server_observed_modules_complete_at, w.completion.completion_source,
      w.completion.completion_client_build_version, w.completion.completion_client_schema_version,
      w.verification.server_verified_modules_complete_at, w.verification.completion_verification_engine_version,
    ]
  );
}

/** The patient's full row by id (no organization or deleted_at filter — the caller just wrote it). */
export async function selectById(db: QueryRunner, id: string): Promise<PatientRow | undefined> {
  const { rows: newRows } = await db.query<PatientRow>(
      `SELECT ${SELECT_COLS} FROM patient_records WHERE id = $1`,
      [id]
  );
  return newRows[0];
}

// ---------------------------------------------------------------------------------------------------
// Patient PATCH (S7-4, from routes/patients/patch.ts)
// ---------------------------------------------------------------------------------------------------

/** The live (not deleted) patient's full row locked FOR UPDATE — the PATCH's anchor — or none. */
export async function lockFullForUpdate(db: QueryRunner, id: string, orgId: string): Promise<PatientRow | undefined> {
  const { rows: current } = await db.query<PatientRow>(
      `SELECT ${SELECT_COLS}
       FROM patient_records
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [id, orgId]
  );
  return current[0];
}

export interface PatchWrite {
  id: string;
  orgId: string;
  personId: string;
  meta: {
    name: string; patientNo: string | null; birthDate: string | null; injuryDate: string | null; evaluationDate: string | null;
    activeModules: string[]; diagnosesCodes: string[]; jobsNames: string[];
  };
  payloadJson: string;
  expectedRevision: number;
  completion: CompletionColumns;
  verification: VerificationColumns;
}

/**
 * Meta columns, payload and completion columns from a PATCH, revision + 1 — only while the revision is
 * still `expectedRevision` and the patient is not deleted (else no row). The completion columns are
 * assigned as computed (the caller kept the previous provenance).
 */
export async function updateFromPatch(db: QueryRunner, w: PatchWrite): Promise<PatientRow | undefined> {
  const { meta } = w;
  const { rows: updated } = await db.query<PatientRow>(
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
         payload           = $12,
         completion_status                   = $14,
         server_observed_modules_complete_at = $15,
         completion_source                   = $16,
         completion_client_build_version     = $17,
         completion_client_schema_version    = $18,
         server_verified_modules_complete_at    = $19,
         completion_verification_engine_version = $20
       WHERE id = $1 AND organization_id = $2 AND revision = $13 AND deleted_at IS NULL
       RETURNING ${SELECT_COLS}`,
    [
      w.id, w.orgId, w.personId,
      meta.name, meta.patientNo,
      meta.birthDate, meta.injuryDate, meta.evaluationDate,
      meta.activeModules, meta.diagnosesCodes, meta.jobsNames,
      w.payloadJson,
      w.expectedRevision,
      w.completion.completion_status,
      w.completion.server_observed_modules_complete_at,
      w.completion.completion_source,
      w.completion.completion_client_build_version,
      w.completion.completion_client_schema_version,
      w.verification.server_verified_modules_complete_at,
      w.verification.completion_verification_engine_version,
    ]
  );
  return updated[0];
}

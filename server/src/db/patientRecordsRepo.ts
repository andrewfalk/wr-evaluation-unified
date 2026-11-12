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

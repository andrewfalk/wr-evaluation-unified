// What a patient soft delete changes outside patient_records, in the same transaction (S7-5). Moved from
// routes/patients/delete.ts; SQL unchanged. Not patient_records SQL, so not in db/patientRecordsRepo.ts.
import type { QueryRunner } from './queryRunner';

/**
 * Redact deleted patient's PHI from workspace snapshots in this org.
 * Intentionally does NOT filter by patient_ids: legacy/migration-incomplete
 * workspaces may have patient data in snapshot_payload but an empty or
 * stale patient_ids array. The EXISTS sub-query scans jsonb content directly
 * so that PHI is removed regardless of patient_ids correctness.
 */
export async function redactPatientInWorkspaces(db: QueryRunner, orgId: string, id: string): Promise<void> {
  await db.query(
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
}

/**
 * Remove the deleted patient from autosave snapshots too (SEC-B L12). An autosave is a crash-recovery
 * copy of a user's open patient list, restored as is — a { redacted } stub would come back as a
 * broken patient, so the entry is dropped instead (the workspace stub exists for its UI notice).
 * Same match as above (local id or sync.serverId), no reliance on any id index. Rows of users whose
 * organization was removed (organization_id NULL) are included: patient ids are UUIDs, so only this
 * patient's entries can match. saved_at is left as is.
 */
export async function removePatientFromAutosaves(db: QueryRunner, orgId: string, id: string): Promise<void> {
  await db.query(
      `UPDATE autosaves
       SET payload = COALESCE((
         SELECT jsonb_agg(p ORDER BY ord)
         FROM jsonb_array_elements(payload) WITH ORDINALITY AS e(p, ord)
         WHERE NOT ((p->>'id') IS NOT DISTINCT FROM $2 OR (p->'sync'->>'serverId') IS NOT DISTINCT FROM $2)
       ), '[]'::jsonb)
       WHERE (organization_id = $1 OR organization_id IS NULL)
         AND jsonb_typeof(payload) = 'array'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(payload) AS p
           WHERE (p->>'id') = $2 OR (p->'sync'->>'serverId') = $2
         )`,
      [orgId, id]
  );
}

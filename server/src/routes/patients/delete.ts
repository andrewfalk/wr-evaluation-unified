// DELETE /api/patients/:id — soft delete with workspace redaction and autosave cleanup (S7: softDelete).
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { releasePersonIfOrphaned, type QueryRunner } from '../../db/patientPersons';
import { deleteLockForPatient, lockPatientAnchor, assertAssignedOrAdmin, PatientLockTargetNotFoundError, PatientLockForbiddenError } from '../../db/patientLocks';
import { parsePositiveInt } from '../../http/lockToken';
import { evaluateLockGate } from '../../http/lockGate';
import { orgIdOf, sessionOf } from '../../http/authz';

// ---------------------------------------------------------------------------
// DELETE /api/patients/:id?revision=N
// Soft-delete (sets deleted_at). Within the same transaction, redacts the
// deleted patient's PHI from every workspace snapshot in this org so that
// { id, redacted: true } stubs remain without exposing name/birth_date/etc.,
// and removes the patient from autosave snapshots (SEC-B L12).
// Returns 409 on revision mismatch.
// ---------------------------------------------------------------------------
export async function deletePatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

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

    // 앵커(FOR UPDATE)는 락 기능(off/observe/enforce)과 무관하게 항상 잡는다 — 이유는 두 가지:
    // (1) assignedDoctorOrAdmin 미들웨어는 이 트랜잭션 밖에서(FOR UPDATE 없이) 담당의를
    //     확인했으므로, 그 확인과 지금 사이에 재배정된 최신 담당의를 여기서 재확인해야
    //     한다(TOCTOU, 락 기능 on/off와 무관한 일반 권한 방어선). 존재하지 않거나 이미
    //     삭제된 환자면 여기서 던진다(catch에서 404 처리).
    // (2) 락 기능이 켜져 있을 때는 이 행 락이 곧 patient_locks 검사의 직렬화 지점이다.
    const anchor = await lockPatientAnchor(client as QueryRunner, { patientId: id, orgId });
    assertAssignedOrAdmin(anchor, session);

    // 락 기능 자체(patient_locks 검사)는 lockEnforcementMode가 off면 내부적으로 즉시 통과한다.
    const lockBlock = await evaluateLockGate(pool, client as QueryRunner, req, id, orgId);
    if (lockBlock) {
      await client.query('ROLLBACK');
      res.status(lockBlock.status).json(lockBlock.body);
      return;
    }

    const result = await client.query<{ patient_person_id: string | null }>(
      `UPDATE patient_records
       SET deleted_at = now()
       WHERE id = $1 AND organization_id = $2 AND revision = $3 AND deleted_at IS NULL
       RETURNING patient_person_id`,
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

    // Remove the deleted patient from autosave snapshots too (SEC-B L12). An autosave is a crash-recovery
    // copy of a user's open patient list, restored as is — a { redacted } stub would come back as a
    // broken patient, so the entry is dropped instead (the workspace stub exists for its UI notice).
    // Same match as above (local id or sync.serverId), no reliance on any id index. Rows of users whose
    // organization was removed (organization_id NULL) are included: patient ids are UUIDs, so only this
    // patient's entries can match. saved_at is left as is.
    await client.query(
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

    // 소프트 삭제는 deleted_at 갱신일 뿐이라 ON DELETE CASCADE가 발동하지 않으므로 명시적으로 정리.
    await deleteLockForPatient(client as QueryRunner, { patientId: id, orgId });

    // 이 환자가 그 person의 마지막 활성 case였다면 등록번호를 해제한다.
    // 이것이 없으면 person 행이 살아남아 (organization_id, patient_no)를 계속 점유하고,
    // 같은 등록번호로 재입력할 때 옛 birth_date와 비교돼 PATIENT_IDENTITY_CONFLICT가 재발한다
    // ("유령 환자"). 0006 인덱스 주석의 "Soft-deleted patients do not reserve the number"가
    // 실제로 성립하게 만드는 지점.
    await releasePersonIfOrphaned(client as QueryRunner, result.rows[0]?.patient_person_id, orgId);

    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PatientLockTargetNotFoundError) {
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }
    if (err instanceof PatientLockForbiddenError) {
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}

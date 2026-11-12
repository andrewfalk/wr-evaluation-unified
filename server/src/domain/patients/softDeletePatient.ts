// DELETE /api/patients/:id?revision=N — the transaction (S7-5). Moved from routes/patients/delete.ts;
// statements, their order, the checks' order and the outcomes are unchanged:
//   case anchor FOR UPDATE (404) → assigned doctor (403) → edit lock (423) → soft delete WHERE revision
//   (0 rows → 404 or 409) → workspace redaction → autosave cleanup → lock row → release the person.
// A soft delete does not bump the revision (kept as before).
import type { Pool } from 'pg';
import { releasePersonIfOrphaned } from '../../db/patientPersons';
import { deleteLockForPatient, lockPatientAnchor, assertAssignedOrAdmin, PatientLockTargetNotFoundError, PatientLockForbiddenError, type LockRow } from '../../db/patientLocks';
import { redactPatientInWorkspaces, removePatientFromAutosaves } from '../../db/patientDeletionSideEffects';
import { toQueryRunner } from '../../db/queryRunner';
import { withDecidedTransaction, type TransactionDecision } from '../../db/withWriteTransaction';
import { softDelete, selectAnyState } from '../../db/patientRecordsRepo';
import type { PatientWriteContext } from './context';
import { runLockGate } from './lockGate';

export type SoftDeletePatientResult =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'lock_held'; heldBy: LockRow }
  | { kind: 'revision_mismatch'; currentRevision: number };

const rollback = (value: SoftDeletePatientResult): TransactionDecision<SoftDeletePatientResult> => ({ commit: false, value });

export async function softDeletePatient(
  pool: Pool,
  ctx: PatientWriteContext,
  params: { id: string; revision: number },
): Promise<SoftDeletePatientResult> {
  const { id, revision } = params;
  const orgId = ctx.orgId;
  try {
    return await withDecidedTransaction<SoftDeletePatientResult>(pool, async (client) => {
      const db = toQueryRunner(client);

      // 앵커(FOR UPDATE)는 락 기능(off/observe/enforce)과 무관하게 항상 잡는다 — 이유는 두 가지:
      // (1) requirePatientAccess 미들웨어는 이 트랜잭션 밖에서(FOR UPDATE 없이) 담당의를
      //     확인했으므로, 그 확인과 지금 사이에 재배정된 최신 담당의를 여기서 재확인해야
      //     한다(TOCTOU, 락 기능 on/off와 무관한 일반 권한 방어선). 존재하지 않거나 이미
      //     삭제된 환자면 여기서 던진다(아래 catch에서 not_found).
      // (2) 락 기능이 켜져 있을 때는 이 행 락이 곧 patient_locks 검사의 직렬화 지점이다.
      const anchor = await lockPatientAnchor(db, { patientId: id, orgId });
      assertAssignedOrAdmin(anchor, { role: ctx.actor.role, userId: ctx.actor.userId });

      // 락 기능 자체(patient_locks 검사)는 lockEnforcementMode가 off면 내부적으로 즉시 통과한다.
      const { blocked } = await runLockGate(db, pool, ctx, { patientId: id, leaseToken: ctx.leaseToken });
      if (blocked) return rollback({ kind: 'lock_held', heldBy: blocked });

      const result = await softDelete(db, id, orgId, revision);
      if (result.rowCount === 0) {
        const row = await selectAnyState(db, id, orgId);
        if (!row || row.deleted_at !== null) return rollback({ kind: 'not_found' });
        return rollback({ kind: 'revision_mismatch', currentRevision: row.revision });
      }

      await redactPatientInWorkspaces(db, orgId, id);
      await removePatientFromAutosaves(db, orgId, id);

      // 소프트 삭제는 deleted_at 갱신일 뿐이라 ON DELETE CASCADE가 발동하지 않으므로 명시적으로 정리.
      await deleteLockForPatient(db, { patientId: id, orgId });

      // 이 환자가 그 person의 마지막 활성 case였다면 등록번호를 해제한다.
      // 이것이 없으면 person 행이 살아남아 (organization_id, patient_no)를 계속 점유하고,
      // 같은 등록번호로 재입력할 때 옛 birth_date와 비교돼 PATIENT_IDENTITY_CONFLICT가 재발한다
      // ("유령 환자"). 0006 인덱스 주석의 "Soft-deleted patients do not reserve the number"가
      // 실제로 성립하게 만드는 지점.
      await releasePersonIfOrphaned(db, result.personId, orgId);

      return { commit: true, value: { kind: 'deleted' } };
    });
  } catch (err) {
    if (err instanceof PatientLockTargetNotFoundError) return { kind: 'not_found' };
    if (err instanceof PatientLockForbiddenError) return { kind: 'forbidden' };
    throw err;
  }
}

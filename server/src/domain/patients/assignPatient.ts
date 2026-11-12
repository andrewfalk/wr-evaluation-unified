// POST /api/patients/:id/assignment (admin only) — changes the assigned doctor (S7-6). Moved from
// routes/patients/assignment.ts; statements, their order and the outcomes are unchanged:
//   (before the transaction) target user check on the pool → 404 USER_NOT_FOUND / 422
//   (mode ≠ off) case anchor → edit lock: observe = audit and go on, enforce = 423 unless force, force =
//   remove the lock → previous doctor (no lock) → UPDATE (404 if gone) → COMMIT → audit on the pool.
// In off mode there is no anchor: the UPDATE is the first lock (kept as before). The UPDATE has no revision
// condition (an administrative change) and bumps the revision.
import type { Pool } from 'pg';
import config from '../../config';
import { writeAuditLog } from '../../middleware/audit';
import { deleteLockForPatient, lockPatientAnchor, PatientLockTargetNotFoundError, type LockRow } from '../../db/patientLocks';
import { toQueryRunner } from '../../db/queryRunner';
import { withDecidedTransaction, type TransactionDecision } from '../../db/withWriteTransaction';
import { selectPreviousDoctor, setAssignment } from '../../db/patientRecordsRepo';
import type { PatientWriteContext } from './context';
import { runLockGate } from './lockGate';

export type AssignPatientResult =
  | { kind: 'assigned'; revision: number }
  | { kind: 'user_not_found' }
  | { kind: 'target_not_a_doctor' }
  | { kind: 'not_found' }
  | { kind: 'lock_held'; heldBy: LockRow };

type InTx =
  | { kind: 'assigned'; revision: number; previousDoctorUserId: string | null; previousDoctorName: string | null; forcedLockHolder: string | null }
  | { kind: 'not_found' }
  | { kind: 'lock_held'; heldBy: LockRow };

const rollback = (value: InTx): TransactionDecision<InTx> => ({ commit: false, value });

export async function assignPatient(
  pool: Pool,
  ctx: PatientWriteContext,
  params: { id: string; assignedUserId: string | null; force: boolean },
): Promise<AssignPatientResult> {
  const { id, assignedUserId, force } = params;
  const orgId = ctx.orgId;

  let newDoctorName: string | null = null;
  if (assignedUserId !== null) {
    // Verify target user exists in the organisation and has doctor role.
    const { rows: userRows } = await pool.query<{ id: string; role: string; name: string }>(
      `SELECT id, role, name FROM users WHERE id = $1 AND organization_id = $2 AND disabled_at IS NULL`,
      [assignedUserId, orgId]
    );
    if (userRows.length === 0) return { kind: 'user_not_found' };
    if (userRows[0].role !== 'doctor') return { kind: 'target_not_a_doctor' };
    newDoctorName = userRows[0].name;
  }

  let outcome: InTx;
  try {
    // 일반·force 두 경로 모두 같은 앵커+락 확인을 거친다 — force 경로에만 앵커를 잡으면
    // 일반 재배정과 acquire/force가 서로 경합할 수 있다. off 모드에서는(기존 동작과 완전히
    // 동일하도록) 앵커·락 확인 자체를 건너뛴다.
    outcome = await withDecidedTransaction<InTx>(pool, async (client) => {
      const db = toQueryRunner(client);
      let forcedLockHolder: string | null = null;

      if (config.lockEnforcementMode !== 'off') {
        await lockPatientAnchor(db, { patientId: id, orgId });

        // assignPatient는 자신이 보유한 leaseToken이 없으므로(호출자가 편집 세션을 갖고 있지
        // 않음), 살아있는 락이 있으면 항상 불일치로 취급 — force가 아니면 423, force면 폐기.
        // observe 모드에서는 runLockGate가 감사(context: 'assignment')만 남기고 통과시킨다.
        const { blocked } = await runLockGate(db, pool, ctx, { patientId: id, leaseToken: null, auditContext: 'assignment' });
        if (blocked) {
          if (!force) return rollback({ kind: 'lock_held', heldBy: blocked });
          forcedLockHolder = blocked.holderName;
          await deleteLockForPatient(db, { patientId: id, orgId });
        }
      }

      // Read previous doctor (id + name) before update for audit.
      const previous = await selectPreviousDoctor(db, id, orgId);
      if (!previous) return rollback({ kind: 'not_found' });

      // Update assigned doctor, sync doctorName in payload, and bump revision.
      const updated = await setAssignment(db, { id, orgId, assignedUserId, doctorName: newDoctorName ?? '' });
      if (!updated) return rollback({ kind: 'not_found' });

      return {
        commit: true,
        value: {
          kind: 'assigned', revision: updated.revision, forcedLockHolder,
          previousDoctorUserId: previous.assigned_doctor_user_id, previousDoctorName: previous.previous_doctor_name,
        },
      };
    });
  } catch (err) {
    if (err instanceof PatientLockTargetNotFoundError) return { kind: 'not_found' };
    throw err;
  }
  if (outcome.kind !== 'assigned') return outcome;

  // After COMMIT, on the pool, not awaited (as before).
  writeAuditLog(pool, {
    actorUserId: ctx.actor.userId,
    actorOrgId:  orgId,
    action:      outcome.forcedLockHolder !== null ? 'patient_assignment_force' : 'patient_assignment_change',
    targetType:  'patient',
    targetId:    id,
    outcome:     'success',
    ip:          ctx.audit.ip,
    userAgent:   ctx.audit.userAgent,
    extra:       {
      previousDoctorUserId: outcome.previousDoctorUserId, previousDoctorName: outcome.previousDoctorName,
      assignedUserId, newDoctorName, forcedLockHolder: outcome.forcedLockHolder,
    },
  });

  return { kind: 'assigned', revision: outcome.revision };
}

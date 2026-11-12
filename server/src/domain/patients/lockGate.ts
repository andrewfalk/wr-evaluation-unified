// The patient edit-lock write gate without the Express request (S7). The body of the former
// http/lockGate.ts evaluateLockGate, which now calls this.
//
//   off      always passes, without reading patient_locks (compatibility with older clients).
//   observe  a live lock held by someone else is recorded as a `patient_lock_observed_block` audit row
//            and the write goes on. The row is written through the pool, not the transaction, and not
//            awaited — it stays even if the transaction later rolls back or is retried.
//   enforce  a live lock held by someone else blocks: `blocked` is that lock. The caller answers 423
//            (or, for a forced reassignment, removes the lock).
//
// The mode is read on every call: tests switch it while running.
import type { Pool } from 'pg';
import config from '../../config';
import { checkLockForWrite, type LockRow } from '../../db/patientLocks';
import type { QueryRunner } from '../../db/queryRunner';
import { writeAuditLog } from '../../middleware/audit';
import type { PatientWriteContext } from './context';

export interface LockGateParams {
  patientId: string;
  leaseToken: string | null;
  /**
   * Added to the observe-mode audit row's `extra` as `context` (`{ holderName, context }`). Omitted,
   * `extra` is `{ holderName }` — each write path keeps the audit row it wrote before S7.
   */
  auditContext?: string;
}

// Moved from http/lockGate.ts (S7-1).
// holder 응답에는 holderName/acquiredAt/expiresAt만 노출 — leaseToken/clientInstanceId/
// sessionId/userId는 절대 노출하지 않는다.
export function lockHolderResponse(lock: LockRow): { holderName: string; acquiredAt: string; expiresAt: string } {
  return {
    holderName: lock.holderName,
    acquiredAt: lock.acquiredAt.toISOString(),
    expiresAt:  lock.expiresAt.toISOString(),
  };
}

/** Call with the patient's anchor row already locked (FOR UPDATE) in `db`'s transaction. */
export async function runLockGate(
  db: QueryRunner,
  pool: Pool,
  ctx: PatientWriteContext,
  params: LockGateParams,
): Promise<{ blocked: LockRow | null }> {
  if (config.lockEnforcementMode === 'off') return { blocked: null };

  const result = await checkLockForWrite(db, { patientId: params.patientId, orgId: ctx.orgId, leaseToken: params.leaseToken });
  if (result.ok) return { blocked: null };

  if (config.lockEnforcementMode === 'observe') {
    void writeAuditLog(pool, {
      actorUserId: ctx.actor.userId, actorOrgId: ctx.orgId, action: 'patient_lock_observed_block',
      targetType: 'patient', targetId: params.patientId, outcome: 'success',
      ip: ctx.audit.ip, userAgent: ctx.audit.userAgent,
      extra: params.auditContext === undefined
        ? { holderName: result.heldBy.holderName }
        : { holderName: result.heldBy.holderName, context: params.auditContext },
    });
    return { blocked: null };
  }

  return { blocked: result.heldBy };
}

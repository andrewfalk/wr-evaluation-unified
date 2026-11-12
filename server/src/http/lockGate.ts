// The edit-lock responses shared by the patient and video routes. The write gate itself is
// domain/patients/lockGate.ts runLockGate (S7); the request-level adapter evaluateLockGate that lived here was
// removed in S7-8a once every write path called the service.
import type { LockRow } from '../db/patientLocks';
import { lockHolderResponse } from '../domain/patients/lockGate';

// lockHolderResponse moved to domain/patients/lockGate.ts (S7-1); re-exported.
export { lockHolderResponse };

/**
 * 423 LOCK_HELD for a lock held by someone else — the one copy (S7-8a) of the body PATCH, DELETE, the
 * assignment, the identity correction's early gate, the lease-lock routes and the video apply answer.
 * holder carries holderName/acquiredAt/expiresAt only (never the lease token, client instance or user id).
 */
export function lockHeldResponse(lock: LockRow): { code: string; error: string; holder: unknown } {
  return {
    code:   'LOCK_HELD',
    error:  `Currently being edited by ${lock.holderName}`,
    holder: lockHolderResponse(lock),
  };
}

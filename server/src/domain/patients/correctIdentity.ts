// POST /api/patients/:id/identity-correction — the transaction loop (S7-7). Moved from
// routes/patients/identity.ts; statements, their order and the outcomes are unchanged. Each attempt:
//   early edit-lock gate (no anchor — a cheap early refusal) → correctPatientIdentity (its own locking order:
//   no-lock probe → the person's active cases ORDER BY id FOR UPDATE → re-validate → person → set re-check →
//   authoritative lock checks → UPDATEs; not changed by S7) → audit row in the transaction → read back → COMMIT.
// A changed case set (IdentitySetChangedError) rolls back and retries, up to IDENTITY_CORRECTION_MAX_ATTEMPTS.
import type { Pool } from 'pg';
import { writeAuditLogStrict } from '../../middleware/audit';
import {
  correctPatientIdentity, IdentityCaseLockedError, IdentityForbiddenError, IdentityRevisionMismatchError,
  IdentitySetChangedError, IdentityTargetNotFoundError,
} from '../../db/patientIdentityCorrection';
import { PatientLockTargetNotFoundError, PatientLockForbiddenError, type LockRow } from '../../db/patientLocks';
import { toQueryRunner } from '../../db/queryRunner';
import { withDecidedTransaction } from '../../db/withWriteTransaction';
import { selectById, type PatientRow } from '../../db/patientRecordsRepo';
import type { PatientWriteContext } from './context';
import { runLockGate } from './lockGate';

// 활성 case 집합이 계속 바뀌면 무한 재시도로 커넥션을 묶지 않고 포기한다.
export const IDENTITY_CORRECTION_MAX_ATTEMPTS = 3;

export type CorrectIdentityResult =
  | { kind: 'corrected'; row: PatientRow; affectedPatientIds: string[] }
  /** The early gate (before any anchor) found another user's lock on the target. */
  | { kind: 'lock_held_gate'; heldBy: LockRow }
  | { kind: 'set_changed' }
  | { kind: 'not_found' }
  | { kind: 'revision_mismatch'; currentRevision: number }
  | { kind: 'forbidden'; requiresAdmin: boolean }
  /** correctPatientIdentity's authoritative lock check (after the cases are locked). */
  | { kind: 'case_locked'; message: string };

export interface CorrectIdentityParams {
  id: string;
  /** If-Match. */
  expectedRevision: number;
  /** Canonical YYYY-MM-DD, not empty (validated by the route). */
  birthDate: string;
  reasonCode: string;
}

export async function correctIdentity(pool: Pool, ctx: PatientWriteContext, params: CorrectIdentityParams): Promise<CorrectIdentityResult> {
  const { id, expectedRevision, birthDate, reasonCode } = params;
  const orgId = ctx.orgId;

  for (let attempt = 1; attempt <= IDENTITY_CORRECTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withDecidedTransaction<CorrectIdentityResult>(pool, async (client) => {
        const db = toQueryRunner(client);

        const { blocked } = await runLockGate(db, pool, ctx, { patientId: id, leaseToken: ctx.leaseToken });
        if (blocked) return { commit: false, value: { kind: 'lock_held_gate', heldBy: blocked } };

        const result = await correctPatientIdentity(db, {
          targetId: id,
          orgId,
          expectedRevision,
          birthDate,
          session: { userId: ctx.actor.userId, role: ctx.actor.role },
          // 권위 있는 락 판정은 correctPatientIdentity가 활성 case를 잠근 뒤 수행한다.
          // 위 runLockGate는 앵커 없이 도는 값싼 조기 차단일 뿐이다.
          leaseToken: ctx.leaseToken,
        });

        // 감사 기록은 변경과 같은 트랜잭션에서 — 기록이 남지 않으면 변경도 남지 않아야 한다.
        // 라우터의 attempt 미들웨어는 실패/거부만 남기므로 여기서 중복되지 않는다.
        await writeAuditLogStrict(db, {
          actorUserId: ctx.actor.userId,
          actorOrgId:  orgId,
          action:      'patient_identity_correct',
          targetType:  'patient_person',
          targetId:    result.personId,
          outcome:     'success',
          ip:          ctx.audit.ip,
          userAgent:   ctx.audit.userAgent,
          // 생년월일은 PHI이므로 기록하지 않는다. person UUID는 targetId에 이미 있다.
          extra:       { reasonCode, affectedCaseCount: result.caseCount },
        });

        const row = await selectById(db, id);
        return { commit: true, value: { kind: 'corrected', row: row!, affectedPatientIds: result.affectedPatientIds } };
      });
    } catch (err) {
      if (err instanceof IdentitySetChangedError) {
        if (attempt < IDENTITY_CORRECTION_MAX_ATTEMPTS) continue;
        return { kind: 'set_changed' };
      }
      if (err instanceof IdentityTargetNotFoundError || err instanceof PatientLockTargetNotFoundError) return { kind: 'not_found' };
      if (err instanceof IdentityRevisionMismatchError) return { kind: 'revision_mismatch', currentRevision: err.currentRevision };
      if (err instanceof IdentityForbiddenError) return { kind: 'forbidden', requiresAdmin: err.requiresAdmin };
      if (err instanceof IdentityCaseLockedError) return { kind: 'case_locked', message: err.message };
      if (err instanceof PatientLockForbiddenError) return { kind: 'forbidden', requiresAdmin: false };
      throw err;
    }
  }
  // The last attempt returns or throws above.
  throw new Error('unreachable');
}

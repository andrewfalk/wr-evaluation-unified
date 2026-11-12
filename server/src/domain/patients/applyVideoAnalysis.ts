// Video analysis apply — the patient section (S7-2). Moved from routes/videoAnalysis/apply.ts ③–④;
// statements, their order and the outcomes are unchanged.
//
// The route owns the transaction: its first lock is the video job (FOR UPDATE OF j), and the job and
// source-job transitions after the patient UPDATE are in the same transaction. This runs inside it, on
// the route's client, from the patient lock to the patient UPDATE. The recipe check needs the locked
// patient's stored payload, so the route passes it in as `validate` and it runs in its old place
// (after the revision check, before the UPDATE) — domain/ does not depend on the video module.
import type { Pool } from 'pg';
import type { LockRow } from '../../db/patientLocks';
import { isAssignedOrAdmin } from '../../db/patientLocks';
import type { QueryRunner } from '../../db/queryRunner';
import { lockForApply, updateFromVideoApply, type ApplyPatientRow } from '../../db/patientRecordsRepo';
import { nextCompletionColumns, verifyModulesComplete, logCompletionMismatchIfAny, nextVerificationColumns } from '../../completionTracking';
import type { PatientWriteContext } from './context';
import { runLockGate } from './lockGate';

export type ApplyVideoAnalysisResult =
  | { kind: 'applied'; row: ApplyPatientRow }
  | { kind: 'patient_not_found' }
  | { kind: 'forbidden' }
  | { kind: 'lock_held'; heldBy: LockRow }
  | { kind: 'revision_mismatch'; currentRevision: number }
  /** The recipe check's failure; `body` is answered as is (400). */
  | { kind: 'rejected'; body: object }
  | { kind: 'concurrent_modification' };

export interface ApplyVideoAnalysisParams {
  patientId: string;
  /** If-Match. */
  expectedRevision: number;
  /** The patient's new `data` (replaces payload.data; the other payload keys are kept). */
  data: Record<string, unknown>;
  report: { modulesCompleteObserved?: boolean; completionClientBuildVersion?: string; completionClientSchemaVersion?: number };
  /** Recipe check against the locked patient's stored payload; a failure body, or null to go on. */
  validate: (existingPayload: Record<string, unknown>) => object | null;
}

export async function applyVideoAnalysisInTx(
  db: QueryRunner,
  pool: Pool,
  ctx: PatientWriteContext,
  params: ApplyVideoAnalysisParams,
): Promise<ApplyVideoAnalysisResult> {
  const { patientId, expectedRevision, data } = params;
  const orgId = ctx.orgId;

  // ③ patient FOR UPDATE + revision(If-Match)
  const pat = await lockForApply(db, patientId, orgId);
  if (!pat) return { kind: 'patient_not_found' };

  // 라우트의 job 확인(canAccess)은 job+patient를 JOIN한 스냅샷(FOR UPDATE OF j — patient_records는 안 잠금)
  // 기준이었다 — 그 확인과 지금 사이에 담당의가 재배정됐을 수 있으므로, patient_records를
  // 실제로 FOR UPDATE로 잠근 이 시점에 다시 확인한다(TOCTOU 최종 방어선).
  if (!isAssignedOrAdmin({ role: ctx.actor.role, userId: ctx.actor.userId }, pat.assigned_doctor_user_id)) {
    return { kind: 'forbidden' };
  }

  // 환자 단위 TTL lease lock 게이트 — patchPatient와 동일한 If-Match 계약을 쓰므로 동일하게
  // 보호한다. 멱등 replay는 라우트가 이 체크보다 앞서 이미 처리·반환했으므로, 안전한 네트워크
  // 재시도가 이 게이트 때문에 불필요하게 423을 받는 일은 없다.
  const { blocked } = await runLockGate(db, pool, ctx, {
    patientId, leaseToken: ctx.leaseToken, auditContext: 'video_analysis_apply',
  });
  if (blocked) return { kind: 'lock_held', heldBy: blocked };

  if (pat.revision !== expectedRevision) {
    return { kind: 'revision_mismatch', currentRevision: pat.revision };
  }

  // ④ payload 갱신(클라가 계산한 data 영속화 — 영상 apply는 meta 컬럼 불변).
  const existingPayload = typeof pat.payload === 'object' && pat.payload !== null
    ? (pat.payload as Record<string, unknown>) : {};

  // recipe 검증 게이트(§8.11, 6.0-9) — payload 무수정, 대조만. 서버가 source of truth.
  const recipeFail = params.validate(existingPayload);
  if (recipeFail) return { kind: 'rejected', body: recipeFail };

  const newPayload = { ...existingPayload, data };

  // PR0-A: patients.ts와 동일한 3상태 규칙 — 이미 FOR UPDATE로 잠근 행을 기준으로
  // 계산해 같은 UPDATE 문장에 얹는다. revision 충돌 시(UPDATE의 WHERE revision = $4) 완료
  // 보고도 자동으로 함께 거부된다.
  const nextCompletion = nextCompletionColumns(pat, params.report);

  // PR0-B2: 클라이언트 신고와 별개로 서버가 analytics-core로 직접 재검증한다 — apply가
  // 갱신하는 새 data를 기준으로, 같은 FOR UPDATE 잠금 하에 계산해 같은 UPDATE 문장에 얹는다.
  const verified = verifyModulesComplete({
    shared: data['shared'] as Record<string, unknown> ?? {},
    modules: data['modules'] as Record<string, unknown> ?? {},
    activeModules: data['activeModules'] as string[] ?? [],
  });
  logCompletionMismatchIfAny(patientId, params.report.modulesCompleteObserved, verified);
  const nextVerification = nextVerificationColumns(pat, verified.allComplete);

  const updated = await updateFromVideoApply(db, {
    id: patientId, orgId, payloadJson: JSON.stringify(newPayload), expectedRevision,
    completion: nextCompletion, verification: nextVerification,
  });
  if (!updated) return { kind: 'concurrent_modification' };
  return { kind: 'applied', row: updated };
}

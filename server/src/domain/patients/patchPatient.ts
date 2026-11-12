// PATCH /api/patients/:id — the transaction (S7-4). Moved from routes/patients/patch.ts together with the
// deadlock retry the router wrapped it in; statements, their order, the checks' order and the outcomes are
// unchanged:
//   case anchor FOR UPDATE → 404 → assigned doctor (403) → If-Match revision (409) → edit lock (423)
//   → dates (400) → name (400) → person → UPDATE … WHERE revision (409 concurrent) → release old person.
import type { Pool } from 'pg';
import { PatientIdentityConflictError, PatientPersonVanishedError, resolvePatientPersonId, releasePersonIfOrphaned, type PatientPersonWarning } from '../../db/patientPersons';
import { assertAssignedOrAdmin, PatientLockForbiddenError, type LockRow } from '../../db/patientLocks';
import { isUniqueViolation, type PgErrorLike } from '../../db/pgErrors';
import { toQueryRunner } from '../../db/queryRunner';
import { withDeadlockRetry } from '../../db/withDeadlockRetry';
import { withDecidedTransaction, type TransactionDecision } from '../../db/withWriteTransaction';
import { lockFullForUpdate, updateFromPatch, type PatientRow } from '../../db/patientRecordsRepo';
import { nextCompletionColumns, verifyModulesComplete, logCompletionMismatchIfAny, nextVerificationColumns } from '../../completionTracking';
import type { PatientWriteContext } from './context';
import { runLockGate } from './lockGate';
import { extractMeta, normalizePatientDates, type DateFieldFailure } from './meta';

export type PatchPatientResult =
  | { kind: 'updated'; row: PatientRow; warnings: PatientPersonWarning[] }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'revision_mismatch'; currentRevision: number }
  | { kind: 'lock_held'; heldBy: LockRow }
  | { kind: 'invalid_dates'; failures: DateFieldFailure[] }
  | { kind: 'name_required' }
  | { kind: 'identity_conflict' }
  | { kind: 'person_vanished' }
  | { kind: 'unique_conflict'; error: PgErrorLike }
  | { kind: 'concurrent_modification' };

export interface PatchPatientParams {
  id: string;
  /** If-Match. */
  expectedRevision: number;
  phase: string | undefined;
  data: Record<string, unknown> | undefined;
  report: { modulesCompleteObserved?: boolean; completionClientBuildVersion?: string; completionClientSchemaVersion?: number };
}

const rollback = (value: PatchPatientResult): TransactionDecision<PatchPatientResult> => ({ commit: false, value });

export async function patchPatient(pool: Pool, ctx: PatientWriteContext, params: PatchPatientParams): Promise<PatchPatientResult> {
  // 두 환자가 등록번호를 맞바꾸는 등 person 잠금 순서가 엇갈리면 PostgreSQL이 한쪽을 교착으로
  // 중단시킨다 — 트랜잭션 전체를 다시 실행한다(이전에는 라우터가 핸들러를 감쌌다).
  return withDeadlockRetry(async () => {
    try {
      return await withDecidedTransaction(pool, (client) => patchInTx(toQueryRunner(client), pool, ctx, params));
    } catch (err: unknown) {
      if (err instanceof PatientLockForbiddenError) return { kind: 'forbidden' };
      if (err instanceof PatientIdentityConflictError) return { kind: 'identity_conflict' };
      if (err instanceof PatientPersonVanishedError) return { kind: 'person_vanished' };
      if (isUniqueViolation(err)) return { kind: 'unique_conflict', error: err };
      throw err;
    }
  });
}

async function patchInTx(
  db: ReturnType<typeof toQueryRunner>,
  pool: Pool,
  ctx: PatientWriteContext,
  params: PatchPatientParams,
): Promise<TransactionDecision<PatchPatientResult>> {
  const { id, expectedRevision, phase, data, report } = params;
  const orgId = ctx.orgId;

  // FOR UPDATE — 이 트랜잭션 동안 patient_records 행을 앵커로 잡아, force-takeover 등
  // patient_locks에 대한 다른 트랜잭션의 변경이 이 트랜잭션이 끝날 때까지 끼어들 수 없게 한다.
  const current = await lockFullForUpdate(db, id, orgId);
  if (!current) return rollback({ kind: 'not_found' });

  // requirePatientAccess 미들웨어는 이 트랜잭션 밖에서(그리고 FOR UPDATE 없이) 담당의를
  // 확인했다 — 그 확인과 지금 사이에 관리자가 다른 의사로 재배정했을 수 있으므로, 앵커를
  // 이미 쥔 이 시점에 최신 담당의로 다시 확인한다(최종 권한 방어선). 아니면 PatientLockForbiddenError.
  assertAssignedOrAdmin({ id: current.id, assignedDoctorUserId: current.assigned_doctor_user_id }, { role: ctx.actor.role, userId: ctx.actor.userId });

  if (current.revision !== expectedRevision) {
    return rollback({ kind: 'revision_mismatch', currentRevision: current.revision });
  }

  const { blocked } = await runLockGate(db, pool, ctx, { patientId: id, leaseToken: ctx.leaseToken });
  if (blocked) return rollback({ kind: 'lock_held', heldBy: blocked });

  const existingPayload = typeof current.payload === 'object' && current.payload !== null
    ? (current.payload as Record<string, unknown>) : {};

  const newPayload: Record<string, unknown> = {
    ...existingPayload,
    ...(phase !== undefined ? { phase }  : {}),
    ...(data  !== undefined ? { data }   : {}),
  };

  const rawMergedData = typeof newPayload['data'] === 'object' && newPayload['data'] !== null
    ? (newPayload['data'] as Record<string, unknown>) : {};

  // POST와 동일하게 서버가 독립적으로 검증·정규화한다. 정규화된 값은 아래에서
  // DB DATE 컬럼(meta)과 payload(newPayload['data']) 양쪽에 함께 반영된다.
  const dates = normalizePatientDates(rawMergedData);
  if (!dates.ok) return rollback({ kind: 'invalid_dates', failures: dates.failures });
  const mergedData = dates.data;
  newPayload['data'] = mergedData;
  const meta = extractMeta(mergedData);

  if (!meta.name) return rollback({ kind: 'name_required' });

  const { personId, warnings } = await resolvePatientPersonId(db, orgId, meta, current.patient_person_id);

  // PR0-A: 완료 필드는 이미 FOR UPDATE로 잠근 행을 기준으로 계산해 같은
  // UPDATE 문장에 얹는다 — 별도 SQL 분기가 없으므로 revision 충돌 시 완료 보고도
  // 자동으로 함께 거부된다(UPDATE의 WHERE revision = $13이 0행이면 완료 필드도 반영 안 됨).
  const nextCompletion = nextCompletionColumns(current, report);

  // PR0-B2: 클라이언트 신고와 별개로 서버가 analytics-core로 직접 재검증한다 — 같은
  // revision 잠금 하에 같은 UPDATE 문장에 얹으므로 위와 동일한 동시성 보장을 받는다.
  const verified = verifyModulesComplete({
    shared: (mergedData['shared'] as Record<string, unknown>) ?? {},
    modules: (mergedData['modules'] as Record<string, unknown>) ?? {},
    activeModules: (mergedData['activeModules'] as string[]) ?? [],
  });
  logCompletionMismatchIfAny(id, report.modulesCompleteObserved, verified);
  const nextVerification = nextVerificationColumns(current, verified.allComplete);

  // WHERE clause includes revision to catch concurrent modification between read and write.
  const updated = await updateFromPatch(db, {
    id, orgId, personId, meta, payloadJson: JSON.stringify(newPayload), expectedRevision,
    completion: nextCompletion, verification: nextVerification,
  });
  if (!updated) return rollback({ kind: 'concurrent_modification' });

  // 등록번호를 바꾸면(OLD-001 → NEW-001, 또는 빈 값으로) 이 record는 새 person에 붙고
  // 옛 person은 참조가 사라진다. 해제하지 않으면 그 person이 계속 활성 상태로
  // (organization_id, patient_no)를 점유해 삭제 때와 똑같은 "유령 등록번호"가 된다.
  // 같은 트랜잭션 안에서 정리해야 부분 성공이 남지 않는다.
  const previousPersonId = current.patient_person_id;
  if (previousPersonId && previousPersonId !== personId) {
    await releasePersonIfOrphaned(db, previousPersonId, orgId);
  }

  return { commit: true, value: { kind: 'updated', row: updated, warnings } };
}

// Workspace save → patient_records, one patient per transaction (S7-1). Moved from
// routes/workspaces/upsert.ts; statements, their order and the outcomes are unchanged.
//
// HF1(H1): patient_records 쓰기는 PATCH와 같은 규칙을 따라야 한다. 기존 행이면
//   ① 담당의 또는 admin  ② 클라이언트가 마지막으로 본 revision이 서버와 같음  ③ 편집 락 게이트 통과
// 하나라도 어긋나면 덮어쓰지 않고 결과(UpsertOutcome)로 알린다. 예전의 단일
// `INSERT … ON CONFLICT DO UPDATE`는 (a) 같은 id를 동시에 처음 저장하는 두 요청 중 비담당 쪽이
// 담당 환자를 덮어쓸 수 있었고 (b) revision을 올리며 payload를 무조건 덮어써 더 새로운 진료
// 데이터도 날렸다.
//
// 한 환자의 거절/실패가 워크스페이스 저장 전체를 막지 않는 best-effort 철학은 그대로다 —
// 호출부(saveWorkspace)가 결과를 saved/skipped/conflicts/lockedByOther로 집계해 응답한다.
import type { Pool } from 'pg';
import { resolvePatientPersonId, releasePersonIfOrphaned } from '../../db/patientPersons';
import { assertAssignedOrAdmin, PatientLockForbiddenError } from '../../db/patientLocks';
import { withDeadlockRetry } from '../../db/withDeadlockRetry';
import { withDecidedTransaction } from '../../db/withWriteTransaction';
import { toQueryRunner, type QueryRunner } from '../../db/queryRunner';
import { lockAnyStateForUpdate, updateFromSnapshot, insertFromSnapshot, type SnapshotWritten } from '../../db/patientRecordsRepo';
import { resolveAssignedDoctor } from '../../db/resolveAssignedDoctor';
import { nextCompletionColumns, DRAFT_COMPLETION_COLUMNS, verifyModulesComplete, logCompletionMismatchIfAny, nextVerificationColumns, DRAFT_VERIFICATION_COLUMNS } from '../../completionTracking';
import type { PatientWriteContext } from './context';
import { runLockGate, lockHolderResponse } from './lockGate';
import type { PatientMeta } from './meta';

export type SkipReason = 'not_assigned' | 'deleted' | 'error';

export type UpsertOutcome =
  // assignedDoctorUserId: 쓰기 후 행의 실제 담당의 — 클라이언트 편집 권한 판정(canEditPatient)이 이 값을 쓴다.
  | { kind: 'saved'; revision: number; assignedDoctorUserId: string | null }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'conflict'; serverRevision: number }
  | { kind: 'locked'; holder: unknown };

// 트랜잭션 단위는 "환자 1명" — 호출부가 Promise.allSettled로 병렬 실행하므로 하나의
// client를 공유하면 여러 BEGIN/COMMIT이 한 연결에 인터리브돼 트랜잭션 경계가 깨진다.
// 각 호출이 전용 client를 잡고 BEGIN → 검사·쓰기 → COMMIT 한다.
//
// 트랜잭션이 필요한 이유: resolvePatientPersonId가 person 행을 FOR UPDATE로 잡는데,
// pool.query로 실행하면 statement가 끝나는 즉시 잠금이 풀려 잠금 규약이 무효가 된다.
//
// ctx.leaseToken은 이 환자의 편집 락 lease token(요청 본문 lockTokens에서 환자별로 꺼냄). 없으면 null.
export async function upsertFromWorkspace(pool: Pool, ctx: PatientWriteContext, meta: PatientMeta): Promise<UpsertOutcome> {
  // 병렬 upsert끼리도 person 잠금 순서가 엇갈릴 수 있다(등록번호 교환 등).
  // deadlock은 PostgreSQL이 한쪽만 중단시키므로 제한 횟수만큼 재시도하면 해소된다.
  return withDeadlockRetry(() => withDecidedTransaction(pool, async (client) => {
    const outcome = await upsertInTx(toQueryRunner(client), pool, ctx, meta);
    // 저장하지 않은 경로(skipped/conflict/locked)는 되돌린다 — 쓴 것이 없고, 있다면 person뿐이다.
    return { commit: outcome.kind === 'saved', value: outcome };
  }));
}

async function upsertInTx(db: QueryRunner, pool: Pool, ctx: PatientWriteContext, meta: PatientMeta): Promise<UpsertOutcome> {
  const orgId = ctx.orgId;
  const user = { id: ctx.actor.userId, role: ctx.actor.role };

  // 같은 id를 동시에 처음 저장하는 요청들을 직렬화한다. 아직 없는 행은 FOR UPDATE로 잠글 수
  // 없어서, 이게 없으면 두 요청이 모두 "기존 행 없음"을 보고 둘 다 쓰기 경로로 들어간다.
  // 트랜잭션 범위 advisory lock이라 COMMIT/ROLLBACK 때 자동으로 풀린다(stats/queue/runAdmission.ts와 같은 형태).
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [meta.id]);

  // FOR UPDATE 필수: 이 조회와 아래 쓰기 사이에 DELETE가 끼어들면 삭제된 환자에 쓰게 된다.
  // 행을 잡아두면 DELETE/PATCH가 우리 커밋까지 대기한다.
  const existingRow = await lockAnyStateForUpdate(db, meta.id, orgId);
  if (existingRow?.deleted_at !== null && existingRow?.deleted_at !== undefined) {
    return { kind: 'skipped', reason: 'deleted' };
  }

  // 새 환자는 누구나 만들 수 있다(현행 동작). 기존 환자에 대한 쓰기만 검사한다.
  // 검사는 resolvePatientPersonId(person 행을 만들거나 고치는 부작용) "보다 앞"에서 한다.
  if (existingRow) {
    try {
      // PATCH와 같은 규칙·같은 함수. 위 FOR UPDATE가 곧 앵커 잠금이다.
      assertAssignedOrAdmin(
        { id: meta.id, assignedDoctorUserId: existingRow.assigned_doctor_user_id },
        { role: user.role, userId: user.id },
      );
    } catch (err) {
      if (err instanceof PatientLockForbiddenError) return { kind: 'skipped', reason: 'not_assigned' };
      throw err;
    }
    if (existingRow.revision !== meta.expectedRevision) {
      return { kind: 'conflict', serverRevision: existingRow.revision };
    }
    const { blocked } = await runLockGate(db, pool, ctx, { patientId: meta.id, leaseToken: ctx.leaseToken });
    if (blocked) return { kind: 'locked', holder: lockHolderResponse(blocked) };
  }

  const existingPersonId = existingRow?.patient_person_id ?? null;
  const { personId } = await resolvePatientPersonId(db, orgId, meta, existingPersonId);

  // PR0-A: PATCH/POST와 동일한 3상태 규칙(§5.5) — workspace 수동 저장도 patient_records를
  // 직접 갱신하므로 여기서 빠지면 이 경로로만 저장된 환자는 완료돼도 'draft'로 남는다.
  const nextCompletion = nextCompletionColumns(
    existingRow ? existingRow : DRAFT_COMPLETION_COLUMNS,
    {
      modulesCompleteObserved: meta.modulesCompleteObserved,
      completionClientBuildVersion: meta.completionClientBuildVersion,
      completionClientSchemaVersion: meta.completionClientSchemaVersion,
    }
  );

  // PR0-B2: 클라이언트 신고와 별개로 서버가 analytics-core로 직접 재검증한다 — 위와
  // 동일한 FOR UPDATE 잠금 하에서 계산해 같은 쓰기 문장에 얹는다.
  const verified = verifyModulesComplete({
    shared: (meta.data?.['shared'] as Record<string, unknown>) ?? {},
    modules: (meta.data?.['modules'] as Record<string, unknown>) ?? {},
    activeModules: (meta.data?.['activeModules'] as string[]) ?? meta.activeModules,
  });
  logCompletionMismatchIfAny(meta.id, meta.modulesCompleteObserved, verified);
  const nextVerification = nextVerificationColumns(
    existingRow ? existingRow : DRAFT_VERIFICATION_COLUMNS,
    verified.allComplete,
  );

  const { assignedDoctorUserId, assignmentWarnings } = await resolveAssignedDoctor(
    db,
    { orgId, currentUser: user, requestedDoctorName: meta.doctorName }
  );
  if (assignmentWarnings.length > 0) {
    console.warn('[upsertPatientRecord] assignment warnings for patient %s:', meta.id,
      assignmentWarnings.map(w => `${w.code}: ${w.message}`).join('; '));
  }

  // 두 문장이 공유하는 값. 완료 provenance 컬럼(관측 시각·출처·빌드/스키마 버전·서버 검증 시각·
  // 엔진 버전)은 UPDATE에서 COALESCE로 "최초 한 번 찍히면 불변"을 지킨다. completion_status만
  // "현재 상태"라 그대로 덮어쓴다(모듈이 다시 불완전해지면 draft로 돌아가야 한다, §5.5).
  const write = {
    id: meta.id, orgId, personId, name: meta.name, patientNo: meta.patientNo,
    birthDate:      meta.birthDate      ? meta.birthDate      : null,
    injuryDate:     meta.injuryDate     ? meta.injuryDate     : null,
    evaluationDate: meta.evaluationDate ? meta.evaluationDate : null,
    activeModules: meta.activeModules, diagnosesCodes: meta.diagnosesCodes, jobsNames: meta.jobsNames,
    assignedDoctorUserId,
    payloadJson: JSON.stringify(meta.payload),
    completionTail: [
      nextCompletion.completion_status,
      nextCompletion.server_observed_modules_complete_at,
      nextCompletion.completion_source,
      nextCompletion.completion_client_build_version,
      nextCompletion.completion_client_schema_version,
      nextVerification.server_verified_modules_complete_at,
      nextVerification.completion_verification_engine_version,
    ],
  };

  let written: SnapshotWritten;
  if (existingRow) {
    // revision 조건은 위 검사와 같은 값이라 FOR UPDATE 아래에선 항상 맞지만, 어긋나면 0행으로
    // 드러나게 하는 마지막 안전장치다. owner_user_id는 바꾸지 않는다.
    const updated = await updateFromSnapshot(db, write, existingRow.revision);
    if (!updated) return { kind: 'conflict', serverRevision: existingRow.revision };
    written = updated;
  } else {
    // ON CONFLICT 없음: 같은 id가 이 사이에 다른 경로(POST /patients)로 생기면 23505로 실패해
    // 호출부가 skipped(error)로 보고한다 — 인가 검사 없이 덮어쓰는 길을 열어두지 않는다.
    written = await insertFromSnapshot(db, write, user.id);
  }

  // 등록번호가 바뀌어 다른 person으로 옮겨 붙은 경우, 옛 person이 고아로 남지 않게 해제한다
  // (patchPatient와 동일한 이유 — 안 하면 옛 등록번호가 계속 점유된다).
  if (existingPersonId && existingPersonId !== personId) {
    await releasePersonIfOrphaned(db, existingPersonId, orgId);
  }
  return { kind: 'saved', revision: written.revision, assignedDoctorUserId: written.assigned_doctor_user_id ?? null };
}

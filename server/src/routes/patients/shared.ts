// Patient route helpers: conflict responses, metadata extraction, date normalisation, response shape.
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { PatientPersonWarning } from '../../db/patientPersons';
import type { AssignmentWarning } from '../../db/resolveAssignedDoctor';
import type { LockRow } from '../../db/patientLocks';
import { lockHolderResponse } from '../../http/lockGate';
import { PatientRow, PgErrorLike } from './schemas';
import type { DateFieldFailure } from '../../domain/patients/meta';

// Moved to domain/patients/meta.ts and db/pgErrors.ts (S7-3); re-exported for existing imports.
export { strOrNull, extractMeta, normalizePatientDates, type ExtractedMeta, type DateFieldFailure } from '../../domain/patients/meta';
export { isUniqueViolation } from '../../db/pgErrors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------





export function uniqueConflictResponse(err: PgErrorLike): { code: string; error: string } {
  if (err.constraint === 'patient_persons_org_patient_no_uniq') {
    return {
      code:  'PATIENT_PERSON_CONFLICT',
      error: 'A patient with this patient number already exists in this organization',
    };
  }
  return { code: 'CONFLICT', error: 'A patient with this ID already exists' };
}

export function identityConflictResponse(): { code: string; error: string } {
  return {
    code:  'PATIENT_IDENTITY_CONFLICT',
    error: 'This patient number belongs to an existing patient with a different birth date',
  };
}

// 저장 도중 다른 트랜잭션이 같은 person을 해제(soft-delete)한 경우. 데이터 문제가 아니라
// 순수한 타이밍 경합이므로 클라이언트가 그대로 다시 보내면 성공한다.
export function personVanishedResponse(): { code: string; error: string; retriable: boolean } {
  return {
    code:      'PATIENT_PERSON_VANISHED',
    error:     'The patient identity was modified concurrently. Please retry.',
    retriable: true,
  };
}

// ---------------------------------------------------------------------------
// 환자 단위 TTL lease lock — 헬퍼
// ---------------------------------------------------------------------------


export function lockHeldResponse(lock: LockRow): { code: string; error: string; holder: unknown } {
  return {
    code:   'LOCK_HELD',
    error:  `Currently being edited by ${lock.holderName}`,
    holder: lockHolderResponse(lock),
  };
}







export function invalidBirthDateResponse(failures: DateFieldFailure[]): Record<string, unknown> {
  return {
    code:  'INVALID_BIRTH_DATE',
    error: 'One or more date fields are not a valid calendar date within the allowed range',
    // 사유 코드만 — 날짜 값 자체는 PHI이므로 응답 본문에 되싣지 않는다.
    fields: failures,
  };
}

export function toResponse(
  row: PatientRow,
  warnings: PatientPersonWarning[] = [],
  assignmentWarnings: AssignmentWarning[] = []
): Record<string, unknown> {
  const base = typeof row.payload === 'object' && row.payload !== null
    ? (row.payload as Record<string, unknown>) : {};

  // Reconstruct assignment warning from persisted state when not provided at creation time.
  // If assigned_doctor_user_id is still null but the payload carries a doctorName, the name
  // could not be resolved to a user at write time — surface that fact on every GET.
  const effectiveAssignmentWarnings: AssignmentWarning[] = assignmentWarnings.length > 0
    ? assignmentWarnings
    : (() => {
        if (row.assigned_doctor_user_id !== null) return [];
        const data   = base['data']   as Record<string, unknown> | undefined;
        const shared = data?.['shared'] as Record<string, unknown> | undefined;
        const dn     = shared?.['doctorName'];
        if (typeof dn !== 'string' || !dn) return [];
        return [{ code: 'DOCTOR_NAME_UNRESOLVED',
                  message: `'${dn}': 이름으로 의사 계정을 찾을 수 없어 자동 배정이 건너뛰어졌습니다.` }];
      })();

  const baseCreatedAt = typeof base['createdAt'] === 'string' && base['createdAt']
    ? (base['createdAt'] as string)
    : row.created_at.toISOString();

  return {
    ...base,
    id:                   row.id,
    assignedDoctorUserId: row.assigned_doctor_user_id ?? null,
    createdAt:            baseCreatedAt,
    updatedAt:            row.updated_at.toISOString(),
    completionStatus:                  row.completion_status,
    serverObservedModulesCompleteAt:   row.server_observed_modules_complete_at?.toISOString() ?? null,
    serverVerifiedModulesCompleteAt:   row.server_verified_modules_complete_at?.toISOString() ?? null,
    sync: {
      serverId:    row.id,
      revision:    row.revision,
      syncStatus:  'synced',
      lastSyncedAt: row.updated_at.toISOString(),
      ...(warnings.length                       > 0 ? { warnings }                                          : {}),
      ...(effectiveAssignmentWarnings.length    > 0 ? { assignmentWarnings: effectiveAssignmentWarnings }   : {}),
    },
  };
}

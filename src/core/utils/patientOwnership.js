import { isRedactedPatientRecord } from '../services/patientRecords';

const hasOwn = (obj, key) =>
  obj != null && Object.prototype.hasOwnProperty.call(obj, key);

export function getAssignedDoctorUserId(patient) {
  if (hasOwn(patient, 'assignedDoctorUserId')) return patient.assignedDoctorUserId;
  if (hasOwn(patient?.meta, 'assignedDoctorUserId')) return patient.meta.assignedDoctorUserId;
  return undefined;
}

export function getOwnerGroupKey(patient) {
  const assigned = getAssignedDoctorUserId(patient);
  if (assigned !== undefined) return assigned;
  return patient?.meta?.createdBy;
}

export function isMyPatient(patient, session) {
  const userId = session?.user?.id;
  if (!userId) return false;
  if (isRedactedPatientRecord(patient)) return false;

  const assigned = getAssignedDoctorUserId(patient);
  if (assigned !== undefined) return assigned === userId;

  return patient?.meta?.createdBy === userId;
}

// 환자 수정 권한 판정.
// 정책: 로컬 모드는 단일 사용자라 항상 true. 인트라넷에서는 admin 또는 assigned_doctor만.
// redacted/null patient는 어떤 경우에도 false (admin/로컬 무관 — 서버 deleted_at IS NULL과 일관).
export function canEditPatient(patient, session) {
  if (!patient || isRedactedPatientRecord(patient)) return false;
  if (session?.mode !== 'intranet') return true;
  const userId = session?.user?.id;
  if (!userId) return false;
  if (session.user.role === 'admin') return true;
  const assigned = getAssignedDoctorUserId(patient);
  if (assigned !== undefined) return assigned === userId;
  // assigned 미정의 안전망: 아직 서버에 push 안 된 신규 환자(local-only)이고
  // 본인이 만든 경우 임시 편집 허용. 첫 sync 후 서버가 assignedDoctorUserId를 채워주면
  // 그 이후로는 명시적 assigned 비교로 판정. assigned가 명시적 null인 경우는
  // 미배정으로 간주해 이 분기에 안 들어옴 (위 line에서 false 반환).
  const isLocalOnly = patient?.sync?.syncStatus === 'local-only';
  if (isLocalOnly && patient?.meta?.createdBy === userId) return true;
  return false;
}

// 환자 삭제 권한. 정책상 수정과 동일.
export function canDeletePatient(patient, session) {
  return canEditPatient(patient, session);
}

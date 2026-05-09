import type { QueryRunner } from './patientPersons';

export interface AssignmentWarning { code: string; message: string; }
export interface ResolveAssignedDoctorResult {
  assignedDoctorUserId: string | null;
  assignmentWarnings:   AssignmentWarning[];
}

/**
 * Resolves the assigned doctor for a patient being created or upserted.
 *
 * Policy:
 * - If requestedDoctorName is provided and matches exactly one doctor in the org → use that doctor.
 * - If the name matches 0 or 2+ doctors → null + warning (never fall back when name was given).
 * - If requestedDoctorName is absent → use currentUser if they are a doctor, else null.
 */
export async function resolveAssignedDoctor(
  qr: QueryRunner,
  { orgId, currentUser, requestedDoctorName }: {
    orgId:               string;
    currentUser:         { id: string; role: string };
    requestedDoctorName: string | null;
  }
): Promise<ResolveAssignedDoctorResult> {
  if (requestedDoctorName) {
    const { rows } = await qr.query<{ id: string }>(
      `SELECT id FROM users
       WHERE organization_id = $1 AND name = $2 AND role = 'doctor' AND disabled_at IS NULL`,
      [orgId, requestedDoctorName]
    );
    if (rows.length === 1) return { assignedDoctorUserId: rows[0].id, assignmentWarnings: [] };
    const code    = rows.length > 1 ? 'DOCTOR_NAME_AMBIGUOUS' : 'DOCTOR_NAME_NOT_MATCHED';
    const message = rows.length > 1
      ? `'${requestedDoctorName}': 동명이인 의사가 있어 자동 배정을 건너뜁니다.`
      : `'${requestedDoctorName}': 해당 이름의 의사 계정이 없어 자동 배정을 건너뜁니다.`;
    return { assignedDoctorUserId: null, assignmentWarnings: [{ code, message }] };
  }

  return {
    assignedDoctorUserId: currentUser.role === 'doctor' ? currentUser.id : null,
    assignmentWarnings:   [],
  };
}

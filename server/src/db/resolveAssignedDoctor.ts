import type { QueryRunner } from './patientPersons';

export interface AssignmentWarning { code: string; message: string; }
export interface ResolveAssignedDoctorResult {
  assignedDoctorUserId: string | null;
  assignedDoctorName:   string | null;
  assignmentWarnings:   AssignmentWarning[];
}

/**
 * Resolves the assigned doctor (id + name) for a patient being created or upserted.
 *
 * Policy:
 * - requestedDoctorName present, matches exactly 1 org doctor → use that doctor.
 * - requestedDoctorName present, matches 0 or 2+ → null + warning (no fallback).
 * - requestedDoctorName absent → currentUser if they are a doctor, else null.
 */
export async function resolveAssignedDoctor(
  qr: QueryRunner,
  { orgId, currentUser, requestedDoctorName }: {
    orgId:               string;
    currentUser:         { id: string; role: string; name?: string };
    requestedDoctorName: string | null;
  }
): Promise<ResolveAssignedDoctorResult> {
  if (requestedDoctorName) {
    const { rows } = await qr.query<{ id: string; name: string }>(
      `SELECT id, name FROM users
       WHERE organization_id = $1 AND name = $2 AND role = 'doctor' AND disabled_at IS NULL`,
      [orgId, requestedDoctorName]
    );
    if (rows.length === 1) {
      return { assignedDoctorUserId: rows[0].id, assignedDoctorName: rows[0].name, assignmentWarnings: [] };
    }
    const code    = rows.length > 1 ? 'DOCTOR_NAME_AMBIGUOUS' : 'DOCTOR_NAME_NOT_MATCHED';
    const message = rows.length > 1
      ? `'${requestedDoctorName}': 동명이인 의사가 있어 자동 배정을 건너뜁니다.`
      : `'${requestedDoctorName}': 해당 이름의 의사 계정이 없어 자동 배정을 건너뜁니다.`;
    return { assignedDoctorUserId: null, assignedDoctorName: null, assignmentWarnings: [{ code, message }] };
  }

  if (currentUser.role === 'doctor') {
    return {
      assignedDoctorUserId: currentUser.id,
      assignedDoctorName:   currentUser.name ?? null,
      assignmentWarnings:   [],
    };
  }
  return { assignedDoctorUserId: null, assignedDoctorName: null, assignmentWarnings: [] };
}

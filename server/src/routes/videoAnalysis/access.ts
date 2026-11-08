// Video analysis access checks (patient, clip, job) and the job response shape.
// Split out of routes/videoAnalysis.ts (S5 P1-30); handler bodies unchanged.
import type { Response } from 'express';
import type { Pool } from 'pg';
import { AnalysisRecipeSchema, buildAnalysisBundleVersion } from '@wr/contracts';
import type { AnalysisRecipe } from '@wr/contracts';
import { isAssignedOrAdmin } from '../../db/patientLocks';
import type { SessionInfo } from '../../http/authz';

// 담당의/admin 판정은 db/patientLocks.ts isAssignedOrAdmin 하나(S4 / P1-17). orgId null(superadmin
// context)은 라우트의 requireOrg()가 먼저 403으로 거부한다.
//
// patientId(서버 patient_records.id) 기반 접근 확인. 미존재/타org → 404(존재 누설 방지).
export async function loadAccessiblePatient(
  pool: Pool, session: SessionInfo, orgId: string, patientId: string, res: Response
): Promise<{ id: string } | null> {
  const { rows } = await pool.query<{ id: string; assigned_doctor_user_id: string | null }>(
    `SELECT id, assigned_doctor_user_id FROM patient_records
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [patientId, orgId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    return null;
  }
  if (!isAssignedOrAdmin(session, rows[0].assigned_doctor_user_id)) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    return null;
  }
  return { id: rows[0].id };
}

interface ClipCtx {
  clipId: string; patientRecordId: string; organizationId: string; processId: string | null;
  uploadPath: string | null; sampleDetectResult: unknown; targetPersonId: string | null;
  sourceType: string; fileState: string; sampleFramePath: string | null;
}
// clipId → clip + 소속 환자 권한 확인. job-scoped guard의 clip 버전.
export async function loadAccessibleClip(
  pool: Pool, session: SessionInfo, orgId: string, clipId: string, res: Response
): Promise<ClipCtx | null> {
  const { rows } = await pool.query<{
    id: string; patient_record_id: string; organization_id: string; assigned_doctor_user_id: string | null;
    process_id: string | null; upload_path: string | null; sample_detect_result: unknown; target_person_id: string | null;
    source_type: string; file_state: string; sample_frame_path: string | null;
  }>(
    `SELECT c.id, c.patient_record_id, c.organization_id, p.assigned_doctor_user_id,
            c.process_id, c.upload_path, c.sample_detect_result, c.target_person_id,
            c.source_type, c.file_state, c.sample_frame_path
     FROM video_analysis_clips c
     JOIN patient_records p ON p.id = c.patient_record_id AND p.deleted_at IS NULL
     WHERE c.id = $1 AND c.organization_id = $2`,
    [clipId, orgId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'CLIP_NOT_FOUND', error: 'Clip not found' });
    return null;
  }
  if (!isAssignedOrAdmin(session, rows[0].assigned_doctor_user_id)) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    return null;
  }
  return {
    clipId: rows[0].id, patientRecordId: rows[0].patient_record_id, organizationId: rows[0].organization_id,
    processId: rows[0].process_id,
    uploadPath: rows[0].upload_path, sampleDetectResult: rows[0].sample_detect_result, targetPersonId: rows[0].target_person_id,
    sourceType: rows[0].source_type, fileState: rows[0].file_state, sampleFramePath: rows[0].sample_frame_path,
  };
}

// jobId → job + 소속 환자 권한 확인. (FOR UPDATE 없는 일반 조회용.)
export async function loadAccessibleJob(
  pool: Pool, session: SessionInfo, orgId: string, jobId: string, res: Response
): Promise<{ row: VideoJobRow } | null> {
  const { rows } = await pool.query<VideoJobRow & { assigned_doctor_user_id: string | null }>(
    `SELECT j.*, p.assigned_doctor_user_id
     FROM video_analysis_jobs j
     JOIN patient_records p ON p.id = j.patient_record_id AND p.deleted_at IS NULL
     WHERE j.id = $1 AND j.organization_id = $2`,
    [jobId, orgId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
    return null;
  }
  if (!isAssignedOrAdmin(session, rows[0].assigned_doctor_user_id)) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    return null;
  }
  return { row: rows[0] };
}

export interface VideoJobRow {
  id: string;
  organization_id: string;
  patient_record_id: string;
  clip_id: string;
  process_id: string | null;
  status: string;
  analysis_profile: string | null;
  requested_features: unknown;
  result_features: unknown;
  analysis_recipe: unknown; // recipe versioning(§8.11) — 워커가 저장. apply 검증의 서버 source of truth.
  error_code: string | null;
  inference_device_used: string | null;        // 6.0-12: 실제 실행 디바이스(cpu|cuda) — 검토 UI 배지.
  inference_device_fallback: boolean | null;    // auto에서 cuda→cpu 폴백 여부.
  inference_device_fallback_reason: string | null;
  applied_at: Date | null;
  applied_revision: number | null;
  applied_inputs_hash: string | null;
  keypoints_path: string | null;
  keypoints_sha256: string | null;
  frames_path: string | null;
  created_at: Date;
  updated_at: Date;
}

// 저장된 analysis_recipe(JSONB, 신뢰 경계 밖이 아니라 서버 자작이지만 형태 방어)를 파싱한다.
// 구 job(recipe 없음)이면 null. 형식 불량이면 null(클라가 recipe 없이 폴백 경로 — apply에서 차단).
export function parseStoredRecipe(raw: unknown): AnalysisRecipe | null {
  if (raw == null) return null;
  const parsed = AnalysisRecipeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// 환자 data에서 appliedInputs 배열을 안전하게 읽는다(recipe 검증 suffix diff용). 없으면 [].
export function readAppliedInputs(payloadData: unknown): unknown[] {
  const va = (payloadData as { shared?: { videoAnalysis?: { appliedInputs?: unknown } } } | null | undefined)?.shared?.videoAnalysis;
  const arr = va?.appliedInputs;
  return Array.isArray(arr) ? arr : [];
}

export function jobResponse(row: VideoJobRow): Record<string, unknown> {
  const recipe = parseStoredRecipe(row.analysis_recipe);
  return {
    jobId: row.id,
    clipId: row.clip_id,
    processId: row.process_id,
    status: row.status,
    analysisProfile: row.analysis_profile,
    requestedFeatures: row.requested_features ?? [],
    // 워커가 ClipFeatureSetSchema 검증 후 저장한 intrinsic clipFeatures(있으면). per-day 환산은 클라.
    resultFeatures: row.result_features ?? null,
    // recipe versioning(§8.11) — 서버-기원 component. 클라는 이를 받아 map/vp(클라 상수)와 합쳐 appliedInputs에 기록.
    recipe: recipe ?? null,
    analysisBundleVersion: recipe ? buildAnalysisBundleVersion(recipe) : null,
    errorCode: row.error_code ?? null,
    // 6.0-12: 실제 실행 디바이스·폴백(검토 UI 배지). 구 job은 컬럼 NULL → null로 내려감.
    inferenceDeviceUsed: row.inference_device_used ?? null,
    inferenceDeviceFallback: row.inference_device_fallback ?? null,
    inferenceDeviceFallbackReason: row.inference_device_fallback_reason ?? null,
    appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
    appliedRevision: row.applied_revision,
  };
}

import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import config from '../config';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { writeAuditLog } from '../middleware/audit';
import path from 'path';
import { SampleDetectResultSchema, PoseKeypointsSchema, AnalysisRecipeSchema, buildAnalysisBundleVersion } from '@wr/contracts';
import type { AnalysisRecipe } from '@wr/contracts';
import { resolveFixtureClip, resolveUploadedClipPath, resolveSampleFramePath, resolveKeypointsArtifactPath, resolveOverlayFramesDir, resolveOverlayFramePath } from '../workers/fixturePath';
import { runSampleDetect } from '../workers/sampleDetect';
import { buildUploadMiddleware, runMulter, sniffVideoMime, hashFile, safeUnlink } from '../workers/videoUpload';
import { validateAppliedRecipes } from '../workers/recipeValidation';
import type { RequestHandler as ExpressRequestHandler } from 'express';
import fs from 'fs';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// 작업 영상 인간공학 분석 — clip/job 라이프사이클 + apply(영속화) API (6.0-4, mock).
//
// M1(mock) 범위: 서버는 clip/job 상태머신·권한·audit·apply 멱등 영속화를 담당한다.
// feature 계산 자체는 클라이언트(generateMockFeatures)에서 수행하며, 적용 시 클라가
// 계산한 환자 data를 apply 엔드포인트로 보내 If-Match 동시성으로 저장한다.
// 실제 추론(서버측 feature 계산)은 M2(6.0-5/6.0-6)에서 이 셸에 끼워 넣는다.
// ---------------------------------------------------------------------------

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

const CreateClipBody = z.object({
  patientId: z.string().uuid(),
  // job-scope 집계는 특정 공정이 없어 null을 보낸다(컬럼도 nullable). null/undefined 모두 허용.
  processId: z.string().nullable().optional(),
  // clip 출처 명시(M3-7a): analysis_upload(실 업로드 대기) | apply_shell(추론 없는 적용 셸) | fixture(dev).
  purpose: z.enum(['analysis_upload', 'apply_shell', 'fixture']),
  // dev-only fixture 입력(fixtureMode일 때만). 여기서 resolve→upload_path 저장(sample-detect가 그 전 단계, PR D2b).
  fixtureClipName: z.string().optional(),
}).superRefine((v, ctx) => {
  // purpose↔fixtureClipName 조합 강제(잘못된 조합 차단).
  if (v.purpose === 'fixture' && !v.fixtureClipName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fixture purpose requires fixtureClipName', path: ['fixtureClipName'] });
  }
  if (v.purpose !== 'fixture' && v.fixtureClipName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fixtureClipName is only allowed with fixture purpose', path: ['fixtureClipName'] });
  }
});
const SelectTargetBody = z.object({ targetPersonId: z.string().min(1) });
const CreateJobBody = z.object({
  clipId: z.string().uuid(),
  // job-scope 집계 제안은 process_id 없이 null로 들어온다(여러 공정 집계, 추적은 appliedInputs.processIds).
  processId: z.string().nullable().optional(),
  analysisProfile: z.string().nullable().optional(),
  requestedFeatures: z.array(z.string()).optional(),
  // fixtureClipName은 createClip으로 이관(PR D2b) — 큐 결정은 clip.upload_path로 일원화.
});
// apply: 클라가 applyFeatureToModule로 계산한 환자 data + 멱등 해시.
const ApplyBody = z.object({
  data: z.object({}).passthrough(),
  appliedInputsHash: z.string().min(1),
  appliedInputsCount: z.number().int().nonnegative().optional(),
  // 이 적용이 소비한 원본 분석 job id(추론 출처 추적·consumed 전이). 셸 적용 job과 구분(PR D1).
  sourceAnalysisJobIds: z.array(z.string().uuid()).default([]),
});

interface SessionInfo {
  userId: string;
  organizationId: string | null;
  role: string;
  name?: string;
}

// 담당의/admin 확인(공통). orgId null(superadmin context)이거나 미존재면 거부.
function canAccess(session: SessionInfo, assignedDoctorUserId: string | null): boolean {
  return session.role === 'admin' || assignedDoctorUserId === session.userId;
}

// patientId(서버 patient_records.id) 기반 접근 확인. 미존재/타org → 404(존재 누설 방지).
async function loadAccessiblePatient(
  pool: Pool, session: SessionInfo, patientId: string, res: Response
): Promise<{ id: string } | null> {
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return null;
  }
  const { rows } = await pool.query<{ id: string; assigned_doctor_user_id: string | null }>(
    `SELECT id, assigned_doctor_user_id FROM patient_records
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [patientId, session.organizationId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    return null;
  }
  if (!canAccess(session, rows[0].assigned_doctor_user_id)) {
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
async function loadAccessibleClip(
  pool: Pool, session: SessionInfo, clipId: string, res: Response
): Promise<ClipCtx | null> {
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return null;
  }
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
    [clipId, session.organizationId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'CLIP_NOT_FOUND', error: 'Clip not found' });
    return null;
  }
  if (!canAccess(session, rows[0].assigned_doctor_user_id)) {
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
async function loadAccessibleJob(
  pool: Pool, session: SessionInfo, jobId: string, res: Response
): Promise<{ row: VideoJobRow } | null> {
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return null;
  }
  const { rows } = await pool.query<VideoJobRow & { assigned_doctor_user_id: string | null }>(
    `SELECT j.*, p.assigned_doctor_user_id
     FROM video_analysis_jobs j
     JOIN patient_records p ON p.id = j.patient_record_id AND p.deleted_at IS NULL
     WHERE j.id = $1 AND j.organization_id = $2`,
    [jobId, session.organizationId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
    return null;
  }
  if (!canAccess(session, rows[0].assigned_doctor_user_id)) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    return null;
  }
  return { row: rows[0] };
}

interface VideoJobRow {
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
function parseStoredRecipe(raw: unknown): AnalysisRecipe | null {
  if (raw == null) return null;
  const parsed = AnalysisRecipeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// 환자 data에서 appliedInputs 배열을 안전하게 읽는다(recipe 검증 suffix diff용). 없으면 [].
function readAppliedInputs(payloadData: unknown): unknown[] {
  const va = (payloadData as { shared?: { videoAnalysis?: { appliedInputs?: unknown } } } | null | undefined)?.shared?.videoAnalysis;
  const arr = va?.appliedInputs;
  return Array.isArray(arr) ? arr : [];
}

function jobResponse(row: VideoJobRow): Record<string, unknown> {
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
    appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
    appliedRevision: row.applied_revision,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createClip(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  // purpose 누락은 임시 추론하지 않고 명시 거부(배포 중 혼선 차단).
  if (req.body == null || (req.body as { purpose?: unknown }).purpose === undefined) {
    res.status(400).json({ code: 'MISSING_PURPOSE', error: 'purpose is required (analysis_upload | apply_shell | fixture)' });
    return;
  }
  const parse = CreateClipBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const patient = await loadAccessiblePatient(pool, session, parse.data.patientId, res);
  if (!patient) return;

  // purpose → source_type / file_state / upload_path 결정.
  let sourceType: 'fixture' | 'upload' | 'apply_shell';
  let fileState: 'none' | 'present';
  let uploadPath: string | null = null;
  if (parse.data.purpose === 'fixture') {
    // dev 전용: fixtureMode 꺼져 있으면 거부(운영에서 stale fixture clip 생성 방지).
    if (!config.video.fixtureMode) {
      res.status(409).json({ code: 'FIXTURE_MODE_OFF', error: 'fixture clips require fixture mode (dev only)' });
      return;
    }
    uploadPath = resolveFixtureClip(parse.data.fixtureClipName as string, config.video.fixtureDir);
    if (!uploadPath) {
      res.status(400).json({ code: 'INVALID_FIXTURE', error: 'fixtureClipName is not an allowlisted fixture clip' });
      return;
    }
    sourceType = 'fixture';
    fileState = 'present';
  } else if (parse.data.purpose === 'analysis_upload') {
    sourceType = 'upload';
    fileState = 'none';
  } else {
    sourceType = 'apply_shell';
    fileState = 'none';
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO video_analysis_clips (organization_id, patient_record_id, process_id, upload_path, source_type, file_state)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [session.organizationId, patient.id, parse.data.processId ?? null, uploadPath, sourceType, fileState]
  );
  res.status(201).json({ clipId: rows[0].id });
}

// 실 영상 업로드(M3-7a). 사전 권한·상태 검사 → multer 스트리밍 → 확장자/MIME/hash 검증 → atomic rename → 짧은 단일 UPDATE.
async function uploadClip(pool: Pool, uploadMw: ExpressRequestHandler, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;

  // ① 수신 전 사전 검사: 권한 없는/업로드 대상 아닌/이미 업로드된 clip에 최대 maxUploadBytes를
  //    디스크/대역폭으로 받지 않도록 multer 이전에 차단. (수신 후 경쟁은 ④ 짧은 UPDATE가 재차 막는다.)
  const pre = await loadAccessibleClip(pool, session, req.params.clipId, res);
  if (!pre) return; // loadAccessibleClip이 이미 응답.
  if (pre.sourceType !== 'upload') {
    res.status(400).json({ code: 'CLIP_NOT_UPLOAD_TARGET', error: 'this clip does not accept uploads' });
    return;
  }
  if (pre.fileState !== 'none' || pre.uploadPath) {
    res.status(409).json({ code: 'CLIP_ALREADY_UPLOADED', error: 'clip already has an uploaded file' });
    return;
  }

  // ② multer 수신(tmp 스트리밍). 크기 초과는 413, 그 외 multer 계열 오류(잘못된 필드·개수 초과 등)는 400.
  try {
    await runMulter(uploadMw, req, res);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ code: 'FILE_TOO_LARGE', error: 'uploaded file exceeds the size limit' });
      return;
    }
    // MulterError는 모두 code가 'LIMIT_*'. 클라 요청 문제이므로 400(라우트 wrapper의 500 방지).
    if (typeof code === 'string' && code.startsWith('LIMIT_')) {
      res.status(400).json({ code: 'INVALID_UPLOAD', error: 'invalid upload request' });
      return;
    }
    throw err;
  }
  const file = (req as Request & { file?: { path: string; originalname?: string } }).file;
  const tmpPath = file?.path;
  let finalPath: string | null = null; // DB 반영 성공 전 예외 시 정리 대상.
  try {
    if (!tmpPath) {
      res.status(400).json({ code: 'NO_FILE', error: 'no file field "file" in upload' });
      return;
    }
    const clip = pre;

    // ③ 원본 파일명 확장자 allowlist(1차) + 매직바이트 sniffing(2차, 확장자 위조 차단).
    const ext = path.extname(file.originalname || '').replace('.', '').toLowerCase();
    if (!ext || !config.video.allowedExtensions.includes(ext)) {
      res.status(400).json({ code: 'INVALID_MEDIA_TYPE', error: 'file extension is not allowed' });
      return;
    }
    const mime = await sniffVideoMime(tmpPath);
    if (!mime || !config.video.allowedMimeTypes.includes(mime)) {
      res.status(400).json({ code: 'INVALID_MEDIA_TYPE', error: 'file is not an allowed video type' });
      return;
    }
    const sha256 = await hashFile(tmpPath);

    // 최종 경로로 atomic rename(uploadDir 하위; 워커가 resolveUploadedClipPath로 재검증).
    const uploadDir = config.video.uploadDir as string;
    finalPath = path.join(uploadDir, `${clip.clipId}-${crypto.randomUUID()}.bin`);
    await fs.promises.rename(tmpPath, finalPath);

    // 짧은 단일 UPDATE — 목적+상태 동시 검증으로 경쟁 업로드 한쪽만 성공(긴 트랜잭션 회피).
    const result = await pool.query(
      `UPDATE video_analysis_clips
         SET upload_path = $2, original_sha256 = $3, file_state = 'present',
             expires_at = now() + make_interval(hours => $4)
       WHERE id = $1 AND source_type = 'upload' AND file_state = 'none' AND upload_path IS NULL`,
      [clip.clipId, finalPath, sha256, config.video.clipTtlHours]
    );
    if (result.rowCount === 0) {
      await safeUnlink(finalPath);
      finalPath = null; // 정리 완료 — finally 중복 unlink 방지.
      res.status(409).json({ code: 'CLIP_ALREADY_UPLOADED', error: 'clip already has an uploaded file' });
      return;
    }
    finalPath = null; // DB 반영 성공 — 파일은 유지(finally 정리 대상 아님).

    void writeAuditLog(pool, {
      actorUserId: session.userId, actorOrgId: session.organizationId,
      action: 'video_analysis_upload', targetType: 'patient', targetId: clip.patientRecordId,
      outcome: 'success', ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
      extra: { clipId: clip.clipId, sha256 },
    });
    res.status(200).json({ clipId: clip.clipId, sha256 });
  } finally {
    // 검증 실패/예외로 최종 rename까지 못 간 tmp 잔여물 정리(rename 성공 시 tmp는 이미 없음).
    if (tmpPath && fs.existsSync(tmpPath)) await safeUnlink(tmpPath);
    // DB 반영 성공 전 예외(예: UPDATE 장애)로 남은 최종 파일 정리 — orphan 방지.
    // 성공/경쟁 경로에서는 finalPath=null로 비워 두므로 여기서 지우지 않는다.
    if (finalPath) await safeUnlink(finalPath);
  }
}

// 대표 프레임 썸네일은 DB 신뢰 경계 밖 경로 → resolveSampleFramePath 통과한 것만 unlink(uploadDir 밖 삭제 방지).
async function unlinkSampleFrameSafe(p: string | null | undefined, clipId: string): Promise<void> {
  if (!p) return;
  const real = resolveSampleFramePath(p, clipId, config.video.uploadDir);
  if (real) await safeUnlink(real);
}

// sample-detect (§8.7). 대표 프레임 person box 후보를 실제 탐지. 실 업로드(M3-7a) + dev fixture 지원.
async function sampleDetect(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const clip = await loadAccessibleClip(pool, session, req.params.clipId, res);
  if (!clip) return;

  // 출처/파일상태 guard로 분석 가능한 clip만 통과 + 신뢰 경계 밖 경로 재검증.
  let clipPath: string | null = null;
  if (clip.sourceType === 'fixture') {
    if (!config.video.fixtureMode) {
      res.status(409).json({ code: 'FIXTURE_MODE_OFF', error: 'fixture clips require fixture mode (dev only)' });
      return;
    }
    // DB upload_path는 신뢰 경계 밖 → basename을 allowlist 안에서 재검증(심층방어).
    clipPath = clip.uploadPath ? resolveFixtureClip(path.basename(clip.uploadPath), config.video.fixtureDir) : null;
  } else if (clip.sourceType === 'upload') {
    if (clip.fileState === 'none') {
      res.status(409).json({ code: 'NO_UPLOAD', error: 'upload the clip before running sample-detect' });
      return;
    }
    if (clip.fileState !== 'present') {
      res.status(409).json({ code: 'SAMPLE_DETECT_UNAVAILABLE', error: 'clip source is no longer available' });
      return;
    }
    clipPath = resolveUploadedClipPath(clip.uploadPath, config.video.uploadDir);
  }
  if (!clipPath) {
    res.status(409).json({ code: 'SAMPLE_DETECT_UNAVAILABLE', error: 'sample-detect is not available for this clip' });
    return;
  }

  // 정책 예외(VIDEO_ANALYSIS_TARGET_THUMBNAIL): 대표 프레임 썸네일 생성. 매 탐지 고유 버전 파일명
  // (기존 최종을 덮지 않음 → DB update 실패해도 직전 성공본·결과 정합 보존).
  const thumbEnabled = config.video.targetThumbnail && !!config.video.uploadDir;
  const newFramePath = thumbEnabled
    ? path.join(config.video.uploadDir as string, 'artifacts', `${clip.clipId}.${crypto.randomUUID()}.thumb.jpg`)
    : null;

  // 깨진 출력(JSON/계약 검증 실패)은 일반 500이 아니라 INVALID_SAMPLE_DETECT 명시 응답(502).
  // timeout/크래시 등 그 외 오류는 rethrow → wrap이 일반 500 처리.
  let result;
  try {
    result = await runSampleDetect(clipPath, newFramePath ? { thumbnailPath: newFramePath } : {});
  } catch (err) {
    // 실패 → 이번 실행 새 썸네일만 정리(옛 파일·DB는 불변).
    await unlinkSampleFrameSafe(newFramePath, clip.clipId);
    if ((err as { code?: string })?.code === 'INVALID_SAMPLE_DETECT') {
      res.status(502).json({ code: 'INVALID_SAMPLE_DETECT', error: 'sample-detect produced an invalid result' });
      return;
    }
    throw err;
  }

  // 썸네일이 실제 생성됐는지(부가기능 실패 허용 → 없으면 sample_frame_path=null로 본기능만 저장).
  const framePath = newFramePath && fs.existsSync(newFramePath) ? newFramePath : null;
  try {
    await pool.query(
      `UPDATE video_analysis_clips SET sample_detect_result = $2, sample_frame_path = $3 WHERE id = $1`,
      [clip.clipId, JSON.stringify(result), framePath]
    );
  } catch (err) {
    await unlinkSampleFrameSafe(framePath, clip.clipId); // DB 실패 → 새 파일 정리(옛 파일 불변)
    throw err;
  }
  // DB 성공(DB-first) → 더 이상 참조 안 되는 옛 식별 썸네일 회수.
  await unlinkSampleFrameSafe(clip.sampleFramePath, clip.clipId);

  res.status(200).json(result);
}

async function selectTarget(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const parse = SelectTargetBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const clip = await loadAccessibleClip(pool, session, req.params.clipId, res);
  if (!clip) return;

  // sample-detect 선행 필수.
  if (clip.sampleDetectResult == null) {
    res.status(409).json({ code: 'NO_SAMPLE_DETECT', error: 'run sample-detect before selecting a target' });
    return;
  }
  // DB JSONB는 신뢰 경계 밖 → 계약 검증 후 후보 id 존재 확인(위조 거부).
  const detect = SampleDetectResultSchema.safeParse(clip.sampleDetectResult);
  if (!detect.success) {
    res.status(502).json({ code: 'INVALID_SAMPLE_DETECT', error: 'stored sample-detect result is invalid' });
    return;
  }
  if (!detect.data.persons.some((p) => p.id === parse.data.targetPersonId)) {
    res.status(400).json({ code: 'INVALID_TARGET', error: 'targetPersonId is not among sample-detect candidates' });
    return;
  }

  await pool.query(
    `UPDATE video_analysis_clips SET target_person_id = $2, sample_frame_path = NULL WHERE id = $1`,
    [clip.clipId, parse.data.targetPersonId]
  );
  // 선택 완료 → 대표 프레임 썸네일은 더 이상 불필요(식별 이미지) → DB-first 후 파일 회수.
  await unlinkSampleFrameSafe(clip.sampleFramePath, clip.clipId);
  res.status(200).json({ ok: true, clipId: clip.clipId, targetPersonId: parse.data.targetPersonId });
}

// 대상자 선택용 대표 프레임 썸네일 스트리밍(정책 예외). sample_frame_path가 있고 전용 검증 통과 시 image/jpeg.
async function getSampleFrame(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  // opt-in 불변식: 게이트가 꺼지면 DB에 과거 sample_frame_path가 남아 있어도 노출 금지(404).
  if (!config.video.targetThumbnail) {
    const clip = await loadAccessibleClip(pool, session, req.params.clipId, res); // 권한 우선 적용(존재 누설 방지)
    if (!clip) return;
    res.status(404).json({ code: 'SAMPLE_FRAME_NOT_FOUND', error: 'No sample frame for this clip' });
    return;
  }
  const clip = await loadAccessibleClip(pool, session, req.params.clipId, res);
  if (!clip) return;
  const framePath = resolveSampleFramePath(clip.sampleFramePath, clip.clipId, config.video.uploadDir);
  if (!framePath) {
    res.status(404).json({ code: 'SAMPLE_FRAME_NOT_FOUND', error: 'No sample frame for this clip' });
    return;
  }
  // 식별 가능 이미지 → 캐시/스니핑 차단. objectURL 전용.
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(framePath).on('error', () => {
    if (!res.headersSent) res.status(404).json({ code: 'SAMPLE_FRAME_NOT_FOUND', error: 'No sample frame for this clip' });
  }).pipe(res);
}

async function createJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const parse = CreateJobBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  // patient_record_id/organization_id는 클라 body가 아니라 clip 조회로 채운다(denormalize 무결성).
  const clip = await loadAccessibleClip(pool, session, parse.data.clipId, res);
  if (!clip) return;

  // process_id도 clip 저장값이 source of truth(D2b createClip이 저장). body가 다른 공정을 가리키면
  // p1 영상·target 분석이 p2 provenance로 새는 무결성 위반 → 거부. (clip.process_id null이면 body 폴백.)
  if (clip.processId != null && parse.data.processId != null && parse.data.processId !== clip.processId) {
    res.status(400).json({ code: 'PROCESS_MISMATCH', error: 'processId does not match the clip' });
    return;
  }
  const processId = clip.processId ?? parse.data.processId ?? null;

  // 큐 결정 guard(M3-7a): "파일 없는 clip이 분석 job으로 둔갑" 방지. source_type/file_state 명시 검증.
  //  - apply_shell → review_pending 셸(추론 없음, 적용 경로).
  //  - upload + file_state='none' → 업로드 미완료(409), 'deleted' → privacy_first 삭제 후 재분석 불가(409).
  //  - fixture는 dev 전용 → fixtureMode 꺼졌으면 큐 금지(운영 stale fixture 방지).
  //  - (fixture|upload) + present + upload_path → 'queued'(워커 실추론).
  let initialStatus: 'queued' | 'review_pending';
  if (clip.sourceType === 'apply_shell') {
    initialStatus = 'review_pending';
  } else {
    if (clip.sourceType === 'fixture' && !config.video.fixtureMode) {
      res.status(409).json({ code: 'FIXTURE_MODE_OFF', error: 'fixture clips require fixture mode (dev only)' });
      return;
    }
    if (clip.sourceType === 'upload' && clip.fileState === 'none') {
      res.status(409).json({ code: 'NO_UPLOAD', error: 'upload the clip before creating an analysis job' });
      return;
    }
    if (clip.sourceType === 'upload' && clip.fileState === 'deleted') {
      res.status(409).json({ code: 'SOURCE_DELETED_REUPLOAD_REQUIRED', error: 'source video was deleted; re-upload to re-analyze' });
      return;
    }
    if (clip.fileState !== 'present' || !clip.uploadPath) {
      res.status(409).json({ code: 'CLIP_NOT_ANALYZABLE', error: 'clip is not in an analyzable state' });
      return;
    }
    initialStatus = 'queued';
  }

  const { rows } = await pool.query<VideoJobRow>(
    `INSERT INTO video_analysis_jobs
       (organization_id, patient_record_id, clip_id, process_id, status, analysis_profile, requested_features)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      clip.organizationId, clip.patientRecordId, clip.clipId,
      processId,
      initialStatus,
      parse.data.analysisProfile ?? null,
      JSON.stringify(parse.data.requestedFeatures ?? []),
    ]
  );
  void writeAuditLog(pool, {
    actorUserId: session.userId, actorOrgId: session.organizationId,
    action: 'video_analysis_submit', targetType: 'patient', targetId: clip.patientRecordId,
    outcome: 'success', ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
    extra: { jobId: rows[0].id, clipId: clip.clipId },
  });
  res.status(201).json(jobResponse(rows[0]));
}

async function getJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const job = await loadAccessibleJob(pool, session, req.params.jobId, res);
  if (!job) return;
  res.status(200).json(jobResponse(job.row));
}

// keypoints artifact를 검수용 골격 overlay로 반환(6.0-8, §8.6.1). 원본 프레임 없이 좌표만 →
// 클라가 중립 배경 위 뼈대로 렌더. DB(keypoints_path/sha256)는 신뢰 경계 밖이므로 ① 전용 resolver로
// 경로 재검증 ② sha256 무결성 ③ PoseKeypointsSchema 계약 검증을 모두 통과한 것만 응답(raw stream 금지 —
// 변조/깨진 구조가 클라로 새지 않게). targetTrackId까지 함께 실어 UI가 payload만으로 그릴 수 있게 한다.
async function getOverlay(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const job = await loadAccessibleJob(pool, session, req.params.jobId, res);
  if (!job) return;

  const row = job.row;
  if (!row.keypoints_path) {
    res.status(404).json({ code: 'OVERLAY_NOT_AVAILABLE', error: 'No keypoints artifact for this job (review closed or not produced)' });
    return;
  }
  const artifactPath = resolveKeypointsArtifactPath(row.keypoints_path, row.id, config.video.uploadDir);
  if (!artifactPath) {
    res.status(404).json({ code: 'OVERLAY_NOT_AVAILABLE', error: 'No keypoints artifact for this job (review closed or not produced)' });
    return;
  }

  let raw: Buffer;
  try {
    raw = await fs.promises.readFile(artifactPath);
  } catch {
    res.status(404).json({ code: 'OVERLAY_NOT_AVAILABLE', error: 'No keypoints artifact for this job (review closed or not produced)' });
    return;
  }

  // ② 무결성: 워커는 keypoints 영속 시 sha256을 함께 기록(videoAnalysisWorker). sha 부재(path만 존재)는
  //    비정상(레거시/손상)으로 보고, 불일치는 변조로 보고 502. 유효 JSON 형태 변조는 schema로 못 잡으므로 1차 방어.
  if (!row.keypoints_sha256) {
    res.status(502).json({ code: 'INVALID_KEYPOINTS_ARTIFACT', error: 'keypoints artifact has no integrity hash' });
    return;
  }
  const actualSha = crypto.createHash('sha256').update(raw).digest('hex');
  if (actualSha !== row.keypoints_sha256) {
    res.status(502).json({ code: 'INVALID_KEYPOINTS_ARTIFACT', error: 'keypoints artifact integrity check failed' });
    return;
  }

  // ③ 계약 검증: 깨진/예상 밖 구조 차단.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(502).json({ code: 'INVALID_KEYPOINTS_ARTIFACT', error: 'keypoints artifact is not valid JSON' });
    return;
  }
  const keypoints = PoseKeypointsSchema.safeParse(parsed);
  if (!keypoints.success) {
    res.status(502).json({ code: 'INVALID_KEYPOINTS_ARTIFACT', error: 'keypoints artifact does not match contract' });
    return;
  }

  // 채택 track id(있으면) — result_features(intrinsic ClipFeatureSet).tracking.targetTrackId.
  const rf = row.result_features as { tracking?: { targetTrackId?: string | null } } | null;
  const targetTrackId = rf?.tracking?.targetTrackId ?? null;

  // 실 프레임 배경 가용 여부(privacy 게이트 예외): 게이트 on + frames_path + resolver까지 통과할 때만 true.
  // (DB에 경로 잔존하나 파일 삭제된 stale 상태에서 UI 라벨이 "실 영상"으로 잘못 뜨는 것 방지.)
  const framesAvailable = !!(config.video.overlayFrames && resolveOverlayFramesDir(row.frames_path, row.id, config.video.uploadDir));

  // 환자 pose 좌표 → 캐시/스니핑 차단(썸네일과 달리 좌표는 별도 게이트 불필요. 실 프레임은 overlay-frame 라우트가 게이트).
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).json({ jobId: row.id, clipId: row.clip_id, targetTrackId, framesAvailable, keypoints: keypoints.data });
}

// 골격 검수 overlay 실 프레임 스트리밍(privacy 정책 예외). 서빙 조건 = 게이트 on + DB frames_path + resolver 통과 셋 다.
// getSampleFrame 미러: 게이트 off거나 frames_path NULL(close-review 후 등)이면 orphan 디렉터리가 남아도 무조건 404.
async function getOverlayFrame(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const job = await loadAccessibleJob(pool, session, req.params.jobId, res); // 권한 우선(존재 누설 방지)
  if (!job) return;
  if (!config.video.overlayFrames) {
    res.status(404).json({ code: 'OVERLAY_FRAME_NOT_FOUND', error: 'No overlay frame for this job' });
    return;
  }
  // DB frames_path가 source of truth — NULL이면 파일이 남아 있어도 서빙 금지.
  const framePath = resolveOverlayFramePath(job.row.frames_path, job.row.id, req.params.frameIndex, config.video.uploadDir);
  if (!framePath) {
    res.status(404).json({ code: 'OVERLAY_FRAME_NOT_FOUND', error: 'No overlay frame for this job' });
    return;
  }
  // 식별 가능 이미지 → 캐시/스니핑 차단. objectURL 전용.
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(framePath).on('error', () => {
    if (!res.headersSent) res.status(404).json({ code: 'OVERLAY_FRAME_NOT_FOUND', error: 'No overlay frame for this job' });
  }).pipe(res);
}

// 검수 종료(6.0-8): 해당 job의 keypoints artifact를 즉시 회수해 식별 가능성을 줄인다. artifact는
// job당 1개(<jobId>.keypoints.json)라 job 단위로 좁혀 같은 clip의 다른 job 근거는 보존한다.
async function closeReview(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const job = await loadAccessibleJob(pool, session, req.params.jobId, res);
  if (!job) return;

  // 진행 중 job은 차단: worker가 아직 keypoints artifact를 쓸 수 있어 "종료 직후 재생성" 경합 발생.
  if (job.row.status === 'queued' || job.row.status === 'processing') {
    res.status(409).json({ code: 'JOB_NOT_READY', error: 'cannot close review while the job is still running' });
    return;
  }

  // DB-first: 먼저 참조를 끊고(미참조 → orphan sweep 안전망) 그 다음 파일 unlink.
  // keypoints·frames는 **독립 회수** — 부분 실패(예: keypoints는 이미 NULL·frames만 잔존)에도 둘 다 끊고 지운다.
  const { rows } = await pool.query<{ keypoints_path: string | null; frames_path: string | null }>(
    `UPDATE video_analysis_jobs SET keypoints_path = NULL, keypoints_sha256 = NULL, frames_path = NULL
     WHERE id = $1 AND (keypoints_path IS NOT NULL OR frames_path IS NOT NULL)
     RETURNING keypoints_path, frames_path`,
    [job.row.id]
  );
  const cleared = rows.length > 0;
  if (cleared) {
    if (rows[0].keypoints_path) {
      const real = resolveKeypointsArtifactPath(rows[0].keypoints_path, job.row.id, config.video.uploadDir);
      if (real) await safeUnlink(real);
    }
    if (rows[0].frames_path) {
      const dir = resolveOverlayFramesDir(rows[0].frames_path, job.row.id, config.video.uploadDir);
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  void writeAuditLog(pool, {
    actorUserId: session.userId, actorOrgId: session.organizationId,
    action: 'video_analysis_close_review', targetType: 'patient', targetId: job.row.patient_record_id,
    outcome: 'success', ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
    extra: { jobId: job.row.id, clipId: job.row.clip_id, cleared },
  });
  res.status(200).json({ ok: true, jobId: job.row.id, cleared });
}

// patient_records 행(부분) — apply에서 사용.
interface PatientRowLite { id: string; revision: number; payload: unknown; created_at: Date; updated_at: Date; }

function patientApplyResponse(row: PatientRowLite): Record<string, unknown> {
  const base = typeof row.payload === 'object' && row.payload !== null
    ? (row.payload as Record<string, unknown>) : {};
  return {
    ...base,
    id: row.id,
    updatedAt: row.updated_at.toISOString(),
    sync: {
      serverId: row.id,
      revision: row.revision,
      syncStatus: 'synced',
      lastSyncedAt: row.updated_at.toISOString(),
    },
  };
}

// POST /jobs/:jobId/apply — If-Match 필수. 트랜잭션 순서(§8.12, Codex):
// ① job+patient FOR UPDATE → ② applied_at+동일 hash면 idempotent 반환
// → ③ If-Match revision 검사 → ④ payload 갱신·revision+1·job done·audit.
async function applyJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const ifMatch = req.headers['if-match'];
  const expectedRevision = typeof ifMatch === 'string' && /^\d+$/.test(ifMatch) ? Number(ifMatch) : null;
  if (!ifMatch) {
    res.status(400).json({ code: 'IF_MATCH_REQUIRED', error: 'If-Match header with current revision is required' });
    return;
  }
  if (expectedRevision === null || expectedRevision < 1) {
    res.status(400).json({ code: 'INVALID_IF_MATCH', error: 'If-Match must be a positive integer revision' });
    return;
  }

  const parse = ApplyBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const { data, appliedInputsHash, appliedInputsCount, sourceAnalysisJobIds } = parse.data;

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // ① job FOR UPDATE + 권한
    const { rows: jobs } = await client.query<VideoJobRow & { assigned_doctor_user_id: string | null }>(
      `SELECT j.*, p.assigned_doctor_user_id
       FROM video_analysis_jobs j
       JOIN patient_records p ON p.id = j.patient_record_id AND p.deleted_at IS NULL
       WHERE j.id = $1 AND j.organization_id = $2
       FOR UPDATE OF j`,
      [req.params.jobId, session.organizationId]
    );
    if (jobs.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
      return;
    }
    const job = jobs[0];
    if (!canAccess(session, job.assigned_doctor_user_id)) {
      await client.query('ROLLBACK');
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
      return;
    }

    // ② 멱등: 이미 적용 + 동일 hash면 저장된(현재) 환자 상태를 그대로 반환.
    if (job.applied_at && job.applied_inputs_hash === appliedInputsHash) {
      const { rows: cur } = await client.query<PatientRowLite>(
        `SELECT id, revision, payload, created_at, updated_at FROM patient_records
         WHERE id = $1 AND organization_id = $2`,
        [job.patient_record_id, session.organizationId]
      );
      await client.query('COMMIT');
      if (cur.length === 0) { res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' }); return; }
      res.status(200).json({ idempotent: true, patient: patientApplyResponse(cur[0]) });
      return;
    }

    // 상태 조건: review_pending에서만 적용 가능(error/expired/cancelled/done 거부).
    if (job.status !== 'review_pending') {
      await client.query('ROLLBACK');
      res.status(409).json({ code: 'JOB_NOT_APPLIABLE', error: `Job is '${job.status}', expected 'review_pending'`, status: job.status });
      return;
    }

    // sourceAnalysisJobIds 검증: 위조/타org/stale id + 적용 셸 job·실패/만료·결과없는 job 차단.
    // "실제 결과를 낸 per-process 분석 job"만 provenance/audit에 들어가게 한다 — result_features 보유 +
    // process_id 보유(셸 job 제외) + status review_pending|done(같은 직업 다중 feature는 done 가능) +
    // 현재 적용 셸 job(job.id) 자신은 제외. 상태는 review_pending/done만 허용(consume은 review_pending만 전이).
    const uniqueSourceIds = [...new Set(sourceAnalysisJobIds)];
    // 같은 SELECT에서 저장 recipe도 가져온다(추가 쿼리 없이 recipe 검증의 source of truth 확보).
    const sourceRecipes = new Map<string, AnalysisRecipe | null>();
    if (uniqueSourceIds.length > 0) {
      const { rows: srcRows } = await client.query<{ id: string; analysis_recipe: unknown }>(
        `SELECT id, analysis_recipe FROM video_analysis_jobs
         WHERE id = ANY($1) AND organization_id = $2 AND patient_record_id = $3
           AND result_features IS NOT NULL AND process_id IS NOT NULL
           AND status IN ('review_pending','done') AND id <> $4`,
        [uniqueSourceIds, session.organizationId, job.patient_record_id, job.id]
      );
      if (srcRows.length !== uniqueSourceIds.length) {
        await client.query('ROLLBACK');
        res.status(400).json({ code: 'INVALID_SOURCE_JOB', error: 'sourceAnalysisJobIds must reference completed analysis jobs of this patient' });
        return;
      }
      for (const r of srcRows) sourceRecipes.set(r.id, parseStoredRecipe(r.analysis_recipe));
    }

    // ③ patient FOR UPDATE + revision(If-Match)
    const { rows: pats } = await client.query<PatientRowLite>(
      `SELECT id, revision, payload, created_at, updated_at FROM patient_records
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [job.patient_record_id, session.organizationId]
    );
    if (pats.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }
    if (pats[0].revision !== expectedRevision) {
      await client.query('ROLLBACK');
      res.status(409).json({ code: 'CONFLICT', error: 'Revision mismatch. Fetch the latest version before retrying.', currentRevision: pats[0].revision });
      return;
    }

    // ④ payload 갱신(클라가 계산한 data 영속화 — 영상 apply는 meta 컬럼 불변).
    const existingPayload = typeof pats[0].payload === 'object' && pats[0].payload !== null
      ? (pats[0].payload as Record<string, unknown>) : {};

    // recipe 검증 게이트(§8.11, 6.0-9) — payload 무수정, 대조만. 서버가 source of truth.
    // 새로 추가된 appliedInputs(suffix)만 검증: count·prefix 불변·exact-set·recipe field 대조·unverified fail-closed.
    const recipeFail = validateAppliedRecipes({
      oldAppliedInputs: readAppliedInputs((existingPayload as { data?: unknown }).data),
      newAppliedInputs: readAppliedInputs(data),
      appliedInputsCount,
      sourceAnalysisJobIds: uniqueSourceIds,
      sourceRecipes,
      allowUnverified: config.video.allowUnverifiedRecipe,
    });
    if (recipeFail) {
      await client.query('ROLLBACK');
      res.status(400).json(recipeFail);
      return;
    }

    const newPayload = { ...existingPayload, data };
    const newRevision = expectedRevision + 1;

    const { rows: updated } = await client.query<PatientRowLite>(
      `UPDATE patient_records SET payload = $3, revision = revision + 1
       WHERE id = $1 AND organization_id = $2 AND revision = $4 AND deleted_at IS NULL
       RETURNING id, revision, payload, created_at, updated_at`,
      [job.patient_record_id, session.organizationId, JSON.stringify(newPayload), expectedRevision]
    );
    if (updated.length === 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ code: 'CONFLICT', error: 'Concurrent modification detected. Please retry.' });
      return;
    }

    await client.query(
      `UPDATE video_analysis_jobs
       SET status = 'done', applied_at = now(), applied_revision = $2, applied_inputs_hash = $3
       WHERE id = $1`,
      [job.id, newRevision, appliedInputsHash]
    );

    // 적용에 소비된 원본 분석 job(review_pending)을 done(consumed)으로 전이 — payload "적용함" ↔ DB 상태 정합.
    // 동일 org·동일 환자의 review_pending만 대상(권한·교차참조 방지). TTL sweep은 review_pending 미대상.
    if (uniqueSourceIds.length > 0) {
      await client.query(
        `UPDATE video_analysis_jobs
         SET status = 'done', applied_at = now(), applied_revision = $4
         WHERE id = ANY($1) AND organization_id = $2 AND patient_record_id = $3 AND status = 'review_pending'`,
        [uniqueSourceIds, session.organizationId, job.patient_record_id, newRevision]
      );
    }

    await client.query('COMMIT');

    void writeAuditLog(pool, {
      actorUserId: session.userId, actorOrgId: session.organizationId,
      action: 'video_analysis_apply', targetType: 'patient', targetId: job.patient_record_id,
      outcome: 'success', ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
      extra: {
        jobId: job.id, clipId: job.clip_id, appliedInputsCount: appliedInputsCount ?? null,
        appliedRevision: newRevision,
        sourceAnalysisJobIds, // 실제 추론 출처 추적(셸 jobId와 구분)
      },
    });
    res.status(200).json({ patient: patientApplyResponse(updated[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
export function createVideoAnalysisRouter(pool: Pool): Router {
  const router = Router();
  const auth = createAuthMiddleware(pool);

  // 피처플래그 fail-closed: 비활성 시 전 라우트 404(존재 누설 방지, PATIENT_NOT_FOUND 관례 일치).
  const flagGuard: RequestHandler = (_req, res, next) => {
    if (!config.videoAnalysisEnabled) {
      res.status(404).json({ code: 'NOT_FOUND', error: 'Not found' });
      return;
    }
    next();
  };

  const wrap = (fn: (p: Pool, req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => fn(pool, req, res).catch(() => res.status(500).json(internalError()));

  router.use(flagGuard);

  router.post('/clips', auth, csrfMiddleware, wrap(createClip));
  // 실 영상 업로드(M3-7a). uploadDir 미설정 시 라우트 비활성(UPLOAD_DISABLED).
  const uploadMw = buildUploadMiddleware();
  if (uploadMw) {
    router.post('/clips/:clipId/upload', auth, csrfMiddleware,
      (req: Request, res: Response) => uploadClip(pool, uploadMw, req, res).catch(() => res.status(500).json(internalError())));
  } else {
    router.post('/clips/:clipId/upload', auth, csrfMiddleware,
      (_req: Request, res: Response) => res.status(503).json({ code: 'UPLOAD_DISABLED', error: 'video upload is not configured on this server' }));
  }
  router.post('/clips/:clipId/sample-detect', auth, csrfMiddleware, wrap(sampleDetect));
  router.get('/clips/:clipId/sample-frame', auth, wrap(getSampleFrame));
  router.post('/clips/:clipId/select-target', auth, csrfMiddleware, wrap(selectTarget));
  router.post('/jobs', auth, csrfMiddleware, wrap(createJob));
  router.get('/jobs/:jobId', auth, wrap(getJob));
  router.get('/jobs/:jobId/overlay', auth, wrap(getOverlay));
  router.get('/jobs/:jobId/overlay-frame/:frameIndex', auth, wrap(getOverlayFrame));
  router.post('/jobs/:jobId/apply', auth, csrfMiddleware, wrap(applyJob));
  router.post('/jobs/:jobId/close-review', auth, csrfMiddleware, wrap(closeReview));

  return router;
}

// Video analysis jobs: create, read, overlay frames, close review.
// Split out of routes/videoAnalysis.ts (S5 P1-30); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import config from '../../config';
import { writeAuditLog } from '../../middleware/audit';
import { PoseKeypointsSchema } from '@wr/contracts';
import { resolveKeypointsArtifactPath, resolveOverlayFramesDir, resolveOverlayFramePath } from '../../workers/fixturePath';
import { safeUnlink } from '../../workers/videoUpload';
import fs from 'fs';
import crypto from 'crypto';
import { orgIdOf, sessionOf } from '../../http/authz';
import { CreateJobBody } from './schemas';
import { loadAccessibleClip, loadAccessibleJob, VideoJobRow, jobResponse } from './access';

export async function createJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const parse = CreateJobBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  // patient_record_id/organization_id는 클라 body가 아니라 clip 조회로 채운다(denormalize 무결성).
  const clip = await loadAccessibleClip(pool, session, orgIdOf(req), parse.data.clipId, res);
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

export async function getJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const job = await loadAccessibleJob(pool, session, orgIdOf(req), req.params.jobId, res);
  if (!job) return;
  res.status(200).json(jobResponse(job.row));
}

// keypoints artifact를 검수용 골격 overlay로 반환(6.0-8, §8.6.1). 원본 프레임 없이 좌표만 →
// 클라가 중립 배경 위 뼈대로 렌더. DB(keypoints_path/sha256)는 신뢰 경계 밖이므로 ① 전용 resolver로
// 경로 재검증 ② sha256 무결성 ③ PoseKeypointsSchema 계약 검증을 모두 통과한 것만 응답(raw stream 금지 —
// 변조/깨진 구조가 클라로 새지 않게). targetTrackId까지 함께 실어 UI가 payload만으로 그릴 수 있게 한다.
export async function getOverlay(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const job = await loadAccessibleJob(pool, session, orgIdOf(req), req.params.jobId, res);
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
export async function getOverlayFrame(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const job = await loadAccessibleJob(pool, session, orgIdOf(req), req.params.jobId, res); // 권한 우선(존재 누설 방지)
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
export async function closeReview(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const job = await loadAccessibleJob(pool, session, orgIdOf(req), req.params.jobId, res);
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

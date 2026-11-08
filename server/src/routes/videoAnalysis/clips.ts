// Video analysis clips: create, sample detection, target selection, sample frame.
// Split out of routes/videoAnalysis.ts (S5 P1-30); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import config from '../../config';
import path from 'path';
import { SampleDetectResultSchema } from '@wr/contracts';
import { resolveFixtureClip, resolveUploadedClipPath, resolveSampleFramePath } from '../../workers/fixturePath';
import { runSampleDetect } from '../../workers/sampleDetect';
import { safeUnlink } from '../../workers/videoUpload';
import fs from 'fs';
import crypto from 'crypto';
import { orgIdOf, sessionOf } from '../../http/authz';
import { CreateClipBody, SelectTargetBody } from './schemas';
import { loadAccessiblePatient, loadAccessibleClip } from './access';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function createClip(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
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
  const patient = await loadAccessiblePatient(pool, session, orgIdOf(req), parse.data.patientId, res);
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


// 대표 프레임 썸네일은 DB 신뢰 경계 밖 경로 → resolveSampleFramePath 통과한 것만 unlink(uploadDir 밖 삭제 방지).
async function unlinkSampleFrameSafe(p: string | null | undefined, clipId: string): Promise<void> {
  if (!p) return;
  const real = resolveSampleFramePath(p, clipId, config.video.uploadDir);
  if (real) await safeUnlink(real);
}

// sample-detect (§8.7). 대표 프레임 person box 후보를 실제 탐지. 실 업로드(M3-7a) + dev fixture 지원.
export async function sampleDetect(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const clip = await loadAccessibleClip(pool, session, orgIdOf(req), req.params.clipId, res);
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

export async function selectTarget(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const parse = SelectTargetBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const clip = await loadAccessibleClip(pool, session, orgIdOf(req), req.params.clipId, res);
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
export async function getSampleFrame(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  // opt-in 불변식: 게이트가 꺼지면 DB에 과거 sample_frame_path가 남아 있어도 노출 금지(404).
  if (!config.video.targetThumbnail) {
    const clip = await loadAccessibleClip(pool, session, orgIdOf(req), req.params.clipId, res); // 권한 우선 적용(존재 누설 방지)
    if (!clip) return;
    res.status(404).json({ code: 'SAMPLE_FRAME_NOT_FOUND', error: 'No sample frame for this clip' });
    return;
  }
  const clip = await loadAccessibleClip(pool, session, orgIdOf(req), req.params.clipId, res);
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

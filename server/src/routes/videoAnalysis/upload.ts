// Video analysis clip upload (multer streaming, MIME/hash checks).
// Split out of routes/videoAnalysis.ts (S5 P1-30); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import config from '../../config';
import { writeAuditLog } from '../../middleware/audit';
import path from 'path';
import { runMulter, sniffVideoMime, hashFile, safeUnlink } from '../../workers/videoUpload';
import type { RequestHandler as ExpressRequestHandler } from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { orgIdOf, sessionOf } from '../../http/authz';
import { loadAccessibleClip } from './access';

// 실 영상 업로드(M3-7a). 사전 권한·상태 검사 → multer 스트리밍 → 확장자/MIME/hash 검증 → atomic rename → 짧은 단일 UPDATE.
export async function uploadClip(pool: Pool, uploadMw: ExpressRequestHandler, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);

  // ① 수신 전 사전 검사: 권한 없는/업로드 대상 아닌/이미 업로드된 clip에 최대 maxUploadBytes를
  //    디스크/대역폭으로 받지 않도록 multer 이전에 차단. (수신 후 경쟁은 ④ 짧은 UPDATE가 재차 막는다.)
  const pre = await loadAccessibleClip(pool, session, orgIdOf(req), req.params.clipId, res);
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

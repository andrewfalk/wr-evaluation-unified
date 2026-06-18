import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response, RequestHandler } from 'express';
import config from '../config';

// ---------------------------------------------------------------------------
// 실 영상 업로드 유틸(M3-7a). multipart 디스크 스트리밍 + 매직바이트 MIME sniffing + sha256.
// base64 금지(33% 부풀림·메모리 폭발) → multer diskStorage로 uploadDir/tmp에 스트리밍.
// file-type(ESM 전용)을 피하고 컨테이너 시그니처를 직접 검사(에어갭/CommonJS 친화).
// ---------------------------------------------------------------------------

/** uploadDir/tmp 경로(스트리밍 임시 보관). */
export function uploadTmpDir(uploadDir: string): string {
  return path.join(uploadDir, 'tmp');
}

/**
 * 업로드 multer 미들웨어를 구성. uploadDir 미설정이면 null(라우트가 UPLOAD_DISABLED 응답).
 * tmp로 먼저 스트리밍(락 없이) → 핸들러가 검증 후 최종 경로로 atomic rename.
 */
export function buildUploadMiddleware(): RequestHandler | null {
  const uploadDir = config.video.uploadDir;
  if (!uploadDir) return null;
  const tmp = uploadTmpDir(uploadDir);
  fs.mkdirSync(tmp, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmp),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  });
  return multer({ storage, limits: { fileSize: config.video.maxUploadBytes, files: 1 } }).single('file');
}

/** 미들웨어를 Promise로 실행(에러를 핸들러 try/catch로 받기 위함). */
export function runMulter(mw: RequestHandler, req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    mw(req, res, (err: unknown) => (err ? reject(err) : resolve()));
  });
}

/**
 * 컨테이너 매직바이트로 영상 MIME 추정. 알 수 없으면 null(확장자 위조 차단).
 *  - ISO BMFF(mp4/mov/m4v): offset 4..8 == 'ftyp'
 *  - Matroska/WebM: EBML 0x1A45DFA3
 *  - AVI: 'RIFF' .... 'AVI '
 */
export async function sniffVideoMime(filePath: string): Promise<string | null> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fd.read(buf, 0, 32, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
    if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'AVI ') return 'video/x-msvideo';
    return null;
  } finally {
    await fd.close();
  }
}

/** 파일 sha256(스트리밍). */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 조용한 unlink(존재 안 해도 무시). */
export async function safeUnlink(filePath: string | undefined | null): Promise<void> {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => {});
}

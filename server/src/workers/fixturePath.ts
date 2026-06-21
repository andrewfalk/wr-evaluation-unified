import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// fixture 영상 경로 보안 가드 (6.0-6b, PR D1). dev-only fixture 입력만 허용한다.
// allowlist 디렉터리(fixtureDir) 내부의 영상 파일만 통과 — path traversal(`..`)·절대경로·
// 심볼릭 링크 탈출·잘못된 확장자를 모두 차단(임의 파일 접근 방지, §8.13).
// ---------------------------------------------------------------------------

const ALLOWED_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

function insideDir(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * fixtureDir 내부의 fixture 영상 절대경로를 반환. 검증 실패 시 null.
 * @param name      클라가 보낸 클립명(basename 기대). 경로 구분자/`..` 포함 시 거부.
 * @param fixtureDir allowlist 디렉터리(config.video.fixtureDir).
 */
export function resolveFixtureClip(name: unknown, fixtureDir: string): string | null {
  if (typeof name !== 'string' || name.trim() === '') return null;

  const dirResolved = path.resolve(fixtureDir);
  const resolved = path.resolve(dirResolved, name);
  // 1) 정규화 후 allowlist escape 차단(상대경로/`..`/절대경로 입력).
  if (!insideDir(dirResolved, resolved)) return null;
  // 2) 확장자 화이트리스트.
  if (!ALLOWED_EXT.has(path.extname(resolved).toLowerCase())) return null;

  // 3) realpath로 심볼릭 링크 탈출 차단 + 존재 확인. dir/target 모두 실경로로 비교.
  let realDir: string;
  let real: string;
  try {
    realDir = fs.realpathSync(dirResolved);
    real = fs.realpathSync(resolved);
  } catch {
    return null; // 존재하지 않음
  }
  if (!insideDir(realDir, real)) return null;

  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * 실 업로드 clip의 저장 절대경로를 심층방어 재검증. 검증 실패 시 null.
 * DB upload_path는 신뢰 경계 밖 → uploadDir 내부 + 심볼릭 링크 탈출 차단 + 파일 존재 확인.
 * @param uploadPath DB에 저장된 절대경로(업로드 endpoint가 uploadDir 하위에 기록).
 * @param uploadDir  허용 업로드 루트(config.video.uploadDir). 미설정이면 null.
 */
export function resolveUploadedClipPath(uploadPath: unknown, uploadDir: string | null): string | null {
  if (typeof uploadPath !== 'string' || uploadPath.trim() === '' || !uploadDir) return null;

  const dirResolved = path.resolve(uploadDir);
  const resolved = path.resolve(uploadPath);
  // 정규화 후 uploadDir escape 차단.
  if (!insideDir(dirResolved, resolved)) return null;

  // realpath로 심볼릭 링크 탈출 차단 + 존재 확인.
  let realDir: string;
  let real: string;
  try {
    realDir = fs.realpathSync(dirResolved);
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (!insideDir(realDir, real)) return null;

  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * keypoints artifact 경로 전용 검증(overlay 서빙·close-review 삭제 공용). DB(jobs.keypoints_path)는
 * 신뢰 경계 밖이므로 uploadDir/artifacts 하위 + basename이 정확히 `<jobId>.keypoints.json` + 존재 +
 * symlink 탈출 차단. 통과한 경로만 read/unlink 해야 원본 업로드·썸네일·uploadDir 밖 파일 오접근을 막는다.
 * @param p        DB 저장 경로(jobs.keypoints_path)
 * @param jobId    소유 job id(파일명 강제)
 * @param uploadDir config.video.uploadDir
 */
export function resolveKeypointsArtifactPath(p: unknown, jobId: string, uploadDir: string | null): string | null {
  if (typeof p !== 'string' || p.trim() === '' || !uploadDir || !jobId) return null;

  const artDir = path.resolve(uploadDir, 'artifacts');
  const resolved = path.resolve(p);
  if (!insideDir(artDir, resolved)) return null;

  // basename 엄격 검증: <jobId>.keypoints.json (worker가 기록하는 정확한 형식)
  if (path.basename(resolved) !== `${jobId}.keypoints.json`) return null;

  let realDir: string;
  let real: string;
  try {
    realDir = fs.realpathSync(artDir);
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (!insideDir(realDir, real)) return null;

  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

const FRAME_IDX_RE = /^\d+$/;

/**
 * overlay 실 프레임 **디렉터리** 경로 전용 검증(서빙·삭제·cleanup 공용). DB(jobs.frames_path)는 신뢰 경계 밖이므로
 * uploadDir/artifacts 하위 + basename이 정확히 `<jobId>.frames` + 존재(디렉터리) + symlink 탈출 차단.
 * DB 경로가 source of truth — 파일 존재만으로 서빙 금지(orphan 디렉터리 노출 차단).
 */
export function resolveOverlayFramesDir(p: unknown, jobId: string, uploadDir: string | null): string | null {
  if (typeof p !== 'string' || p.trim() === '' || !uploadDir || !jobId) return null;

  const artDir = path.resolve(uploadDir, 'artifacts');
  const resolved = path.resolve(p);
  if (!insideDir(artDir, resolved)) return null;
  if (path.basename(resolved) !== `${jobId}.frames`) return null;

  let realDir: string;
  let real: string;
  try {
    realDir = fs.realpathSync(artDir);
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (!insideDir(realDir, real)) return null;

  try {
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * overlay 실 프레임 **파일** 경로 전용 검증(서빙용). 디렉터리(resolveOverlayFramesDir) 통과 + 그 안의
 * `<frameIndex>.jpg`(frameIndex 비음 정수) + isFile + symlink 탈출 차단. 통과한 경로만 image 스트리밍.
 */
export function resolveOverlayFramePath(framesPathFromDb: unknown, jobId: string, frameIndex: unknown, uploadDir: string | null): string | null {
  const dir = resolveOverlayFramesDir(framesPathFromDb, jobId, uploadDir);
  if (!dir) return null;
  if (typeof frameIndex !== 'string' || !FRAME_IDX_RE.test(frameIndex)) return null;

  const resolved = path.resolve(dir, `${frameIndex}.jpg`);
  if (!insideDir(dir, resolved)) return null;

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (!insideDir(dir, real)) return null;

  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 대표 프레임 썸네일 경로 전용 검증(서빙·삭제 공용). DB(sample_frame_path)는 신뢰 경계 밖이므로
 * uploadDir/artifacts 하위 + basename이 정확히 `<clipId>.<uuid>.thumb.jpg`(uuid 엄격) + 존재 + symlink 탈출 차단.
 * 통과한 경로만 image 스트리밍/unlink 해야 원본 업로드·keypoints·uploadDir 밖 파일 오접근을 막는다.
 * @param p        DB 저장 경로
 * @param clipId   소유 clip id(파일명 prefix 일치 강제)
 * @param uploadDir config.video.uploadDir
 */
export function resolveSampleFramePath(p: unknown, clipId: string, uploadDir: string | null): string | null {
  if (typeof p !== 'string' || p.trim() === '' || !uploadDir || !clipId) return null;

  const artDir = path.resolve(uploadDir, 'artifacts');
  const resolved = path.resolve(p);
  if (!insideDir(artDir, resolved)) return null;

  // basename 엄격 검증: <clipId>.<uuid>.thumb.jpg
  const base = path.basename(resolved);
  const prefix = `${clipId}.`;
  const suffix = '.thumb.jpg';
  if (!base.startsWith(prefix) || !base.endsWith(suffix)) return null;
  const uuidPart = base.slice(prefix.length, base.length - suffix.length);
  if (!UUID_RE.test(uuidPart)) return null;

  let realDir: string;
  let real: string;
  try {
    realDir = fs.realpathSync(artDir);
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (!insideDir(realDir, real)) return null;

  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

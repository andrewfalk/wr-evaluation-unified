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

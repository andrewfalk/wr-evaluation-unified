import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveFixtureClip, resolveUploadedClipPath, resolveSampleFramePath } from '../fixturePath';

let dir: string;
let uploadDir: string;
const CLIP = '11111111-1111-1111-1111-111111111111';
const UUID = 'abcdef01-2345-6789-abcd-ef0123456789';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-test-'));
  fs.writeFileSync(path.join(dir, 'good.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'); // 잘못된 확장자
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-test-'));
  fs.writeFileSync(path.join(uploadDir, 'clip.bin'), 'x');
  fs.mkdirSync(path.join(uploadDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${CLIP}.${UUID}.thumb.jpg`), 'jpg');
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${CLIP}.keypoints.json`), '{}');
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${CLIP}.bad.thumb.jpg`), 'x'); // uuid 아님
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe('resolveFixtureClip', () => {
  it('allowlist 내부 영상 파일 → 실경로 반환', () => {
    expect(resolveFixtureClip('good.mp4', dir)).toBe(fs.realpathSync(path.join(dir, 'good.mp4')));
  });

  it('path traversal(../) → null', () => {
    expect(resolveFixtureClip('../good.mp4', dir)).toBeNull();
    expect(resolveFixtureClip('../../etc/passwd', dir)).toBeNull();
  });

  it('절대경로 입력 → null(allowlist escape)', () => {
    expect(resolveFixtureClip(path.join(dir, '..', 'good.mp4'), dir)).toBeNull();
    expect(resolveFixtureClip('/etc/hosts', dir)).toBeNull();
  });

  it('존재하지 않는 파일 → null', () => {
    expect(resolveFixtureClip('missing.mp4', dir)).toBeNull();
  });

  it('허용되지 않은 확장자 → null', () => {
    expect(resolveFixtureClip('notes.txt', dir)).toBeNull();
  });

  it('빈 값/비문자열 → null', () => {
    expect(resolveFixtureClip('', dir)).toBeNull();
    expect(resolveFixtureClip(undefined, dir)).toBeNull();
    expect(resolveFixtureClip(123, dir)).toBeNull();
  });
});

describe('resolveUploadedClipPath', () => {
  it('uploadDir 내부 파일 → 실경로 반환', () => {
    const p = path.join(uploadDir, 'clip.bin');
    expect(resolveUploadedClipPath(p, uploadDir)).toBe(fs.realpathSync(p));
  });

  it('uploadDir 밖 경로 → null(escape 차단)', () => {
    expect(resolveUploadedClipPath('/etc/hosts', uploadDir)).toBeNull();
    expect(resolveUploadedClipPath(path.join(uploadDir, '..', 'clip.bin'), uploadDir)).toBeNull();
  });

  it('존재하지 않는 파일 → null', () => {
    expect(resolveUploadedClipPath(path.join(uploadDir, 'missing.bin'), uploadDir)).toBeNull();
  });

  it('uploadDir 미설정(null) → null', () => {
    expect(resolveUploadedClipPath(path.join(uploadDir, 'clip.bin'), null)).toBeNull();
  });

  it('빈 값/비문자열 → null', () => {
    expect(resolveUploadedClipPath('', uploadDir)).toBeNull();
    expect(resolveUploadedClipPath(undefined, uploadDir)).toBeNull();
  });
});

describe('resolveSampleFramePath', () => {
  const art = (name: string) => path.join(uploadDir, 'artifacts', name);

  it('artifacts/<clipId>.<uuid>.thumb.jpg → 실경로 반환', () => {
    const p = art(`${CLIP}.${UUID}.thumb.jpg`);
    expect(resolveSampleFramePath(p, CLIP, uploadDir)).toBe(fs.realpathSync(p));
  });

  it('uuid 세그먼트가 아니면 → null(<clipId>.bad.thumb.jpg)', () => {
    expect(resolveSampleFramePath(art(`${CLIP}.bad.thumb.jpg`), CLIP, uploadDir)).toBeNull();
  });

  it('다른 clipId/타파일(keypoints·bin)·artifacts 밖 → null', () => {
    expect(resolveSampleFramePath(art(`${CLIP}.keypoints.json`), CLIP, uploadDir)).toBeNull();
    expect(resolveSampleFramePath(art(`22222222-2222-2222-2222-222222222222.${UUID}.thumb.jpg`), CLIP, uploadDir)).toBeNull(); // clipId 불일치
    expect(resolveSampleFramePath(path.join(uploadDir, 'clip.bin'), CLIP, uploadDir)).toBeNull(); // artifacts 밖
  });

  it('traversal·부재·uploadDir null → null', () => {
    expect(resolveSampleFramePath(art(`../${CLIP}.${UUID}.thumb.jpg`), CLIP, uploadDir)).toBeNull();
    expect(resolveSampleFramePath(art(`${CLIP}.ffffffff-ffff-ffff-ffff-ffffffffffff.thumb.jpg`), CLIP, uploadDir)).toBeNull(); // 부재
    expect(resolveSampleFramePath(art(`${CLIP}.${UUID}.thumb.jpg`), CLIP, null)).toBeNull();
  });
});

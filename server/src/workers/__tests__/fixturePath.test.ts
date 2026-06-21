import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveFixtureClip, resolveUploadedClipPath, resolveSampleFramePath, resolveKeypointsArtifactPath, resolveOverlayFramesDir, resolveOverlayFramePath } from '../fixturePath';

let dir: string;
let uploadDir: string;
const CLIP = '11111111-1111-1111-1111-111111111111';
const UUID = 'abcdef01-2345-6789-abcd-ef0123456789';
const JOB = '33333333-3333-3333-3333-333333333333';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-test-'));
  fs.writeFileSync(path.join(dir, 'good.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'); // 잘못된 확장자
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-test-'));
  fs.writeFileSync(path.join(uploadDir, 'clip.bin'), 'x');
  fs.mkdirSync(path.join(uploadDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${CLIP}.${UUID}.thumb.jpg`), 'jpg');
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${CLIP}.keypoints.json`), '{}');
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${JOB}.keypoints.json`), '{}');
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${CLIP}.bad.thumb.jpg`), 'x'); // uuid 아님
  // overlay 프레임 디렉터리(<JOB>.frames/<idx>.jpg)
  fs.mkdirSync(path.join(uploadDir, 'artifacts', `${JOB}.frames`), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${JOB}.frames`, '0.jpg'), 'jpg');
  fs.writeFileSync(path.join(uploadDir, 'artifacts', `${JOB}.frames`, '6.jpg'), 'jpg');
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

describe('resolveKeypointsArtifactPath', () => {
  const art = (name: string) => path.join(uploadDir, 'artifacts', name);

  it('artifacts/<jobId>.keypoints.json → 실경로 반환', () => {
    const p = art(`${JOB}.keypoints.json`);
    expect(resolveKeypointsArtifactPath(p, JOB, uploadDir)).toBe(fs.realpathSync(p));
  });

  it('다른 jobId/타파일(thumb)·artifacts 밖 → null', () => {
    expect(resolveKeypointsArtifactPath(art(`${CLIP}.keypoints.json`), JOB, uploadDir)).toBeNull(); // jobId 불일치
    expect(resolveKeypointsArtifactPath(art(`${CLIP}.${UUID}.thumb.jpg`), JOB, uploadDir)).toBeNull(); // 타파일
    expect(resolveKeypointsArtifactPath(path.join(uploadDir, 'clip.bin'), JOB, uploadDir)).toBeNull(); // artifacts 밖
  });

  it('traversal·부재·uploadDir null·빈값 → null', () => {
    expect(resolveKeypointsArtifactPath(art(`../${JOB}.keypoints.json`), JOB, uploadDir)).toBeNull();
    expect(resolveKeypointsArtifactPath(art(`44444444-4444-4444-4444-444444444444.keypoints.json`), '44444444-4444-4444-4444-444444444444', uploadDir)).toBeNull(); // 부재
    expect(resolveKeypointsArtifactPath(art(`${JOB}.keypoints.json`), JOB, null)).toBeNull();
    expect(resolveKeypointsArtifactPath('', JOB, uploadDir)).toBeNull();
    expect(resolveKeypointsArtifactPath(undefined, JOB, uploadDir)).toBeNull();
  });
});

describe('resolveOverlayFramesDir / resolveOverlayFramePath', () => {
  const framesDir = (j: string) => path.join(uploadDir, 'artifacts', `${j}.frames`);

  it('정상 디렉터리(<JOB>.frames) → 실경로', () => {
    expect(resolveOverlayFramesDir(framesDir(JOB), JOB, uploadDir)).toBe(fs.realpathSync(framesDir(JOB)));
  });
  it('정상 프레임 파일(<idx>.jpg) → 실경로', () => {
    const p = path.join(framesDir(JOB), '6.jpg');
    expect(resolveOverlayFramePath(framesDir(JOB), JOB, '6', uploadDir)).toBe(fs.realpathSync(p));
    expect(resolveOverlayFramePath(framesDir(JOB), JOB, '0', uploadDir)).not.toBeNull();
  });
  it('잘못된 frameIndex(비정수·traversal) → null', () => {
    expect(resolveOverlayFramePath(framesDir(JOB), JOB, '6.jpg', uploadDir)).toBeNull();
    expect(resolveOverlayFramePath(framesDir(JOB), JOB, '../6', uploadDir)).toBeNull();
    expect(resolveOverlayFramePath(framesDir(JOB), JOB, 'a', uploadDir)).toBeNull();
    expect(resolveOverlayFramePath(framesDir(JOB), JOB, '999', uploadDir)).toBeNull(); // 부재
  });
  it('jobId 불일치 / basename 불일치 / artifacts 밖 / 파일(디렉터리 아님) → null', () => {
    expect(resolveOverlayFramesDir(framesDir(JOB), CLIP, uploadDir)).toBeNull();         // jobId 불일치
    expect(resolveOverlayFramesDir(path.join(uploadDir, 'artifacts', `${JOB}.keypoints.json`), JOB, uploadDir)).toBeNull(); // 디렉터리 아님
    expect(resolveOverlayFramesDir(path.join(uploadDir, 'clip.bin'), JOB, uploadDir)).toBeNull(); // artifacts 밖
    expect(resolveOverlayFramesDir(framesDir(JOB), JOB, null)).toBeNull();
    expect(resolveOverlayFramesDir('', JOB, uploadDir)).toBeNull();
    // frames_path가 NULL/빈값이면 파일이 있어도 서빙 경로 산출 불가(DB source of truth).
    expect(resolveOverlayFramePath('', JOB, '0', uploadDir)).toBeNull();
  });
});

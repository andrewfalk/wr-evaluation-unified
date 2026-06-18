import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';

const cfg = vi.hoisted(() => ({ uploadDir: '' }));
vi.mock('../../config', () => ({ default: { video: { get uploadDir() { return cfg.uploadDir; } } } }));
// 썸네일 resolver: .thumb.jpg면 경로 통과(실 패턴/존재 검증은 fixturePath 단위테스트). unlink는 부재 시 no-op.
vi.mock('../../workers/fixturePath', () => ({
  resolveSampleFramePath: (p: unknown) => (typeof p === 'string' && p.endsWith('.thumb.jpg') ? p : null),
}));

import { runVideoClipCleanup } from '../videoClipCleanup';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cln-'));
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  cfg.uploadDir = dir;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// SQL 텍스트로 분기하는 query mock. expiredClips/staleArtifacts/referenced 셋을 주입.
function makePool(opts: {
  expiredClips?: { id: string; upload_path: string | null }[];
  staleArtifacts?: { id: string; keypoints_path: string | null }[];
  staleFrames?: { id: string; sample_frame_path: string | null }[];
  referencedClips?: { upload_path?: string | null; sample_frame_path?: string | null }[];
  referencedJobs?: string[];
} = {}): Pool {
  const query = vi.fn((sql: string) => {
    if (sql.includes('file_state = \'present\'') && sql.includes('SELECT id, upload_path')) {
      return Promise.resolve({ rows: opts.expiredClips ?? [] });
    }
    if (sql.includes('j.keypoints_path')) {
      return Promise.resolve({ rows: opts.staleArtifacts ?? [] });
    }
    if (sql.includes('SELECT id, sample_frame_path FROM video_analysis_clips')) {
      return Promise.resolve({ rows: opts.staleFrames ?? [] });
    }
    if (sql.includes('SELECT upload_path, sample_frame_path FROM video_analysis_clips')) {
      return Promise.resolve({ rows: opts.referencedClips ?? [] });
    }
    if (sql.includes('SELECT keypoints_path FROM video_analysis_jobs')) {
      return Promise.resolve({ rows: (opts.referencedJobs ?? []).map((p) => ({ keypoints_path: p })) });
    }
    return Promise.resolve({ rows: [] }); // UPDATEs
  });
  return { query } as unknown as Pool;
}

describe('runVideoClipCleanup', () => {
  it('TTL 만료 clip 원본 삭제 + file_state UPDATE (upload만 대상)', async () => {
    const orig = path.join(dir, 'expired.bin');
    fs.writeFileSync(orig, 'x');
    const pool = makePool({ expiredClips: [{ id: 'c1', upload_path: orig }], referencedClips: [] });
    const res = await runVideoClipCleanup(pool);
    expect(fs.existsSync(orig)).toBe(false);
    expect(res.clipsExpired).toBe(1);
    expect(res.originalsDeleted).toBe(1);
    // 원본 회수 대상 SELECT는 source_type='upload'로 제한(fixture 미삭제 불변식).
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('SELECT id, upload_path') && s.includes("source_type = 'upload'"))).toBe(true);
  });

  it('TTL 만료 clip의 keypoints artifact 삭제', async () => {
    const art = path.join(dir, 'artifacts', 'job.keypoints.json');
    fs.writeFileSync(art, '{}');
    const pool = makePool({ staleArtifacts: [{ id: 'j1', keypoints_path: art }], referencedJobs: [art] });
    const res = await runVideoClipCleanup(pool);
    expect(fs.existsSync(art)).toBe(false);
    expect(res.artifactsDeleted).toBe(1);
  });

  it('미참조 orphan 파일 삭제, 참조 파일(원본+썸네일)은 보존', async () => {
    const referenced = path.join(dir, 'keep.bin');
    const orphan = path.join(dir, 'orphan.bin');
    const refFrame = path.join(dir, 'artifacts', 'c1.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.thumb.jpg');
    const orphanFrame = path.join(dir, 'artifacts', 'c2.ffffffff-ffff-ffff-ffff-ffffffffffff.thumb.jpg');
    fs.writeFileSync(referenced, 'x');
    fs.writeFileSync(orphan, 'x');
    fs.writeFileSync(refFrame, 'x');
    fs.writeFileSync(orphanFrame, 'x');
    // 살아있는 썸네일은 referenced에 포함 → 보존. 미참조 썸네일은 orphan으로 삭제.
    const pool = makePool({ referencedClips: [{ upload_path: referenced, sample_frame_path: refFrame }] });
    const res = await runVideoClipCleanup(pool);
    expect(fs.existsSync(referenced)).toBe(true);
    expect(fs.existsSync(refFrame)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(orphanFrame)).toBe(false);
    expect(res.orphansDeleted).toBe(2);
  });

  it('TTL 만료 clip의 sample_frame 회수 + NULL UPDATE', async () => {
    const frame = path.join(dir, 'artifacts', 'c1.11111111-2222-3333-4444-555555555555.thumb.jpg');
    fs.writeFileSync(frame, 'x');
    const pool = makePool({ staleFrames: [{ id: 'c1', sample_frame_path: frame }] });
    const res = await runVideoClipCleanup(pool);
    expect(fs.existsSync(frame)).toBe(false);
    expect(res.sampleFramesDeleted).toBe(1);
    const upd = (pool.query as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).some((s) => s.includes('SET sample_frame_path = NULL'));
    expect(upd).toBe(true);
  });

  it('tmp/ 잔여물은 grace(1h) 초과만 삭제', async () => {
    const fresh = path.join(dir, 'tmp', 'fresh');
    const old = path.join(dir, 'tmp', 'old');
    fs.writeFileSync(fresh, 'x');
    fs.writeFileSync(old, 'x');
    const past = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(old, new Date(past), new Date(past));
    const pool = makePool({});
    await runVideoClipCleanup(pool);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });
});

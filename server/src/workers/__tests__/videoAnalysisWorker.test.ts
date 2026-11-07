import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const videoCfg = vi.hoisted(() => ({
  uploadDir: '', retentionPolicy: 'review_fidelity' as 'review_fidelity' | 'privacy_first', overlayFrames: false, detIntervalSec: 0,
}));
beforeAll(() => { videoCfg.uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-up-')); });
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig({
    video: {
      fixtureDir: '/fx', scriptsDir: '/s', python: '/p', poseTier: 'standard',
      get uploadDir() { return videoCfg.uploadDir; },
      get retentionPolicy() { return videoCfg.retentionPolicy; },
      get overlayFrames() { return videoCfg.overlayFrames; },
      get detIntervalSec() { return videoCfg.detIntervalSec; },
    },
  }),
}));
vi.mock('../fixturePath', () => ({
  resolveFixtureClip: vi.fn((name: unknown) => (name === 'good.mp4' ? '/fx/good.mp4' : null)),
  resolveUploadedClipPath: vi.fn((p: unknown) => (typeof p === 'string' && p ? p : null)),
}));

import { pollOnce, iouXywh, mapTargetTrack, buildInferArgs } from '../videoAnalysisWorker';
import { createFakePool, type FakePool, type QueryHandler } from '../../testing/fakePool';

const JOB = { id: 'job-1', clip_id: 'clip-1', analysis_profile: 'posture-basic', inference_device: 'auto' };

// queued job 1건을 claim하도록 fakePool handler 구성(SQL로 응답 선택).
// overrides는 기본 handler보다 앞에 놓여 먼저 매치된다(특정 쿼리만 실패시키는 테스트용).
function workerFake(opts: {
  job?: typeof JOB | null; uploadPath?: string | null;
  sourceType?: string; fileState?: string;
  sampleDetectResult?: unknown; targetPersonId?: string | null;
  overrides?: QueryHandler[];
} = {}): FakePool {
  const job = opts.job === undefined ? JOB : opts.job;
  const uploadPath = opts.uploadPath === undefined ? '/fx/good.mp4' : opts.uploadPath;
  const sourceType = opts.sourceType ?? 'fixture';
  const fileState = opts.fileState ?? 'present';
  const sampleDetectResult = opts.sampleDetectResult ?? null;
  const targetPersonId = opts.targetPersonId ?? null;

  return createFakePool({
    handlers: [
      ...(opts.overrides ?? []),
      // claim 트랜잭션(client): BEGIN/COMMIT/ROLLBACK은 fakePool 기본 응답.
      { name: 'claim.select', via: 'client', match: (sql) => sql.includes('SKIP LOCKED'), reply: { rows: job ? [job] : [] } },
      { name: 'claim.markProcessing', via: 'client', match: (sql) => sql.includes("SET status = 'processing'"), reply: { rows: [] } },
      {
        name:  'clip.load',
        via:   'pool',
        match: (sql) => sql.includes('SELECT upload_path'),
        reply: { rows: [{ upload_path: uploadPath, source_type: sourceType, file_state: fileState }] },
      },
      {
        name:  'clip.targetSelection',
        via:   'pool',
        match: (sql) => sql.includes('SELECT sample_detect_result'),
        reply: { rows: [{ sample_detect_result: sampleDetectResult, target_person_id: targetPersonId }] },
      },
      { name: 'pool.updates', via: 'pool', match: /^\s*UPDATE\b/, reply: { rows: [] } }, // sweeps + final update
    ],
  });
}

const SDR = { schemaVersion: 1, frameIndex: 100, timestampMs: 8000, frameWidth: 640, frameHeight: 480, persons: [{ id: 'p1', bbox: [10, 20, 100, 200], score: 1 }] };

const clientSql = (fake: FakePool): string[] =>
  fake.calls.filter((c) => c.via === 'client').map((c) => c.sql);
const poolUpdate = (fake: FakePool, needle: string): readonly unknown[] | undefined =>
  fake.calls.find((c) => c.via === 'pool' && c.sql.includes(needle))?.params;

beforeEach(() => { vi.clearAllMocks(); });

describe('videoAnalysisWorker.pollOnce', () => {
  it('빈 큐 → false (처리 안 함)', async () => {
    const fake = workerFake({ job: null });
    const runInference = vi.fn();
    expect(await pollOnce(fake.pool, { runInference })).toBe(false);
    expect(runInference).not.toHaveBeenCalled();
    expect(poolUpdate(fake, 'SELECT upload_path')).toBeUndefined();
  });

  it('claim은 단일 트랜잭션 + FOR UPDATE SKIP LOCKED (중복 처리 방지)', async () => {
    const fake = workerFake();
    await pollOnce(fake.pool, { runInference: vi.fn().mockResolvedValue({ clipFeatures: {}, preprocessConfigHash: null, inputSha256: null }) });
    const sqls = clientSql(fake);
    expect(sqls.some((s) => s === 'BEGIN')).toBe(true);
    expect(sqls.some((s) => s.includes('FOR UPDATE OF j SKIP LOCKED'))).toBe(true);
    expect(sqls.some((s) => s.includes("status = 'processing'"))).toBe(true);
    expect(sqls.some((s) => s === 'COMMIT')).toBe(true);
  });

  it('성공: 추론 결과를 review_pending + result_features/hash로 저장', async () => {
    const fake = workerFake();
    const runInference = vi.fn().mockResolvedValue({
      clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: 'pch', inputSha256: 'sha',
    });
    expect(await pollOnce(fake.pool, { runInference })).toBe(true);
    expect(runInference).toHaveBeenCalledWith('/fx/good.mp4', 'posture-basic', null, { framesDir: null, device: 'auto' });
    const upd = poolUpdate(fake, "status = 'review_pending'");
    expect(upd).toBeDefined();
    expect(upd).toContain('pch');
    expect(upd).toContain('sha');
  });

  it('overlayFrames 게이트 on: runInference에 framesDir 전달 + .jpg 생성 시 frames_path 기록', async () => {
    videoCfg.overlayFrames = true;
    const fake = workerFake();
    const runInference = vi.fn(async (_c: string, _p: string | null, _t: unknown, opts?: { framesDir?: string | null }) => {
      if (opts?.framesDir) { fs.mkdirSync(opts.framesDir, { recursive: true }); fs.writeFileSync(path.join(opts.framesDir, '0.jpg'), 'x'); }
      return { clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: null, inputSha256: null, keypointsJson: '{}',
        modelVersion: null, detectorSha256: null, poseSha256: null, weightsComplete: false, featureConfigVersion: null };
    });
    expect(await pollOnce(fake.pool, { runInference })).toBe(true);
    const expectedDir = path.join(videoCfg.uploadDir, 'artifacts', 'job-1.frames');
    expect(runInference).toHaveBeenCalledWith('/fx/good.mp4', 'posture-basic', null, { framesDir: expectedDir, device: 'auto' });
    const upd = poolUpdate(fake, "status = 'review_pending'");
    expect(upd).toContain(expectedDir); // frames_path 기록(.jpg 존재)
    videoCfg.overlayFrames = false;
  });

  it('overlayFrames 게이트 on이나 프레임 미생성(빈 dir) → frames_path 미기록', async () => {
    videoCfg.overlayFrames = true;
    fs.rmSync(path.join(videoCfg.uploadDir, 'artifacts', 'job-1.frames'), { recursive: true, force: true }); // 이전 테스트 잔여 제거
    const fake = workerFake();
    const runInference = vi.fn().mockResolvedValue({ clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: null, inputSha256: null, keypointsJson: '{}' });
    expect(await pollOnce(fake.pool, { runInference })).toBe(true);
    const expectedDir = path.join(videoCfg.uploadDir, 'artifacts', 'job-1.frames');
    const upd = poolUpdate(fake, "status = 'review_pending'");
    expect(upd).not.toContain(expectedDir); // .jpg 없음 → frames_path=null
    videoCfg.overlayFrames = false;
  });

  it('추론 실패 → error 상태 + error_code', async () => {
    const fake = workerFake();
    const runInference = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'INFERENCE_ERROR' }));
    await pollOnce(fake.pool, { runInference });
    const upd = poolUpdate(fake, 'error_code = $2');
    expect(upd).toBeDefined();
    expect(upd).toContain('INFERENCE_ERROR');
  });

  it('execFile timeout으로 kill됨 → error DEADLINE_EXCEEDED (INFERENCE_ERROR로 뭉뚱그리지 않음)', async () => {
    const fake = workerFake();
    const runInference = vi.fn().mockRejectedValue(Object.assign(
      new Error('Command failed: /p /s/infer_clip.py --input x'),
      { killed: true, signal: 'SIGTERM', cmd: '/p /s/infer_clip.py --input x', code: null },
    ));
    await pollOnce(fake.pool, { runInference });
    const upd = poolUpdate(fake, 'error_code = $2');
    expect(upd).toBeDefined();
    const params = upd as unknown[];
    expect(params).toContain('DEADLINE_EXCEEDED');
    expect(params[2]).toMatch(/infer_clip/);
  });

  it('clip 경로 없음(upload_path null) → error CLIP_UNAVAILABLE (추론 미실행)', async () => {
    const fake = workerFake({ uploadPath: null });
    const runInference = vi.fn();
    await pollOnce(fake.pool, { runInference });
    expect(runInference).not.toHaveBeenCalled();
    const upd = poolUpdate(fake, 'error_code = $2');
    expect(upd).toContain('CLIP_UNAVAILABLE');
  });
});

describe('pollOnce keypoints artifact + 보존 정책 A (M3-7b)', () => {
  beforeEach(() => { videoCfg.retentionPolicy = 'review_fidelity'; });

  it('성공 시 keypoints artifact 저장 + keypoints_path/sha256 UPDATE', async () => {
    const fake = workerFake();
    const runInference = vi.fn().mockResolvedValue({
      clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: 'pch', inputSha256: 'sha',
      keypointsJson: '{"frames":[]}',
    });
    await pollOnce(fake.pool, { runInference });
    const artPath = path.join(videoCfg.uploadDir, 'artifacts', 'job-1.keypoints.json');
    expect(fs.existsSync(artPath)).toBe(true);
    const upd = poolUpdate(fake, 'keypoints_path = $5');
    expect(upd).toContain(artPath); // keypoints_path
  });

  it('privacy_first + 업로드 clip → 원본 unlink + file_state=deleted UPDATE', async () => {
    videoCfg.retentionPolicy = 'privacy_first';
    const orig = path.join(videoCfg.uploadDir, 'orig.bin');
    fs.writeFileSync(orig, 'video');
    const fake = workerFake({ sourceType: 'upload', fileState: 'present', uploadPath: orig });
    const runInference = vi.fn().mockResolvedValue({
      clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: null, inputSha256: null, keypointsJson: '{}',
    });
    await pollOnce(fake.pool, { runInference });
    expect(fs.existsSync(orig)).toBe(false); // 원본 삭제
    const upd = poolUpdate(fake, "file_state = 'deleted'");
    expect(upd).toBeDefined();
  });

  it('job row UPDATE 실패 시 keypoints artifact 즉시 정리(orphan 방지)', async () => {
    // review_pending UPDATE(keypoints_path 기록)만 실패시킨다. 그 밖의 pool 쿼리는 기존 mock처럼 빈 결과
    // (sample_detect_result 조회 포함).
    const { pool } = workerFake({
      uploadPath: '/fx/good.mp4', sourceType: 'fixture', fileState: 'present',
      overrides: [
        { name: 'jobs.reviewPending.fail', via: 'pool', match: (sql) => sql.includes("status = 'review_pending'"), reply: new Error('db down') },
        { name: 'clip.targetSelection.empty', via: 'pool', match: (sql) => sql.includes('SELECT sample_detect_result'), reply: { rows: [] } },
      ],
    });
    const runInference = vi.fn().mockResolvedValue({
      clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: null, inputSha256: null, keypointsJson: '{"k":1}',
    });
    await pollOnce(pool, { runInference });
    const artPath = path.join(videoCfg.uploadDir, 'artifacts', 'job-1.keypoints.json');
    expect(fs.existsSync(artPath)).toBe(false); // DB 기록 전 실패 → 즉시 unlink
  });

  it('privacy_first라도 fixture 원본은 삭제하지 않는다', async () => {
    videoCfg.retentionPolicy = 'privacy_first';
    const fake = workerFake({ sourceType: 'fixture', fileState: 'present', uploadPath: '/fx/good.mp4' });
    const runInference = vi.fn().mockResolvedValue({
      clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: null, inputSha256: null, keypointsJson: '{}',
    });
    await pollOnce(fake.pool, { runInference });
    expect(poolUpdate(fake, "file_state = 'deleted'")).toBeUndefined();
  });
});

describe('buildInferArgs — infer_clip spawn 인자 (config 노브 전달 고정)', () => {
  const build = (framesDir?: string | null) =>
    buildInferArgs('/s', '/clips/c.mp4', '/w/kp.json', 20, 'wholebody', 'auto', framesDir);

  beforeEach(() => { videoCfg.detIntervalSec = 0; });

  it('기본(detIntervalSec=0): --det-interval-sec 미전달 — python이 feature_config 기본(off) 사용', () => {
    const args = build();
    expect(args).toContain('--pose-tier');
    expect(args[args.indexOf('--pose-tier') + 1]).toBe('standard');
    expect(args).not.toContain('--det-interval-sec');
  });

  it('활성(detIntervalSec>0): --det-interval-sec 값 전달 (6.0-15)', () => {
    videoCfg.detIntervalSec = 0.5;
    const args = build();
    expect(args[args.indexOf('--det-interval-sec') + 1]).toBe('0.5');
  });

  it('framesDir 지정 시에만 --frames-dir 전달(overlay 게이트)', () => {
    expect(build(null)).not.toContain('--frames-dir');
    const args = build('/w/frames');
    expect(args[args.indexOf('--frames-dir') + 1]).toBe('/w/frames');
  });
});

describe('box→track 매핑 (PR D2b, §8.7)', () => {
  it('iouXywh: xywh 픽셀 박스 IoU', () => {
    expect(iouXywh([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iouXywh([0, 0, 10, 10], [100, 100, 10, 10])).toBe(0);
    expect(iouXywh([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(5 / 15, 5); // 교집합 50, 합집합 150
  });

  const kpDoc = (persons: Array<{ trackId: string; bbox: number[] }>, ts = 8000) => ({
    frames: [
      { timestampMs: 0, persons: [{ trackId: 'tX', bbox: [999, 999, 5, 5] }] },
      { timestampMs: ts, persons },
    ],
  });
  const sel = (bbox: [number, number, number, number]) => ({ id: 'p1', bbox, timestampMs: 8000 });

  it('시간/IoU 허용 내 max-IoU person의 trackId 반환', () => {
    const doc = kpDoc([{ trackId: 't1', bbox: [10, 20, 100, 200] }, { trackId: 't2', bbox: [300, 50, 80, 180] }]);
    expect(mapTargetTrack(doc, sel([12, 22, 100, 200]))).toBe('t1'); // 선택 박스와 t1이 거의 겹침
  });

  it('IoU 미달 → TARGET_TRACK_MAP_FAILED (dominant 금지)', () => {
    const doc = kpDoc([{ trackId: 't1', bbox: [0, 0, 10, 10] }]);
    expect(() => mapTargetTrack(doc, sel([500, 500, 10, 10]))).toThrow(/map/i);
    try { mapTargetTrack(doc, sel([500, 500, 10, 10])); } catch (e) {
      expect((e as { code?: string }).code).toBe('TARGET_TRACK_MAP_FAILED');
    }
  });

  it('시간 허용치 초과 프레임은 무시 → 매핑 실패', () => {
    const doc = { frames: [{ timestampMs: 20000, persons: [{ trackId: 't1', bbox: [10, 20, 100, 200] }] }] };
    expect(() => mapTargetTrack(doc, sel([10, 20, 100, 200]))).toThrow();
  });

  it('pollOnce: clip에 선택 있으면 runInference에 targetSelection 전달', async () => {
    const { pool } = workerFake({ sampleDetectResult: SDR, targetPersonId: 'p1' });
    const runInference = vi.fn().mockResolvedValue({ clipFeatures: {}, preprocessConfigHash: null, inputSha256: null });
    await pollOnce(pool, { runInference });
    expect(runInference).toHaveBeenCalledWith('/fx/good.mp4', 'posture-basic',
      expect.objectContaining({ id: 'p1', bbox: [10, 20, 100, 200], timestampMs: 8000 }), { framesDir: null, device: 'auto' });
  });

  it('pollOnce: 선택했는데 후보 id 불일치 → job error TARGET_TRACK_MAP_FAILED', async () => {
    const fake = workerFake({ sampleDetectResult: SDR, targetPersonId: 'pX' });
    await pollOnce(fake.pool, { runInference: vi.fn() });
    const upd = poolUpdate(fake, 'error_code = $2');
    expect(upd).toContain('TARGET_TRACK_MAP_FAILED');
  });

  it('pollOnce: 선택은 있는데 sample_detect_result null → job error INVALID_SAMPLE_DETECT (dominant 폴백 금지)', async () => {
    const fake = workerFake({ sampleDetectResult: null, targetPersonId: 'p1' });
    const runInference = vi.fn();
    await pollOnce(fake.pool, { runInference });
    expect(runInference).not.toHaveBeenCalled();
    const upd = poolUpdate(fake, 'error_code = $2');
    expect(upd).toContain('INVALID_SAMPLE_DETECT');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../../config', () => ({
  default: { video: { fixtureDir: '/fx', scriptsDir: '/s', python: '/p' } },
}));
vi.mock('../fixturePath', () => ({
  resolveFixtureClip: vi.fn((name: unknown) => (name === 'good.mp4' ? '/fx/good.mp4' : null)),
}));

import { pollOnce, iouXywh, mapTargetTrack } from '../videoAnalysisWorker';

const JOB = { id: 'job-1', clip_id: 'clip-1', analysis_profile: 'posture-basic' };

// queued job 1건을 claim하도록 client/pool mock 구성.
function makePool(opts: {
  job?: typeof JOB | null; uploadPath?: string | null;
  sampleDetectResult?: unknown; targetPersonId?: string | null;
} = {}) {
  const job = opts.job === undefined ? JOB : opts.job;
  const uploadPath = opts.uploadPath === undefined ? '/fx/good.mp4' : opts.uploadPath;
  const sampleDetectResult = opts.sampleDetectResult ?? null;
  const targetPersonId = opts.targetPersonId ?? null;

  const client = {
    query: vi.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FOR UPDATE SKIP LOCKED')) {
        return Promise.resolve({ rows: job ? [job] : [] });
      }
      return Promise.resolve({ rows: [] }); // BEGIN/UPDATE processing/COMMIT
    }),
    release: vi.fn(),
  };
  const query = vi.fn((sql: string) => {
    if (typeof sql === 'string' && sql.includes('SELECT upload_path')) {
      return Promise.resolve({ rows: [{ upload_path: uploadPath }] });
    }
    if (typeof sql === 'string' && sql.includes('SELECT sample_detect_result')) {
      return Promise.resolve({ rows: [{ sample_detect_result: sampleDetectResult, target_person_id: targetPersonId }] });
    }
    return Promise.resolve({ rows: [] }); // sweeps + final update
  });
  const pool = { connect: vi.fn().mockResolvedValue(client), query } as unknown as Pool;
  return { pool, client, query };
}

const SDR = { schemaVersion: 1, frameIndex: 100, timestampMs: 8000, frameWidth: 640, frameHeight: 480, persons: [{ id: 'p1', bbox: [10, 20, 100, 200], score: 1 }] };

/* eslint-disable @typescript-eslint/no-explicit-any */
const clientSql = (client: any): string[] =>
  client.query.mock.calls.map((c: unknown[]) => String(c[0]));
const poolUpdate = (query: any, needle: string): unknown[] | undefined =>
  query.mock.calls.find((c: unknown[]) => String(c[0]).includes(needle));

beforeEach(() => { vi.clearAllMocks(); });

describe('videoAnalysisWorker.pollOnce', () => {
  it('빈 큐 → false (처리 안 함)', async () => {
    const { pool, query } = makePool({ job: null });
    const runInference = vi.fn();
    expect(await pollOnce(pool, { runInference })).toBe(false);
    expect(runInference).not.toHaveBeenCalled();
    expect(poolUpdate(query, 'SELECT upload_path')).toBeUndefined();
  });

  it('claim은 단일 트랜잭션 + FOR UPDATE SKIP LOCKED (중복 처리 방지)', async () => {
    const { pool, client } = makePool();
    await pollOnce(pool, { runInference: vi.fn().mockResolvedValue({ clipFeatures: {}, preprocessConfigHash: null, inputSha256: null }) });
    const sqls = clientSql(client);
    expect(sqls.some((s) => s === 'BEGIN')).toBe(true);
    expect(sqls.some((s) => s.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
    expect(sqls.some((s) => s.includes("status = 'processing'"))).toBe(true);
    expect(sqls.some((s) => s === 'COMMIT')).toBe(true);
  });

  it('성공: 추론 결과를 review_pending + result_features/hash로 저장', async () => {
    const { pool, query } = makePool();
    const runInference = vi.fn().mockResolvedValue({
      clipFeatures: { schemaVersion: 1, features: {} }, preprocessConfigHash: 'pch', inputSha256: 'sha',
    });
    expect(await pollOnce(pool, { runInference })).toBe(true);
    expect(runInference).toHaveBeenCalledWith('/fx/good.mp4', 'posture-basic', null);
    const upd = poolUpdate(query, "status = 'review_pending'");
    expect(upd).toBeDefined();
    expect(upd?.[1]).toContain('pch');
    expect(upd?.[1]).toContain('sha');
  });

  it('추론 실패 → error 상태 + error_code', async () => {
    const { pool, query } = makePool();
    const runInference = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'INFERENCE_ERROR' }));
    await pollOnce(pool, { runInference });
    const upd = poolUpdate(query, 'error_code = $2');
    expect(upd).toBeDefined();
    expect(upd?.[1]).toContain('INFERENCE_ERROR');
  });

  it('fixture 경로 없음(upload_path null) → error FIXTURE_UNAVAILABLE (추론 미실행)', async () => {
    const { pool, query } = makePool({ uploadPath: null });
    const runInference = vi.fn();
    await pollOnce(pool, { runInference });
    expect(runInference).not.toHaveBeenCalled();
    const upd = poolUpdate(query, 'error_code = $2');
    expect(upd?.[1]).toContain('FIXTURE_UNAVAILABLE');
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
    const { pool } = makePool({ sampleDetectResult: SDR, targetPersonId: 'p1' });
    const runInference = vi.fn().mockResolvedValue({ clipFeatures: {}, preprocessConfigHash: null, inputSha256: null });
    await pollOnce(pool, { runInference });
    expect(runInference).toHaveBeenCalledWith('/fx/good.mp4', 'posture-basic',
      expect.objectContaining({ id: 'p1', bbox: [10, 20, 100, 200], timestampMs: 8000 }));
  });

  it('pollOnce: 선택했는데 후보 id 불일치 → job error TARGET_TRACK_MAP_FAILED', async () => {
    const { pool, query } = makePool({ sampleDetectResult: SDR, targetPersonId: 'pX' });
    await pollOnce(pool, { runInference: vi.fn() });
    const upd = poolUpdate(query, 'error_code = $2');
    expect(upd?.[1]).toContain('TARGET_TRACK_MAP_FAILED');
  });

  it('pollOnce: 선택은 있는데 sample_detect_result null → job error INVALID_SAMPLE_DETECT (dominant 폴백 금지)', async () => {
    const { pool, query } = makePool({ sampleDetectResult: null, targetPersonId: 'p1' });
    const runInference = vi.fn();
    await pollOnce(pool, { runInference });
    expect(runInference).not.toHaveBeenCalled();
    const upd = poolUpdate(query, 'error_code = $2');
    expect(upd?.[1]).toContain('INVALID_SAMPLE_DETECT');
  });
});

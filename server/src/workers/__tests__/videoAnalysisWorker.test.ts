import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../../config', () => ({
  default: { video: { fixtureDir: '/fx', scriptsDir: '/s', python: '/p' } },
}));
vi.mock('../fixturePath', () => ({
  resolveFixtureClip: vi.fn((name: unknown) => (name === 'good.mp4' ? '/fx/good.mp4' : null)),
}));

import { pollOnce } from '../videoAnalysisWorker';

const JOB = { id: 'job-1', clip_id: 'clip-1', analysis_profile: 'posture-basic' };

// queued job 1건을 claim하도록 client/pool mock 구성.
function makePool(opts: { job?: typeof JOB | null; uploadPath?: string | null } = {}) {
  const job = opts.job === undefined ? JOB : opts.job;
  const uploadPath = opts.uploadPath === undefined ? '/fx/good.mp4' : opts.uploadPath;

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
    return Promise.resolve({ rows: [] }); // sweeps + final update
  });
  const pool = { connect: vi.fn().mockResolvedValue(client), query } as unknown as Pool;
  return { pool, client, query };
}

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
    expect(runInference).toHaveBeenCalledWith('/fx/good.mp4', 'posture-basic');
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

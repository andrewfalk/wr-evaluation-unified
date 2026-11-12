// S9: the graceful stop — order (HTTP server → background jobs → pools → exit), once only, exit codes, the timeout —
// and that every background job startBackgroundJobs starts is something the stop can stop (no timer left behind).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

// The real configuration with every background feature switched on.
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  const base = actual.default;
  return {
    ...actual,
    default: {
      ...base, videoAnalysisEnabled: true, statsWorkbenchEnabled: true, deploymentMode: 'intranet', queueNamespace: 'ns-boot',
      video: { ...base.video, fixtureMode: true },
    },
  };
});
// The jobs' bodies (the timers and workers around them stay real).
vi.mock('../jobs/workspaceRetention', () => ({ runWorkspaceRetention: vi.fn(async () => ({ deleted: 0 })) }));
vi.mock('../jobs/videoClipCleanup', () => ({ runVideoClipCleanup: vi.fn(async () => ({ clipsExpired: 0, originalsDeleted: 0, artifactsDeleted: 0, sampleFramesDeleted: 0, orphansDeleted: 0 })) }));
vi.mock('../jobs/statsRunCleanup', () => ({ runStatsRunCleanup: vi.fn(async () => ({ deleted: 0 })) }));

import { createShutdown, startBackgroundJobs, type Stoppable } from '../boot';

afterEach(() => {
  vi.useRealTimers();
});

function harness(order: string[], overrides: { closeError?: Error; poolError?: Error } = {}) {
  const exit = vi.fn((code: number) => { order.push(`exit:${code}`); });
  const server = {
    close: vi.fn((cb?: (err?: Error) => void) => {
      order.push('server.close');
      setImmediate(() => { order.push('server.closed'); cb?.(overrides.closeError); });
      return server as never;
    }),
    closeIdleConnections: vi.fn(() => { order.push('server.closeIdleConnections'); }),
  };
  const pools = ['app', 'audit'].map((name) => ({
    name,
    end: vi.fn(async () => {
      order.push(`pool.end:${name}`);
      if (name === 'app' && overrides.poolError) throw overrides.poolError;
    }),
  }));
  const log = { info: vi.fn(), error: vi.fn() };
  return { order, exit, server, pools, log };
}

function job(name: string, order: string[], opts: { delayMs?: number; fail?: boolean; hang?: boolean } = {}): Stoppable {
  return {
    name,
    stop: () => {
      order.push(`stop:${name}`);
      if (opts.hang) return new Promise<void>(() => {});
      return new Promise<void>((resolve, reject) => setTimeout(() => {
        order.push(`stopped:${name}`);
        if (opts.fail) reject(new Error(`${name} failed`)); else resolve();
      }, opts.delayMs ?? 0));
    },
  };
}

describe('createShutdown', () => {
  it('closes the server, then stops every job and waits for them, then ends the pools, then exits 0', async () => {
    const order: string[] = [];
    const h = harness(order);
    const jobs = [job('worker', order, { delayMs: 20 }), job('sweeper', order)];

    await createShutdown({ server: h.server, jobs, pools: h.pools, exit: h.exit, log: h.log })('SIGTERM');

    expect(order).toEqual([
      'server.close', 'server.closeIdleConnections', 'server.closed',
      'stop:worker', 'stop:sweeper', 'stopped:sweeper', 'stopped:worker',
      'pool.end:app', 'pool.end:audit',
      'exit:0',
    ]);
  });

  it('runs once: a second signal while stopping gets the same promise and exit is called once', async () => {
    const h = harness([]);
    const shutdown = createShutdown({ server: h.server, jobs: [], pools: h.pools, exit: h.exit, log: h.log });
    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    expect(second).toBe(first);
    await first;
    expect(h.server.close).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('a failing step is logged, the remaining steps still run, and the exit code is 1', async () => {
    const order: string[] = [];
    const jobs = [job('worker', order, { fail: true }), job('sweeper', order)];
    const h = harness(order, { closeError: new Error('close failed'), poolError: new Error('end failed') });
    const shutdown = createShutdown({ server: h.server, jobs, pools: h.pools, exit: h.exit, log: h.log });

    await shutdown('SIGTERM');

    expect(order.filter((e) => e.includes('stop'))).toEqual(['stop:worker', 'stop:sweeper', 'stopped:worker', 'stopped:sweeper']);
    expect(order.slice(-3)).toEqual(['pool.end:app', 'pool.end:audit', 'exit:1']);
    expect(h.pools.map((p) => p.end.mock.calls.length)).toEqual([1, 1]);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.log.error).toHaveBeenCalledTimes(3);
  });

  it.each(['server', 'job', 'pool'] as const)('a failure of the %s step alone still makes the exit code 1', async (failing) => {
    const order: string[] = [];
    const h = harness(order, {
      closeError: failing === 'server' ? new Error('close failed') : undefined,
      poolError: failing === 'pool' ? new Error('end failed') : undefined,
    });
    const jobs = [job('worker', order, { fail: failing === 'job' })];
    await createShutdown({ server: h.server, jobs, pools: h.pools, exit: h.exit, log: h.log })('SIGTERM');
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.log.error).toHaveBeenCalledTimes(1);
  });

  it('a stop for a fatal error exits 1 even when every step succeeds', async () => {
    const h = harness([]);
    await createShutdown({ server: h.server, jobs: [], pools: h.pools, exit: h.exit, log: h.log })('uncaughtException', 1);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('a job that never stops: after timeoutMs the process exits 1 without waiting for it', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const h = harness(order);
    const shutdown = createShutdown({ server: h.server, jobs: [job('stuck', order, { hang: true })], pools: h.pools, exit: h.exit, log: h.log, timeoutMs: 10_000 });
    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.pools[0].end).not.toHaveBeenCalled();
  });
});

describe('startBackgroundJobs', () => {
  it('with every feature on, stopping the returned jobs leaves no timer running', async () => {
    vi.useFakeTimers();
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() } as unknown as Pool;
    const jobs = startBackgroundJobs(pool);

    expect(jobs.map((j) => j.name)).toEqual([
      'workspace-retention', 'emr-audit-nonce-sweeper', 'login-backoff-sweeper',
      'video-analysis-worker', 'video-clip-cleanup', 'stats-runs',
    ]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await Promise.all(jobs.map((j) => j.stop()));
    expect(vi.getTimerCount()).toBe(0);
  });
});

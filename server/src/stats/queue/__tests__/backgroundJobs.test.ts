// S8: the stats background jobs start behind the routes' deployment gate (flag ∧ intranet) and on this server's
// queue namespace — standalone + STATS_WORKBENCH_ENABLED starts no worker and no cleanup.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const createStatsRunsQueueWorker = vi.fn(() => ({ stop: vi.fn() }));
const runStatsRunCleanup = vi.fn(async () => ({ deleted: 0 }));

async function loadWith(statsWorkbenchEnabled: boolean, deploymentMode: 'intranet' | 'standalone') {
  vi.resetModules();
  vi.doMock('../../../config', async () => ({
    default: (await import('../../../testing/configMock.js')).testConfig({
      statsWorkbenchEnabled, deploymentMode, queueNamespace: 'ns-test',
    }),
  }));
  vi.doMock('../runsQueue', () => ({ createStatsRunsQueueWorker }));
  vi.doMock('../../../jobs/statsRunCleanup', () => ({ runStatsRunCleanup }));
  return import('../backgroundJobs.js');
}

afterEach(() => {
  vi.doUnmock('../../../config');
  vi.doUnmock('../runsQueue');
  vi.doUnmock('../../../jobs/statsRunCleanup');
  vi.resetModules();
  createStatsRunsQueueWorker.mockClear();
  runStatsRunCleanup.mockClear();
});

const pool = {} as Pool;

describe('startStatsBackgroundJobs', () => {
  it('flag on + intranet: starts the cleanup and the worker on config.queueNamespace', async () => {
    const { startStatsBackgroundJobs } = await loadWith(true, 'intranet');
    const started = startStatsBackgroundJobs(pool);
    expect(started).not.toBeNull();
    expect(createStatsRunsQueueWorker).toHaveBeenCalledWith(pool, { namespace: 'ns-test' });
    expect(runStatsRunCleanup).toHaveBeenCalledWith(pool, 'ns-test');
    started!.stop();
  });

  it.each([
    [true, 'standalone'],
    [false, 'intranet'],
    [false, 'standalone'],
  ] as const)('flag=%s mode=%s: starts nothing', async (flag, mode) => {
    const { startStatsBackgroundJobs } = await loadWith(flag, mode);
    expect(startStatsBackgroundJobs(pool)).toBeNull();
    expect(createStatsRunsQueueWorker).not.toHaveBeenCalled();
    expect(runStatsRunCleanup).not.toHaveBeenCalled();
  });
});

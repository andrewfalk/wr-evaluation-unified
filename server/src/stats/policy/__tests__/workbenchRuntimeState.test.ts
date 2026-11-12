// S8: the stats deployment gate (flag ∧ intranet) — the routes' availability and the queue worker/cleanup start
// (src/boot.ts) read the same function, so standalone + STATS_WORKBENCH_ENABLED starts no stats worker.
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWith(statsWorkbenchEnabled: boolean, deploymentMode: 'intranet' | 'standalone') {
  vi.resetModules();
  vi.doMock('../../../config', async () => ({
    default: (await import('../../../testing/configMock.js')).testConfig({ statsWorkbenchEnabled, deploymentMode }),
  }));
  return import('../workbenchRuntimeState.js');
}

afterEach(() => {
  vi.doUnmock('../../../config');
  vi.resetModules();
});

describe('isStatsDeploymentGateOpen', () => {
  it.each([
    [true, 'intranet', true],
    [true, 'standalone', false],
    [false, 'intranet', false],
    [false, 'standalone', false],
  ] as const)('flag=%s mode=%s → %s, and availability never opens past it', async (flag, mode, open) => {
    const state = await loadWith(flag, mode);
    expect(state.isStatsDeploymentGateOpen()).toBe(open);
    state.setStatsWorkbenchHealthy(true);
    expect(state.getStatsWorkbenchAvailability().available).toBe(open);
  });
});

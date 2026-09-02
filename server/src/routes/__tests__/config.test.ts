import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../config', () => ({
  default: {
    deploymentMode:      'intranet',
    ai:                  { enabled: false },
    localFallbackAllowed: false,
    videoAnalysisEnabled: false,
    video:               { fixtureMode: false, jobDeadlineMs: 600000, queueWaitMs: 600000 },
    statsWorkbenchEnabled: true,
  },
}));

import { createConfigRouter } from '../config';

function makeApp() {
  const app = express();
  app.use('/api/config', createConfigRouter());
  return app;
}

describe('GET /api/config/public', () => {
  it('returns config fields without authentication', async () => {
    const res = await request(makeApp()).get('/api/config/public');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode:                 'intranet',
      aiEnabled:            false,
      localFallbackAllowed: false,
      videoAnalysisEnabled: false,
      videoAnalysisFixtureMode: false,
      videoAnalysisJobDeadlineMs: 600000,
      videoAnalysisQueueWaitMs: 600000,
    });
    expect(res.body).toHaveProperty('serverTime');
    expect(new Date(res.body.serverTime).getTime()).not.toBeNaN();
  });

  // PR0-A
  it('exposes statsWorkbenchEnabled/statsWorkbenchAvailable — available when flag on + intranet', async () => {
    const res = await request(makeApp()).get('/api/config/public');
    expect(res.body.statsWorkbenchEnabled).toBe(true);
    expect(res.body.statsWorkbenchAvailable).toBe(true);
  });
});

// statsWorkbenchRuntimeState computes availability once at module load from
// config.statsWorkbenchEnabled && config.deploymentMode === 'intranet' — a fresh
// module graph is needed per scenario (vi.resetModules, mirrors security.test.ts's
// CORS dev-mode pattern).
describe('GET /api/config/public — statsWorkbenchAvailable is false outside intranet', () => {
  beforeEach(() => { vi.resetModules(); });

  it('is unavailable when deploymentMode is not intranet, even with the flag on', async () => {
    vi.doMock('../../config', () => ({
      default: {
        deploymentMode: 'standalone',
        ai: { enabled: false },
        localFallbackAllowed: true,
        videoAnalysisEnabled: false,
        video: { fixtureMode: false, jobDeadlineMs: 600000, queueWaitMs: 600000 },
        statsWorkbenchEnabled: true,
      },
    }));
    const { createConfigRouter: createFreshConfigRouter } = await import('../config');
    const app = express();
    app.use('/api/config', createFreshConfigRouter());
    const res = await request(app).get('/api/config/public');
    expect(res.body.statsWorkbenchEnabled).toBe(true);
    expect(res.body.statsWorkbenchAvailable).toBe(false);
  });

  it('is unavailable when the flag is off, even in intranet mode', async () => {
    vi.doMock('../../config', () => ({
      default: {
        deploymentMode: 'intranet',
        ai: { enabled: false },
        localFallbackAllowed: false,
        videoAnalysisEnabled: false,
        video: { fixtureMode: false, jobDeadlineMs: 600000, queueWaitMs: 600000 },
        statsWorkbenchEnabled: false,
      },
    }));
    const { createConfigRouter: createFreshConfigRouter } = await import('../config');
    const app = express();
    app.use('/api/config', createFreshConfigRouter());
    const res = await request(app).get('/api/config/public');
    expect(res.body.statsWorkbenchAvailable).toBe(false);
  });
});

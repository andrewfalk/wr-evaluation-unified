import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../config', () => ({
  default: {
    deploymentMode:      'intranet',
    ai:                  { enabled: false },
    localFallbackAllowed: false,
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
    });
    expect(res.body).toHaveProperty('serverTime');
    expect(new Date(res.body.serverTime).getTime()).not.toBeNaN();
  });
});

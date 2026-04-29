/**
 * Integration-level tests for CSP, CORS, and rate-limit middleware.
 * Uses a minimal Express app to verify header values and rejection behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', () => ({
  default: {
    env:  'production',
    cors: { origins: ['https://wr.hospital.local'] },
  },
}));

import { cspMiddleware } from '../csp';
import { corsMiddleware } from '../corsMiddleware';
import { loginRateLimit, csrfRateLimit } from '../rateLimit';

function makeApp() {
  const app = express();
  app.use(cspMiddleware());
  app.use(corsMiddleware());
  app.get('/test', (_req, res) => res.json({ ok: true }));
  app.post('/login', loginRateLimit(), (_req, res) => res.json({ ok: true }));
  app.post('/csrf',  csrfRateLimit(),  (_req, res) => res.json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// CSP
// ---------------------------------------------------------------------------
describe('CSP headers', () => {
  it('includes Content-Security-Policy header', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it("CSP blocks external connect-src (only 'self' allowed)", async () => {
    const csp = (await request(makeApp()).get('/test')).headers['content-security-policy'] as string;
    expect(csp).toContain("connect-src 'self'");
  });

  it('CSP allows blob: for worker-src and img-src (export/pdf support)', async () => {
    const csp = (await request(makeApp()).get('/test')).headers['content-security-policy'] as string;
    expect(csp).toContain('blob:');
  });

  it('CSP sets frame-ancestors none (clickjacking protection)', async () => {
    const csp = (await request(makeApp()).get('/test')).headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
describe('CORS middleware', () => {
  it('allows requests from the whitelisted intranet origin', async () => {
    const res = await request(makeApp())
      .get('/test')
      .set('Origin', 'https://wr.hospital.local');
    expect(res.headers['access-control-allow-origin']).toBe('https://wr.hospital.local');
  });

  it('blocks null origin with 403 CORS_ORIGIN_DENIED', async () => {
    const res = await request(makeApp())
      .get('/test')
      .set('Origin', 'null');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CORS_ORIGIN_DENIED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('blocks unknown external origin with 403', async () => {
    const res = await request(makeApp())
      .get('/test')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CORS_ORIGIN_DENIED');
  });

  it('allows requests with no Origin header (same-origin / server-to-server)', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.status).toBe(200);
  });

  it('does NOT allow localhost:5173 in production mode (403)', async () => {
    const res = await request(makeApp())
      .get('/test')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CORS_ORIGIN_DENIED');
  });
});

// ---------------------------------------------------------------------------
// Rate limit — login (5 req/min)
// ---------------------------------------------------------------------------
describe('Login rate limit', () => {
  it('allows requests up to the limit', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/login');
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 after exceeding the limit', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await request(app).post('/login');
    const res = await request(app).post('/login');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// Rate limit — csrf (10 req/min)
// ---------------------------------------------------------------------------
describe('CSRF rate limit', () => {
  it('returns 429 after exceeding 10 requests', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) await request(app).post('/csrf');
    const res = await request(app).post('/csrf');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// CORS dev mode — needs a fresh module with env=test
// ---------------------------------------------------------------------------
describe('CORS dev mode (non-production)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('allows localhost:5173 when env is not production', async () => {
    vi.doMock('../../config', () => ({
      default: {
        env:  'development',
        cors: { origins: ['https://wr.hospital.local'] },
      },
    }));
    const { corsMiddleware: corsDevMiddleware } = await import('../corsMiddleware');
    const app = express();
    app.use(corsDevMiddleware());
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

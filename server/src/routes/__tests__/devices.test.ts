import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', () => ({
  default: {
    env:  'test',
    cors: { origins: [] },
    auth: {
      accessTokenTtl:     900,
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
  },
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
}));

import { createDevicesRouter } from '../devices';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(insertRows: unknown[] = [{ id: 'dev-1' }]): Pool {
  const release = vi.fn();
  const client  = { query: vi.fn(), release } as unknown as { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  return {
    connect: vi.fn().mockResolvedValue(client),
    query:   vi.fn().mockResolvedValue({ rows: insertRows }),
  } as unknown as Pool;
}

function validToken(): string {
  const { token } = generateAccessToken({
    sub:                'user-1',
    sessionId:          'sess-1',
    orgId:              'org-1',
    role:               'doctor',
    name:               'Dr. Kim',
    mustChangePassword: false,
    csrfHash:           'hash:csrf',
  });
  return token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Minimal auth middleware stub: set sessionInfo from token, check DB live
  app.use((req, _res, next) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      // Simulate pool.query returning a live session row for auth middleware
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    }
    next();
  });
  app.use('/api/devices', createDevicesRouter(pool));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/devices/register', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool))
      .post('/api/devices/register')
      .send({ publicKey: 'abc', buildTarget: 'intranet' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is invalid', async () => {
    const pool  = makePool();
    const token = validToken();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'abc' }); // missing buildTarget

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 for invalid buildTarget', async () => {
    const pool  = makePool();
    const token = validToken();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'abc', buildTarget: 'cloud' });

    expect(res.status).toBe(400);
  });

  it('returns 201 with deviceId and pending status on valid request', async () => {
    const pool  = makePool([{ id: 'dev-1' }]);
    const token = validToken();
    // Auth middleware DB check: live session
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    // INSERT returning device id
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 'dev-1' }] });

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'ed25519-pub-key-base64', buildTarget: 'intranet' });

    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBe('dev-1');
    expect(res.body.status).toBe('pending');
  });

  it('stores user_id, org_id, publicKey, buildTarget in DB', async () => {
    const pool  = makePool([{ id: 'dev-2' }]);
    const token = validToken();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 'dev-2' }] });

    await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'my-pub-key', buildTarget: 'intranet' });

    // Find the INSERT call (last pool.query after auth check)
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const insertCall = calls.find((args: unknown[]) => typeof args[0] === 'string' && args[0].includes('INSERT INTO devices'));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe('user-1');    // user_id
    expect(params[1]).toBe('org-1');     // organization_id
    expect(params[2]).toBe('my-pub-key'); // public_key
    expect(params[3]).toBe('intranet');  // build_target
  });

  it('returns 429 after exceeding IP rate limit (1/min)', async () => {
    const pool  = makePool();
    const token = validToken();
    const app   = makeApp(pool);

    // First request succeeds (mocks wired inside makeApp per request, so
    // set up fresh mocks for each call)
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // auth check
      .mockResolvedValueOnce({ rows: [{ id: 'dev-1' }] }); // insert

    await request(app)
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'k', buildTarget: 'intranet' });

    // Second request should be rate-limited (same IP)
    const res2 = await request(app)
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'k', buildTarget: 'intranet' });

    expect(res2.status).toBe(429);
    expect(res2.body.code).toBe('RATE_LIMITED');
  });
});

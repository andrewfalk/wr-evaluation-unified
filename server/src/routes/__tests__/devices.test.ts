import crypto from 'crypto';
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

// Valid Ed25519 public key: 32 random bytes as standard base64 (44 chars, 1 padding =).
function validPublicKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

function makePool(queryRows: unknown[] = [{ id: 'dev-1', status: 'pending', inserted: true }]): Pool {
  return {
    connect: vi.fn(),
    query:   vi.fn().mockResolvedValue({ rows: queryRows }),
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
  app.use('/api/devices', createDevicesRouter(pool));
  return app;
}

// Wire pool.query to return a live session for auth middleware, then the
// insert result for the handler.
function wireAuth(pool: Pool, insertRow = { id: 'dev-1', status: 'pending', inserted: true }) {
  (pool.query as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ rows: [{ exists: 1 }] })   // auth middleware session check
    .mockResolvedValueOnce({ rows: [insertRow] });        // INSERT ... ON CONFLICT ... RETURNING
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/devices/register', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] }); // no session

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when publicKey is missing', async () => {
    const pool  = makePool();
    const token = validToken();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ buildTarget: 'intranet' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when publicKey is not a valid 32-byte base64 key', async () => {
    const pool  = makePool();
    const token = validToken();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'not-a-valid-ed25519-key', buildTarget: 'intranet' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when publicKey decodes to wrong length (not 32 bytes)', async () => {
    const pool  = makePool();
    const token = validToken();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const shortKey = crypto.randomBytes(16).toString('base64'); // 16 bytes, not 32

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: shortKey, buildTarget: 'intranet' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when buildTarget is standalone (not permitted)', async () => {
    const pool  = makePool();
    const token = validToken();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'standalone' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 201 with deviceId and pending status on new registration', async () => {
    const pool  = makePool();
    const token = validToken();
    wireAuth(pool);

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBe('dev-1');
    expect(res.body.status).toBe('pending');
  });

  it('returns 200 when same key is re-registered (duplicate)', async () => {
    const pool  = makePool();
    const token = validToken();
    wireAuth(pool, { id: 'dev-1', status: 'active', inserted: false });

    const res = await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe('dev-1');
    expect(res.body.message).toContain('already registered');
  });

  it('stores publicKey, fingerprint, buildTarget in DB', async () => {
    const pool  = makePool();
    const token = validToken();
    const pubKey = validPublicKey();
    wireAuth(pool);

    await request(makeApp(pool))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: pubKey, buildTarget: 'intranet' });

    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const insertCall = calls.find((args: unknown[]) =>
      typeof args[0] === 'string' && args[0].includes('INSERT INTO devices')
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe('user-1');    // user_id
    expect(params[1]).toBe('org-1');     // organization_id
    expect(params[2]).toBe(pubKey);      // public_key
    expect(typeof params[3]).toBe('string'); // fingerprint (SHA-256 hex)
    expect((params[3] as string).length).toBe(64);
    expect(params[4]).toBe('intranet');  // build_target
  });

  it('returns 429 after exceeding IP rate limit', async () => {
    const pool  = makePool();
    const token = validToken();
    const app   = makeApp(pool);

    // First request
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'dev-1', status: 'pending', inserted: true }] });

    await request(app)
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    // Second request — rate limited at IP level
    const res2 = await request(app)
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    expect(res2.status).toBe(429);
    expect(res2.body.code).toBe('RATE_LIMITED');
  });
});

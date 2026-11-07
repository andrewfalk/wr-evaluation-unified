import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig(),
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
}));

import { createDevicesRouter } from '../devices';
import { createFakePool, authSessionHandler, type FakePool } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Valid Ed25519 public key: 32 random bytes as standard base64 (44 chars, 1 padding =).
function validPublicKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

// 살아 있는 세션(인증 미들웨어) + INSERT ... ON CONFLICT ... RETURNING 결과.
// revoked면 세션 확인이 빈 결과(세션 없음)를 돌려준다.
function makeFake(
  insertRow = { id: 'dev-1', status: 'pending', inserted: true },
  options: { revoked?: boolean } = {},
): FakePool {
  return createFakePool({
    handlers: [
      authSessionHandler({ revoked: options.revoked }),
      { name: 'devices.insert', match: /INSERT INTO devices/, reply: { rows: [insertRow] } },
    ],
  });
}

// 라우터는 CSRF를 검사하지 않는다 — 토큰 클레임 중 sub/orgId만 라우트가 쓴다(INSERT params).
function validToken(): string {
  return makeAccessToken({ userId: 'user-1', sessionId: 'sess-1', orgId: 'org-1', role: 'doctor', name: 'Dr. Kim' });
}

function devicesApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/devices', createDevicesRouter(fake.pool)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/devices/register', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = makeFake(undefined, { revoked: true }); // no session

    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when publicKey is missing', async () => {
    const fake  = makeFake();
    const token = validToken();

    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ buildTarget: 'intranet' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when publicKey is not a valid 32-byte base64 key', async () => {
    const fake  = makeFake();
    const token = validToken();

    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: 'not-a-valid-ed25519-key', buildTarget: 'intranet' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when publicKey decodes to wrong length (not 32 bytes)', async () => {
    const fake  = makeFake();
    const token = validToken();

    const shortKey = crypto.randomBytes(16).toString('base64'); // 16 bytes, not 32

    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: shortKey, buildTarget: 'intranet' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when buildTarget is standalone (not permitted)', async () => {
    const fake  = makeFake();
    const token = validToken();

    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'standalone' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 201 with deviceId and pending status on new registration', async () => {
    const fake  = makeFake();
    const token = validToken();

    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBe('dev-1');
    expect(res.body.status).toBe('pending');
  });

  it('returns 200 when same key is re-registered (duplicate)', async () => {
    const fake  = makeFake({ id: 'dev-1', status: 'active', inserted: false });
    const token = validToken();

    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe('dev-1');
    expect(res.body.message).toContain('already registered');
  });

  it('stores publicKey, fingerprint, buildTarget in DB', async () => {
    const fake  = makeFake();
    const token = validToken();
    const pubKey = validPublicKey();

    await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ publicKey: pubKey, buildTarget: 'intranet' });

    const insertCall = fake.calls.find(c => c.sql.includes('INSERT INTO devices'));
    expect(insertCall).toBeDefined();
    const params = insertCall!.params;
    expect(params[0]).toBe('user-1');    // user_id
    expect(params[1]).toBe('org-1');     // organization_id
    expect(params[2]).toBe(pubKey);      // public_key
    expect(typeof params[3]).toBe('string'); // fingerprint (SHA-256 hex)
    expect((params[3] as string).length).toBe(64);
    expect(params[4]).toBe('intranet');  // build_target
  });

  it('returns 429 after exceeding IP rate limit', async () => {
    const fake  = makeFake({ id: 'dev-1', status: 'pending', inserted: true });
    const token = validToken();
    const app   = devicesApp(fake);

    // First request

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

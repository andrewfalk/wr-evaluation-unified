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

vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn() }));

import { createAuditRouter } from '../audit';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

// Generate a real Ed25519 key pair for signature tests
function makeKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

// Export public key as raw 32-byte base64 (the format stored in devices.public_key)
function exportPublicKey(pubKey: crypto.KeyObject): string {
  // DER SPKI for Ed25519 = 12 bytes header + 32 bytes raw key
  const der = pubKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(12).toString('base64');
}

// Build a valid Ed25519 signature over the canonical message
function signPayload(
  privKey:  crypto.KeyObject,
  deviceTs: string,
  body:     object
): string {
  const sorted = Object.fromEntries(
    Object.entries(body).sort(([a], [b]) => a.localeCompare(b))
  );
  const message = `${deviceTs}.${JSON.stringify(sorted)}`;
  return crypto.sign(null, Buffer.from(message), privKey).toString('base64');
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function userToken(userId = 'user-1'): string {
  return generateAccessToken({
    sub:                userId,
    sessionId:          'sess-1',
    orgId:              'org-1',
    role:               'doctor',
    name:               'Dr. Kim',
    mustChangePassword: false,
    csrfHash:           CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/audit', createAuditRouter(pool));
  return app;
}

// Wire: auth session check, then device SELECT result
function wireDevice(
  pool:       Pool,
  deviceRow:  object | null,
) {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });          // auth middleware
  mock.mockResolvedValueOnce({ rows: deviceRow ? [deviceRow] : [] }); // device SELECT
  mock.mockResolvedValue({ rows: [] });                           // last_seen_at UPDATE + any extra
}

const VALID_BODY = {
  action:  'emr_inject',
  outcome: 'success' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/audit/emr', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('x-wr-source', 'electron-main')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-WR-Source is missing or wrong', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/source/i);
  });

  it('returns 401 when device headers are missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source', 'electron-main')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing device headers/i);
  });

  it('returns 401 when timestamp is out of range', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool    = makePool();
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const sig     = signPayload(privateKey, staleTs, VALID_BODY);

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  staleTs)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/timestamp/i);
    // exportPublicKey is unused in this path; suppress lint
    void exportPublicKey(publicKey);
  });

  it('returns 400 on invalid body (unknown action)', async () => {
    const { privateKey } = makeKeyPair();
    const pool = makePool();
    const ts   = new Date().toISOString();
    const body = { action: 'unknown_action', outcome: 'success' };
    const sig  = signPayload(privateKey, ts, body);

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 401 when device does not exist', async () => {
    const { privateKey } = makeKeyPair();
    const pool = makePool();
    const ts   = new Date().toISOString();
    const sig  = signPayload(privateKey, ts, VALID_BODY);

    wireDevice(pool, null);

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-missing')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/device not found/i);
  });

  it('returns 401 when device is pending', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool = makePool();
    const ts   = new Date().toISOString();
    const sig  = signPayload(privateKey, ts, VALID_BODY);

    wireDevice(pool, {
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'pending',
    });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not active/i);
  });

  it('returns 401 when device is revoked', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool = makePool();
    const ts   = new Date().toISOString();
    const sig  = signPayload(privateKey, ts, VALID_BODY);

    wireDevice(pool, {
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'revoked',
    });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not active/i);
  });

  it('returns 401 when session.user !== device.user', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool = makePool();
    const ts   = new Date().toISOString();
    const sig  = signPayload(privateKey, ts, VALID_BODY);

    wireDevice(pool, {
      user_id:         'other-user-99',   // mismatch with session user-1
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken('user-1')}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('returns 401 when Ed25519 signature is invalid', async () => {
    const { publicKey }              = makeKeyPair();
    const { privateKey: wrongPriv }  = makeKeyPair();   // different key pair
    const pool = makePool();
    const ts   = new Date().toISOString();
    const sig  = signPayload(wrongPriv, ts, VALID_BODY); // signed with wrong key

    wireDevice(pool, {
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('returns 200 when approved device with valid signature', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool = makePool();
    const ts   = new Date().toISOString();
    const sig  = signPayload(privateKey, ts, VALID_BODY);

    wireDevice(pool, {
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('writes audit log on successful request', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const { privateKey, publicKey } = makeKeyPair();
    const pool = makePool();
    const ts   = new Date().toISOString();
    const sig  = signPayload(privateKey, ts, VALID_BODY);

    wireDevice(pool, {
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });

    await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',  ts)
      .send(VALID_BODY);

    expect(writeAuditLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        actorUserId: 'user-1',
        action:      'emr_inject',
        outcome:     'success',
      })
    );
  });
});

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

// Build a valid Ed25519 signature over the canonical message.
// Format: "<deviceId>.<deviceTs>.<deviceNonce>.<JSON-sorted-body>"
function signPayload(
  privKey:   crypto.KeyObject,
  deviceId:  string,
  deviceTs:  string,
  deviceNonce: string,
  body:      object
): string {
  const sorted = Object.fromEntries(
    Object.entries(body).sort(([a], [b]) => a.localeCompare(b))
  );
  const message = `${deviceId}.${deviceTs}.${deviceNonce}.${JSON.stringify(sorted)}`;
  return crypto.sign(null, Buffer.from(message), privKey).toString('base64');
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

// Each test must use a unique nonce (replay guard rejects duplicates within TTL)
function nonce(): string { return crypto.randomBytes(16).toString('hex'); }

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
    const devNonce = nonce();
    const staleTs  = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const sig      = signPayload(privateKey, 'dev-1', staleTs, devNonce, VALID_BODY);

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    staleTs)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/timestamp/i);
    void exportPublicKey(publicKey);
  });

  it('returns 400 on invalid body (unknown action)', async () => {
    const { privateKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const body     = { action: 'unknown_action', outcome: 'success' };
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, body);

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 401 when device does not exist', async () => {
    const { privateKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-missing', ts, devNonce, VALID_BODY);

    wireDevice(pool, null);

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-missing')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/device not found/i);
  });

  it('returns 401 when device is pending', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

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
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not active/i);
  });

  it('returns 401 when device is revoked', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

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
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not active/i);
  });

  it('returns 401 when session.user !== device.user', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    wireDevice(pool, {
      user_id:         'other-user-99',
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
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('returns 401 when Ed25519 signature is invalid', async () => {
    const { publicKey }             = makeKeyPair();
    const { privateKey: wrongPriv } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(wrongPriv, 'dev-1', ts, devNonce, VALID_BODY);

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
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('returns 200 when approved device with valid signature', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

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
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('writes audit log on successful request', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const { privateKey, publicKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

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
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
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

  it('returns 401 when device.organization_id !== session.organizationId', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    wireDevice(pool, {
      user_id:         'user-1',
      organization_id: 'different-org-99',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('returns 401 when device.organization_id is null but session has an org', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool     = makePool();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    wireDevice(pool, {
      user_id:         'user-1',
      organization_id: null,   // null org — rejected when session has org-1
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });

    const res = await request(makeApp(pool))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('returns 401 when same nonce is reused (replay attack)', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const pool1      = makePool();
    const pool2      = makePool();
    const app        = makeApp(pool1);
    const ts         = new Date().toISOString();
    const replayNonce = nonce();
    const sig         = signPayload(privateKey, 'dev-1', ts, replayNonce, VALID_BODY);

    wireDevice(pool1, {
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    await request(app)
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', replayNonce)
      .send(VALID_BODY);

    // Replay with same nonce — must be rejected even though signature is valid
    wireDevice(pool2, {
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const res2 = await request(makeApp(pool2))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', replayNonce)
      .send(VALID_BODY);

    expect(res2.status).toBe(401);
    expect(res2.body.error).toMatch(/nonce/i);
  });

  it('allows nonce reuse after a failed request (pendingNonces released)', async () => {
    // A request that fails verification (invalid sig) should release the nonce
    // from pendingNonces so the device can retry with the same nonce.
    const { privateKey, publicKey }    = makeKeyPair();
    const { privateKey: wrongPriv }    = makeKeyPair();
    const pool     = makePool();
    const app      = makeApp(pool);
    const ts       = new Date().toISOString();
    const devNonce = nonce();

    // First attempt: wrong key → signature invalid → nonce released
    const badSig = signPayload(wrongPriv, 'dev-1', ts, devNonce, VALID_BODY);
    wireDevice(pool, {
      user_id: 'user-1', organization_id: 'org-1',
      public_key: exportPublicKey(publicKey), status: 'active',
    });
    const res1 = await request(app)
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source', 'electron-main')
      .set('x-wr-device-id', 'dev-1')
      .set('x-wr-device-sig', badSig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);
    expect(res1.status).toBe(401);

    // Second attempt: correct key, same nonce → must succeed
    const goodSig = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);
    wireDevice(pool, {
      user_id: 'user-1', organization_id: 'org-1',
      public_key: exportPublicKey(publicKey), status: 'active',
    });
    const res2 = await request(app)
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source', 'electron-main')
      .set('x-wr-device-id', 'dev-1')
      .set('x-wr-device-sig', goodSig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);
    expect(res2.status).toBe(200);
  });
});

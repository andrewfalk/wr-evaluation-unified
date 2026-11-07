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
  writeAuditLog:       vi.fn(),
  writeAuditLogStrict: vi.fn().mockResolvedValue(undefined),
}));

import { createAuditRouter } from '../audit';
import { createFakePool, authSessionHandler, type FakePool, type QueryHandler } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Each test must use a unique nonce (replay guard rejects duplicates within TTL)
function nonce(): string { return crypto.randomBytes(16).toString('hex'); }

// CSRF 해시는 testing/tokens 기본값(sha256('ok')) — 기존 로컬 도우미와 같은 클레임.
function userToken(userId = 'user-1'): string {
  return makeAccessToken({ userId, sessionId: 'sess-1', orgId: 'org-1', role: 'doctor', name: 'Dr. Kim' });
}

// 세션 확인 쿼리(인증 미들웨어)에만 답하는 fake — 장치 SELECT까지 가지 않는 요청용.
// revoked면 세션 없음(빈 결과).
function makeSessionOnlyFake(options: { revoked?: boolean } = {}): FakePool {
  return createFakePool({ handlers: [authSessionHandler({ revoked: options.revoked })] });
}

function deviceHandlers(deviceRow: object | null): QueryHandler[] {
  return [
    { name: 'devices.select', match: /FROM devices WHERE id = \$1/, reply: { rows: deviceRow ? [deviceRow] : [] } },
    { name: 'devices.touch', match: /UPDATE devices SET last_seen_at = now\(\)/, reply: { rows: [] } },
  ];
}

// auth session check, then device SELECT result, then last_seen_at UPDATE
function makeDeviceFake(deviceRow: object | null): FakePool {
  return createFakePool({ handlers: [authSessionHandler(), ...deviceHandlers(deviceRow)] });
}

// For queue-replay requests that have no Authorization header.
// makeOptionalAuth skips the session check, so no auth query fires (no session handler → it would be unmatched).
function makeDeviceNoSessionFake(deviceRow: object | null): FakePool {
  return createFakePool({ handlers: deviceHandlers(deviceRow) });
}

function auditApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/audit', createAuditRouter(fake.pool)));
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
    const fake = makeSessionOnlyFake({ revoked: true });
    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('x-wr-source', 'electron-main')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-WR-Source is missing or wrong', async () => {
    const fake = makeSessionOnlyFake();
    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/source/i);
  });

  it('returns 401 when device headers are missing', async () => {
    const fake = makeSessionOnlyFake();
    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source', 'electron-main')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing device headers/i);
  });

  it('returns 401 when timestamp is out of range', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const fake    = makeSessionOnlyFake();
    const devNonce = nonce();
    const staleTs  = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const sig      = signPayload(privateKey, 'dev-1', staleTs, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake     = makeSessionOnlyFake();
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const body     = { action: 'unknown_action', outcome: 'success' };
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, body);

    const res = await request(auditApp(fake))
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
    const fake     = makeDeviceFake(null);
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-missing', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake     = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'pending',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake     = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'revoked',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake     = makeDeviceFake({
      user_id:         'other-user-99',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake     = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(wrongPriv, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake     = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const { writeAuditLogStrict } = await import('../../middleware/audit.js');
    const { privateKey, publicKey } = makeKeyPair();
    const fake     = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      fake.pool,
      expect.objectContaining({
        actorUserId: 'user-1',
        action:      'emr_inject',
        outcome:     'success',
      })
    );
  });

  it('returns 401 when device.organization_id !== session.organizationId', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const fake     = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'different-org-99',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake     = makeDeviceFake({
      user_id:         'user-1',
      organization_id: null,   // null org — rejected when session has org-1
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
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
    const fake1      = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const fake2      = makeDeviceFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const app        = auditApp(fake1);
    const ts         = new Date().toISOString();
    const replayNonce = nonce();
    const sig         = signPayload(privateKey, 'dev-1', ts, replayNonce, VALID_BODY);

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
    const res2 = await request(auditApp(fake2))
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

  // ── Queue-replay paths (no Authorization header) ─────────────────────────

  it('accepts queue replay without Authorization and records session_missing flag', async () => {
    const { writeAuditLogStrict } = await import('../../middleware/audit.js');
    const { privateKey, publicKey } = makeKeyPair();
    const fake     = makeDeviceNoSessionFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      // No Authorization header — simulates queue replay after session expiry
      .set('x-wr-source',       'electron-main')
      .set('x-wr-device-id',    'dev-1')
      .set('x-wr-device-sig',   sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    // Actor falls back to device.user_id / device.organization_id
    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      fake.pool,
      expect.objectContaining({
        actorUserId: 'user-1',
        actorOrgId:  'org-1',
        extra:       expect.objectContaining({ session_missing: true, actor_from_queue: true }),
      })
    );
  });

  it('accepts audit_queue_corrupt action without Authorization', async () => {
    const { privateKey, publicKey } = makeKeyPair();
    const fake      = makeDeviceNoSessionFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts        = new Date().toISOString();
    const devNonce  = nonce();
    const corruptBody = { action: 'audit_queue_corrupt', outcome: 'failure' as const };
    const sig = signPayload(privateKey, 'dev-1', ts, devNonce, corruptBody);

    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('x-wr-source',       'electron-main')
      .set('x-wr-device-id',    'dev-1')
      .set('x-wr-device-sig',   sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(corruptBody);

    expect(res.status).toBe(200);
  });

  it('rejects invalid signature even without Authorization header', async () => {
    const { publicKey }             = makeKeyPair();
    const { privateKey: wrongPriv } = makeKeyPair();
    const fake     = makeDeviceNoSessionFake({
      user_id:         'user-1',
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(wrongPriv, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('x-wr-source',       'electron-main')
      .set('x-wr-device-id',    'dev-1')
      .set('x-wr-device-sig',   sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('allows nonce reuse after a failed request (pendingNonces released)', async () => {
    // A request that fails verification (invalid sig) should release the nonce
    // from pendingNonces so the device can retry with the same nonce.
    const { privateKey, publicKey }    = makeKeyPair();
    const { privateKey: wrongPriv }    = makeKeyPair();
    const fake     = makeDeviceFake({
      user_id: 'user-1', organization_id: 'org-1',
      public_key: exportPublicKey(publicKey), status: 'active',
    });
    const app      = auditApp(fake);
    const ts       = new Date().toISOString();
    const devNonce = nonce();

    // First attempt: wrong key → signature invalid → nonce released
    const badSig = signPayload(wrongPriv, 'dev-1', ts, devNonce, VALID_BODY);
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

  it('releases nonce when writeAuditLogStrict fails, allowing retry with same nonce', async () => {
    // If the DB INSERT throws after signature verification, the nonce must NOT be
    // committed to seenNonces. The device must be able to retry with the same
    // nonce+signature and succeed on the next attempt.
    const { writeAuditLogStrict } = await import('../../middleware/audit.js');
    const { privateKey, publicKey } = makeKeyPair();
    const fake     = makeDeviceFake({
      user_id: 'user-1', organization_id: 'org-1',
      public_key: exportPublicKey(publicKey), status: 'active',
    });
    const app      = auditApp(fake);
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    // First attempt: DB fails after signature verification
    (writeAuditLogStrict as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('DB connection lost')
    );
    const res1 = await request(app)
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);
    expect(res1.status).toBe(500);
    expect(res1.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

    // Second attempt: same nonce+sig, DB now succeeds → must not get 401
    const res2 = await request(app)
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);
    expect(res2.status).toBe(200);
  });

  it('returns code UNAUTHORIZED (not TOKEN_INVALID/SESSION_REVOKED) on device/session mismatch', async () => {
    // The Electron client retries without auth ONLY for TOKEN_INVALID / SESSION_REVOKED.
    // Mismatch must return UNAUTHORIZED so doSendWithSessionFallback() does NOT retry,
    // preserving the device.user_id ≡ session.user_id identity enforcement.
    const { privateKey, publicKey } = makeKeyPair();
    const fake     = makeDeviceFake({
      user_id:         'other-user-99', // device owned by a different user
      organization_id: 'org-1',
      public_key:      exportPublicKey(publicKey),
      status:          'active',
    });
    const ts       = new Date().toISOString();
    const devNonce = nonce();
    const sig      = signPayload(privateKey, 'dev-1', ts, devNonce, VALID_BODY);

    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken('user-1')}`)
      .set('x-wr-source',     'electron-main')
      .set('x-wr-device-id',  'dev-1')
      .set('x-wr-device-sig', sig)
      .set('x-wr-device-ts',    ts)
      .set('x-wr-device-nonce', devNonce)
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.code).not.toBe('TOKEN_INVALID');
    expect(res.body.code).not.toBe('SESSION_REVOKED');
  });
});

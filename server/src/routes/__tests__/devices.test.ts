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
import { writeAuditLog } from '../../middleware/audit';
import { keyFingerprint } from '../../devices/pcIdentity';
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

interface Row { id: string; user_id: string; organization_id: string | null; status: string; registered_at: string; public_key: string }

// 살아 있는 세션(인증 미들웨어) + devices 표 흉내(지문 잠금·조회·삽입·last_seen). revoked면 세션 없음.
function makeFake(existing: Row[] = [], options: { revoked?: boolean } = {}): FakePool & { inserted: unknown[][] } {
  const inserted: unknown[][] = [];
  const fake = createFakePool({
    handlers: [
      authSessionHandler({ revoked: options.revoked }),
      { name: 'devices.lock', via: 'client', match: /pg_advisory_xact_lock/, reply: { rows: [{}] } },
      { name: 'devices.byFingerprint', via: 'client', match: /FROM devices WHERE public_key_fingerprint = \$1/, reply: { rows: existing } },
      { name: 'devices.touch', via: 'client', match: /UPDATE devices SET last_seen_at/, reply: { rows: [] } },
      {
        name: 'devices.insert', via: 'client', match: /INSERT INTO devices/,
        reply: (_sql, params) => { inserted.push([...params]); return { rows: [{ id: 'dev-new' }] }; },
      },
    ],
  });
  return Object.assign(fake, { inserted });
}

function token(userId = 'user-1', orgId: string | null = 'org-1'): string {
  return makeAccessToken({ userId, sessionId: 'sess-1', orgId, role: 'doctor', name: 'Dr. Kim' });
}

function devicesApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/devices', createDevicesRouter(fake.pool)));
}

const register = (fake: FakePool, publicKey = validPublicKey(), tok = token()) => request(devicesApp(fake))
  .post('/api/devices/register')
  .set('Authorization', `Bearer ${tok}`)
  .set('User-Agent', 'x Electron/22.3.27')
  .send({ publicKey, buildTarget: 'intranet' });

const row = (overrides: Partial<Row>): Row => ({
  id: crypto.randomUUID(), user_id: 'user-1', organization_id: 'org-1', status: 'active',
  registered_at: '2026-01-01T00:00:00.000Z', public_key: 'k', ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/devices/register', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = makeFake([], { revoked: true }); // no session
    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });
    expect(res.status).toBe(401);
  });

  it.each([
    ['publicKey is missing', { buildTarget: 'intranet' }],
    ['publicKey is not a valid 32-byte base64 key', { publicKey: 'not-a-valid-ed25519-key', buildTarget: 'intranet' }],
    ['publicKey decodes to wrong length', { publicKey: crypto.randomBytes(16).toString('base64'), buildTarget: 'intranet' }],
    ['buildTarget is standalone (not permitted)', { publicKey: crypto.randomBytes(32).toString('base64'), buildTarget: 'standalone' }],
  ])('returns 400 when %s', async (_name, body) => {
    const fake = makeFake();
    const res = await request(devicesApp(fake))
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token()}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('a new key: 201, a pending row with the key, fingerprint and build target, under the fingerprint lock', async () => {
    const fake = makeFake();
    const pubKey = validPublicKey();
    const res = await register(fake, pubKey);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ deviceId: 'dev-new', status: 'pending', deviceScope: 'pc', organizationId: 'org-1' });
    expect(fake.inserted).toHaveLength(1);
    const params = fake.inserted[0];
    expect(params[0]).toBe('user-1');                  // user_id
    expect(params[1]).toBe('org-1');                   // organization_id
    expect(params[2]).toBe(pubKey);                    // public_key
    expect(params[3]).toBe(keyFingerprint(pubKey));    // fingerprint (SHA-256 hex)
    expect(params[4]).toBe('intranet');                // build_target
    expect(fake.callsTo('devices.lock')).toHaveLength(1);
    expect(fake.transactions).toEqual([{ clientId: 1, statements: ['BEGIN', 'COMMIT'], outcome: 'commit' }]);
    expect(vi.mocked(writeAuditLog).mock.calls[0][1]).toMatchObject({ action: 'device_register', targetId: 'dev-new', outcome: 'success' });
  });

  it('the organisation already has this PC (another user registered it): 200, no new row, the PC\'s first row and status', async () => {
    const first = row({ user_id: 'user-9', registered_at: '2026-01-01T00:00:00.000Z' });
    const fake = makeFake([row({ user_id: 'user-8', registered_at: '2026-02-01T00:00:00.000Z' }), first]);
    const res = await register(fake);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deviceId: first.id, status: 'active', deviceScope: 'pc', organizationId: 'org-1' });
    expect(res.body.message).toContain('already registered');
    expect(fake.inserted).toHaveLength(0);
    expect(fake.callsTo('devices.touch')).toHaveLength(1);
    expect(vi.mocked(writeAuditLog).mock.calls[0][1]).toMatchObject({ action: 'device_register_duplicate', targetId: first.id, extra: { pcStatus: 'active' } });
  });

  it('a revoked PC stays revoked on registration (status revoked, no new row)', async () => {
    const fake = makeFake([row({ status: 'active' }), row({ status: 'revoked', registered_at: '2026-03-01T00:00:00.000Z' })]);
    const res = await register(fake);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
    expect(fake.inserted).toHaveLength(0);
  });

  it('the key is registered in another organisation: 409, no row, a denial row without that organisation', async () => {
    const fake = makeFake([row({ organization_id: 'org-2' })]);
    const res = await register(fake);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'DEVICE_REGISTERED_TO_OTHER_ORG',
      error: 'This device is registered to another organization',
      deviceScope: 'pc',
      status: 'other_org',
      organizationId: 'org-1',
    });
    expect(fake.inserted).toHaveLength(0);
    const entry = vi.mocked(writeAuditLog).mock.calls[0][1];
    expect(entry).toMatchObject({ action: 'device_register_other_org', outcome: 'denied', actorOrgId: 'org-1', targetId: null });
    expect(JSON.stringify(entry)).not.toContain('org-2');
  });

  it('an account without an organisation counts null as its organisation', async () => {
    const fake = makeFake([row({ organization_id: null })]);
    const res = await register(fake, validPublicKey(), token('admin-1', null));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ organizationId: null, status: 'active' });
    const other = makeFake([row({ organization_id: 'org-1' })]);
    expect((await register(other, validPublicKey(), token('admin-1', null))).status).toBe(409);
  });

  it('returns 429 after exceeding IP rate limit', async () => {
    const fake = makeFake();
    const app = devicesApp(fake);
    const send = () => request(app)
      .post('/api/devices/register')
      .set('Authorization', `Bearer ${token()}`)
      .send({ publicKey: validPublicKey(), buildTarget: 'intranet' });
    await send();
    const res2 = await send();
    expect(res2.status).toBe(429);
    expect(res2.body.code).toBe('RATE_LIMITED');
  });
});

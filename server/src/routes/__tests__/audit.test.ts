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

import { createAuditRouter, type AuditRouterOptions } from '../audit';
import { writeAuditLog, writeAuditLogStrict } from '../../middleware/audit';
import { keyFingerprint } from '../../devices/pcIdentity';
import { SERVER_RESERVED_EXTRA_KEYS } from '../../devices/emrAuditRecord';
import { createFakePool, authSessionHandler, type FakePool, type QueryHandler } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A "PC" = one signing key. Registration rows: one per user who registered that key.
interface Pc {
  privateKey: crypto.KeyObject;
  publicKey: string; // raw 32-byte Ed25519 key, base64 (devices.public_key)
  fingerprint: string;
}

function makePc(): Pc {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');
  return { privateKey, publicKey: raw, fingerprint: keyFingerprint(raw) };
}

interface DeviceRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  status: 'pending' | 'active' | 'revoked';
  registered_at: string;
  public_key: string;
  public_key_fingerprint: string;
}

let rowSeq = 0;
function row(pc: Pc, overrides: Partial<DeviceRow> = {}): DeviceRow {
  rowSeq += 1;
  return {
    id: crypto.randomUUID(),
    user_id: 'user-1',
    organization_id: 'org-1',
    status: 'active',
    registered_at: new Date(Date.UTC(2026, 0, 1, 0, 0, rowSeq)).toISOString(),
    public_key: pc.publicKey,
    public_key_fingerprint: pc.fingerprint,
    ...overrides,
  };
}

// Canonical message: "<header id>.<ts>.<nonce>.<JSON-sorted-body>"
function signPayload(privKey: crypto.KeyObject, headerId: string, ts: string, devNonce: string, body: object): string {
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.sign(null, Buffer.from(`${headerId}.${ts}.${devNonce}.${JSON.stringify(sorted)}`), privKey).toString('base64');
}

function nonce(): string { return crypto.randomBytes(16).toString('hex'); }

function userToken(userId = 'user-1', orgId: string | null = 'org-1'): string {
  return makeAccessToken({ userId, sessionId: 'sess-1', orgId, role: 'doctor', name: 'Dr. Kim' });
}

// emr_audit_nonces as the handler uses it (SEC-A L11): keys claimed in a transaction (the request nonce and, for a
// current-shell event, its event marker) are kept on COMMIT and dropped on ROLLBACK; the pre-check and later claims
// see only kept ones. One store per fake (per test).
function nonceHandlers(): QueryHandler[] {
  const committed = new Set<string>();
  let pending: string[] = [];
  return [
    {
      name: 'nonce.seen', via: 'pool', match: /SELECT 1 FROM emr_audit_nonces/,
      reply: (_sql, params) => ((params[0] as string[]).some((id) => committed.has(`${id}:${String(params[1])}`)) ? { rows: [{ '?column?': 1 }] } : { rows: [] }),
    },
    {
      name: 'nonce.claim', via: 'client', match: /INSERT INTO emr_audit_nonces/,
      reply: (_sql, params) => {
        const key = `${String(params[0])}:${String(params[1])}`;
        if (committed.has(key) || pending.includes(key)) return { rows: [], rowCount: 0 };
        pending.push(key);
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      },
    },
    { name: 'tx.commit', via: 'client', match: /^\s*COMMIT\b/, reply: () => { for (const key of pending) committed.add(key); pending = []; return { rows: [] }; } },
    { name: 'tx.rollback', via: 'client', match: /^\s*ROLLBACK\b/, reply: () => { pending = []; return { rows: [] }; } },
  ];
}

// The devices table: the key scan (GROUP BY fingerprint), one key's rows, last_seen_at.
function deviceHandlers(rows: DeviceRow[]): QueryHandler[] {
  return [
    {
      name: 'devices.scan', match: /GROUP BY public_key_fingerprint/,
      reply: () => {
        const byFp = new Map<string, DeviceRow[]>();
        for (const r of rows) byFp.set(r.public_key_fingerprint, [...(byFp.get(r.public_key_fingerprint) ?? []), r]);
        return {
          rows: [...byFp.entries()].map(([fp, rs]) => ({
            fp,
            public_key: rs[0].public_key,
            has_active: rs.some((r) => r.status === 'active'),
            last_registered: rs.map((r) => r.registered_at).sort().at(-1),
          })),
        };
      },
    },
    {
      name: 'devices.byFingerprint', match: /FROM devices WHERE public_key_fingerprint = \$1/,
      reply: (_sql, params) => ({ rows: rows.filter((r) => r.public_key_fingerprint === params[0]) }),
    },
    { name: 'devices.touch', match: /UPDATE devices SET last_seen_at = now\(\)/, reply: { rows: [] } },
    ...nonceHandlers(),
  ];
}

// users(id → organization_id) for the current shell's actor claim.
const USERS: Record<string, string | null> = {};
function usersHandler(): QueryHandler {
  return {
    name: 'users.org', match: /SELECT organization_id FROM users WHERE id = \$1/,
    reply: (_sql, params) => (String(params[0]) in USERS ? { rows: [{ organization_id: USERS[String(params[0])] }] } : { rows: [] }),
  };
}

function makeFake(rows: DeviceRow[], options: { session?: boolean } = {}): FakePool {
  return createFakePool({ handlers: [...(options.session === false ? [] : [authSessionHandler()]), usersHandler(), ...deviceHandlers(rows)] });
}

function auditApp(fake: FakePool, options: AuditRouterOptions = {}) {
  return makeRouterApp(a => a.use('/api/audit', createAuditRouter(fake.pool, options)));
}

const VALID_BODY = {
  action:  'emr_inject',
  outcome: 'success' as const,
};

interface SendOptions {
  headerId?: string;
  token?: string | null;
  body?: object;
  devNonce?: string;
  ts?: string;
  signWith?: crypto.KeyObject;
  sig?: string;
}

// A signed request. `token: null` → no Authorization (a queue replay after the session ended).
function send(app: ReturnType<typeof auditApp>, pc: Pc, options: SendOptions = {}) {
  const headerId = options.headerId ?? SHELL_ID;
  const body = options.body ?? VALID_BODY;
  const ts = options.ts ?? new Date().toISOString();
  const devNonce = options.devNonce ?? nonce();
  const sig = options.sig ?? signPayload(options.signWith ?? pc.privateKey, headerId, ts, devNonce, body);
  let req = request(app)
    .post('/api/audit/emr')
    .set('x-wr-source', 'electron-main')
    .set('x-wr-device-id', headerId)
    .set('x-wr-device-sig', sig)
    .set('x-wr-device-ts', ts)
    .set('x-wr-device-nonce', devNonce);
  const token = options.token === undefined ? userToken() : options.token;
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

// The shell's own device id — never the id of a registration row.
const SHELL_ID = '6f1c1d3e-8f7a-4c55-9b1e-2a3b4c5d6e7f';

function lastAuditEntry(): { actorUserId: string | null; actorOrgId: string | null; extra: Record<string, unknown> } {
  return vi.mocked(writeAuditLogStrict).mock.calls.at(-1)![1] as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/audit/emr', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── Request shape ─────────────────────────────────────────────────────────

  it('returns 401 when device headers are missing (no token either)', async () => {
    const fake = makeFake([]);
    const res = await request(auditApp(fake)).post('/api/audit/emr').set('x-wr-source', 'electron-main').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-WR-Source is missing or wrong', async () => {
    const fake = makeFake([]);
    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/source/i);
  });

  it('returns 401 when device headers are missing', async () => {
    const fake = makeFake([]);
    const res = await request(auditApp(fake))
      .post('/api/audit/emr')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-wr-source', 'electron-main')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing device headers/i);
  });

  it('returns 401 when timestamp is out of range', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const res = await send(auditApp(fake), pc, { ts: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/timestamp/i);
  });

  it('returns 400 on invalid body (unknown action)', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const res = await send(auditApp(fake), pc, { body: { action: 'unknown_action', outcome: 'success' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('a device id header that is not a UUID → 401 without a database lookup', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const res = await send(auditApp(fake), pc, { headerId: 'dev-1' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'UNAUTHORIZED', error: 'Device not recognized' });
    expect(fake.callsTo('devices.scan')).toHaveLength(0);
    expect(fake.callsTo('devices.byFingerprint')).toHaveLength(0);
  });

  // ── Finding the PC by signature ───────────────────────────────────────────

  it('accepts a request signed with the shell\'s own id; the row is keyed by the PC\'s first registration', async () => {
    const pc = makePc();
    const first = row(pc);
    const fake = makeFake([first]);
    const res = await send(auditApp(fake), pc);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(Function), release: expect.any(Function) }),
      expect.objectContaining({ actorUserId: 'user-1', actorOrgId: 'org-1', action: 'emr_inject', outcome: 'success', targetType: 'emr' }),
    );
    expect(lastAuditEntry().extra).toMatchObject({ deviceId: first.id, header_device_id: SHELL_ID, source: 'electron-main' });
    expect(fake.callsTo('nonce.claim')[0].params).toEqual([first.id, expect.any(String)]);
    expect(fake.callsTo('devices.touch')[0].params).toEqual([pc.fingerprint]);
    expect(fake.transactions).toEqual([{ clientId: 1, statements: ['BEGIN', 'COMMIT'], outcome: 'commit' }]);
    fake.assertAllReleased();
  });

  it('an unregistered key → 401 "Device not recognized"', async () => {
    const registered = makePc();
    const stranger = makePc();
    const fake = makeFake([row(registered)]);
    const res = await send(auditApp(fake), stranger);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'UNAUTHORIZED', error: 'Device not recognized' });
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('a wrong signature → 401 with the same answer, with or without a session', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake);
    const wrong = makePc().privateKey;
    for (const token of [userToken(), null]) {
      const res = await send(app, pc, { signWith: wrong, token });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'UNAUTHORIZED', error: 'Device not recognized' });
    }
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('a known header id is checked against its remembered key first; a wrong signature falls back to the limited full scan', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake);
    expect((await send(app, pc)).status).toBe(200);
    expect(fake.callsTo('devices.scan')).toHaveLength(1);
    expect((await send(app, pc)).status).toBe(200);
    expect(fake.callsTo('devices.scan')).toHaveLength(1); // remembered: no scan
    const forged = await send(app, pc, { signWith: makePc().privateKey });
    expect(forged.status).toBe(401);
    expect(fake.callsTo('devices.scan')).toHaveLength(2);
  });

  it("another registered key signing with an approved PC's header id first does not shut that PC out", async () => {
    const approved = makePc();
    const other = makePc();
    const fake = makeFake([row(approved), row(other, { status: 'pending', user_id: 'user-2' })]);
    const app = auditApp(fake);
    const first = await send(app, other, { headerId: SHELL_ID });
    expect(first.status).toBe(401); // the other key is not approved
    for (let i = 0; i < 2; i += 1) expect((await send(app, approved, { headerId: SHELL_ID })).status).toBe(200);
    expect((await send(app, other, { headerId: SHELL_ID })).status).toBe(401);
    expect((await send(app, approved, { headerId: SHELL_ID })).status).toBe(200);
  });

  it('a pending PC → 401; a PC with any revoked row → 401 even when another row is active', async () => {
    const pending = makePc();
    const revoked = makePc();
    const fake = makeFake([
      row(pending, { status: 'pending' }),
      row(revoked, { status: 'active', user_id: 'user-1' }),
      row(revoked, { status: 'revoked', user_id: 'user-2' }),
    ]);
    const app = auditApp(fake);
    for (const pc of [pending, revoked]) {
      const res = await send(app, pc, { headerId: crypto.randomUUID() });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'UNAUTHORIZED', error: 'Device not recognized' });
    }
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('a signed request from a revoked PC leaves one denial summary per PC per window (none for unsigned ones)', async () => {
    const pc = makePc();
    const first = row(pc, { status: 'active' });
    const fake = makeFake([first, row(pc, { status: 'revoked', user_id: 'user-2' })]);
    const app = auditApp(fake);
    expect((await send(app, pc, { signWith: makePc().privateKey })).status).toBe(401); // bad signature: nothing
    expect(writeAuditLog).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i += 1) expect((await send(app, pc, { token: i === 0 ? undefined : null })).status).toBe(401);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAuditLog).mock.calls[0][1]).toMatchObject({
      actorUserId: 'user-1', actorOrgId: 'org-1', action: 'emr_audit_denied', targetType: 'device', targetId: first.id, outcome: 'denied',
      extra: { pcStatus: 'revoked', emrAction: 'emr_inject', header_device_id: SHELL_ID },
    });
  });

  it('the denial summary names the session user only when the session belongs to the PC\'s organisation', async () => {
    const pc = makePc();
    const first = row(pc, { status: 'pending', organization_id: 'org-1' });
    const fake = makeFake([first]);
    const res = await send(auditApp(fake), pc, { token: userToken('user-9', 'org-9') });
    expect(res.status).toBe(401);
    expect(vi.mocked(writeAuditLog).mock.calls[0][1]).toMatchObject({ actorUserId: null, actorOrgId: 'org-1', action: 'emr_audit_denied' });
    expect(JSON.stringify(vi.mocked(writeAuditLog).mock.calls[0][1])).not.toContain('user-9');
  });

  it('an approved PC is found even when more unapproved keys exist than the scan tries', async () => {
    const approved = makePc();
    const rows = [row(approved, { registered_at: '2020-01-01T00:00:00.000Z' })];
    for (let i = 0; i < 6; i += 1) {
      const other = makePc();
      rows.push(row(other, { status: i % 2 ? 'pending' : 'revoked', registered_at: `2026-02-0${i + 1}T00:00:00.000Z` }));
    }
    const fake = makeFake(rows);
    const res = await send(auditApp(fake, { resolver: { inactiveKeyCap: 2 } }), approved);
    expect(res.status).toBe(200);
  });

  it('forged requests with unknown header ids cannot exceed the full-scan limit; a known PC still gets through', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake, { resolver: { scansPerMinute: 3 } });
    expect((await send(app, pc)).status).toBe(200); // scan 1 — the PC's header id is now known
    const results: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const forgedPc = makePc();
      results.push((await send(app, forgedPc, { headerId: crypto.randomUUID(), token: null })).status);
    }
    expect(results.filter((s) => s === 401)).toHaveLength(2); // scans 2 and 3
    expect(results.filter((s) => s === 429)).toHaveLength(4); // nothing scanned
    expect(fake.callsTo('devices.scan')).toHaveLength(3);
    expect((await send(app, pc)).status).toBe(200); // known PC: no scan needed
    expect(fake.callsTo('devices.scan')).toHaveLength(3);
  });

  // ── One PC, several users, organisations ──────────────────────────────────

  it('one PC registered by two users: either user of the organisation is recorded as the actor (no user match required)', async () => {
    const pc = makePc();
    const first = row(pc, { user_id: 'user-1' });
    const fake = makeFake([first, row(pc, { user_id: 'user-2' })]);
    const app = auditApp(fake);
    expect((await send(app, pc, { token: userToken('user-2') })).status).toBe(200);
    expect(lastAuditEntry()).toMatchObject({ actorUserId: 'user-2', actorOrgId: 'org-1' });
    expect(lastAuditEntry().extra).toMatchObject({ deviceId: first.id });
    // A user of the same organisation who never registered this PC.
    expect((await send(app, pc, { token: userToken('user-3') })).status).toBe(200);
    expect(lastAuditEntry()).toMatchObject({ actorUserId: 'user-3', actorOrgId: 'org-1' });
  });

  it('a session of another organisation → 401 mismatch and one denial row per PC per window', async () => {
    const pc = makePc();
    const first = row(pc, { organization_id: 'org-1' });
    const fake = makeFake([first]);
    const app = auditApp(fake);
    for (let i = 0; i < 3; i += 1) {
      const res = await send(app, pc, { token: userToken('user-9', 'org-9') });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'UNAUTHORIZED', error: 'Device / session identity mismatch' });
    }
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAuditLog).mock.calls[0][1]).toMatchObject({
      actorUserId: 'user-9', actorOrgId: 'org-9', action: 'device_org_mismatch', targetType: 'device', targetId: first.id, outcome: 'denied',
      extra: { deviceOrgId: 'org-1', header_device_id: SHELL_ID },
    });
  });

  it('a PC without an organisation and a session with one → 401 mismatch', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc, { organization_id: null })]);
    const res = await send(auditApp(fake), pc);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('an account without an organisation is not checked; the row belongs to the PC\'s organisation', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc, { organization_id: 'org-1' })]);
    const res = await send(auditApp(fake), pc, { token: userToken('admin-1', null) });
    expect(res.status).toBe(200);
    expect(lastAuditEntry()).toMatchObject({ actorUserId: 'admin-1', actorOrgId: 'org-1' });
  });

  it('a key registered in several organisations: recorded without actor or organisation, flagged org_unresolved', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc, { organization_id: 'org-1', user_id: 'user-1' }), row(pc, { organization_id: 'org-2', user_id: 'user-2' })]);
    const app = auditApp(fake);
    expect((await send(app, pc, { token: null })).status).toBe(200);
    expect(lastAuditEntry()).toMatchObject({ actorUserId: null, actorOrgId: null });
    expect(lastAuditEntry().extra).toMatchObject({ org_unresolved: true, actor_uncertain: true, session_missing: true });
    expect((await send(app, pc, { token: userToken('user-2', 'org-2') })).status).toBe(200);
    expect(lastAuditEntry()).toMatchObject({ actorUserId: null, actorOrgId: null });
    expect(lastAuditEntry().extra).toMatchObject({ org_unresolved: true, sent_by_user_id: 'user-2' });
    // An organisation that has no row of this key is still refused.
    expect((await send(app, pc, { token: userToken('user-9', 'org-9') })).status).toBe(401);
  });

  // ── Actor and flags (older shells) ────────────────────────────────────────

  it('an older shell\'s event with a session: session user, flagged uncertain / older shell / time unknown', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    expect((await send(auditApp(fake), pc)).status).toBe(200);
    expect(lastAuditEntry()).toMatchObject({ actorUserId: 'user-1', actorOrgId: 'org-1' });
    expect(lastAuditEntry().extra).toMatchObject({
      actor_uncertain: true, actor_source: 'session_fallback', legacy_shell: true, occurred_at_unknown: true,
    });
    expect(lastAuditEntry().extra).not.toHaveProperty('session_missing');
  });

  it('a queue replay without a session: actor = registrant of the PC\'s first active row, flagged', async () => {
    const pc = makePc();
    const fake = makeFake([
      row(pc, { user_id: 'user-0', status: 'pending' }),
      row(pc, { user_id: 'user-1', status: 'active' }),
      row(pc, { user_id: 'user-2', status: 'active' }),
    ], { session: false });
    const res = await send(auditApp(fake), pc, { token: null });
    expect(res.status).toBe(200);
    expect(lastAuditEntry()).toMatchObject({ actorUserId: 'user-1', actorOrgId: 'org-1' });
    expect(lastAuditEntry().extra).toMatchObject({
      session_missing: true, actor_from_queue: true, actor_uncertain: true, actor_source: 'device_registrant',
    });
  });

  it('accepts audit_queue_corrupt without Authorization', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)], { session: false });
    const res = await send(auditApp(fake), pc, { token: null, body: { action: 'audit_queue_corrupt', outcome: 'failure' } });
    expect(res.status).toBe(200);
  });

  it("the current shell's marker turns off the older-shell flags (legacy_shell, burst); without an event time it is unknown", async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const body = { ...VALID_BODY, extra: { shellAudit: 2 } };
    expect((await send(auditApp(fake), pc, { body })).status).toBe(200);
    expect(lastAuditEntry().extra).not.toHaveProperty('legacy_shell');
    expect(lastAuditEntry().extra).toMatchObject({ occurred_at_unknown: true });
  });

  it('an older shell\'s events sent back to back are flagged as a burst (the first one is not)', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake);
    expect((await send(app, pc)).status).toBe(200);
    expect(lastAuditEntry().extra).not.toHaveProperty('burst');
    expect((await send(app, pc)).status).toBe(200);
    expect(lastAuditEntry().extra).toMatchObject({ burst: true });
  });

  it('events further apart than the burst gap are not flagged', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake, { burstGapMs: 20 });
    expect((await send(app, pc)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 40));
    expect((await send(app, pc)).status).toBe(200);
    expect(lastAuditEntry().extra).not.toHaveProperty('burst');
  });

  it('server-reserved keys sent by the client are removed; the client\'s source is kept as client_source', async () => {
    const pc = makePc();
    const first = row(pc);
    const fake = makeFake([first]);
    const forged: Record<string, unknown> = Object.fromEntries(SERVER_RESERVED_EXTRA_KEYS.map((k) => [k, 'forged']));
    forged.source = 'edited';
    forged.kept = 'yes';
    const body = { ...VALID_BODY, extra: forged };
    expect((await send(auditApp(fake), pc, { body })).status).toBe(200);
    const extra = lastAuditEntry().extra;
    expect(extra).toMatchObject({
      kept: 'yes', client_source: 'edited', deviceId: first.id, header_device_id: SHELL_ID, source: 'electron-main',
      actor_source: 'session_fallback', actor_uncertain: true, legacy_shell: true,
    });
    for (const key of SERVER_RESERVED_EXTRA_KEYS) expect(extra[key]).not.toBe('forged');
    // A session-authenticated request cannot record itself as a queue replay.
    expect(extra).not.toHaveProperty('session_missing');
    expect(extra).not.toHaveProperty('actor_from_queue');
  });

  // ── Nonces ────────────────────────────────────────────────────────────────

  it('a reused nonce → 401, also on another app instance and when resent without the token', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const ts = new Date().toISOString();
    const devNonce = nonce();
    expect((await send(auditApp(fake), pc, { ts, devNonce })).status).toBe(200);
    // Same database, new process: the nonce is in the database, not in memory.
    const again = await send(auditApp(fake), pc, { ts, devNonce });
    expect(again.status).toBe(401);
    expect(again.body.error).toMatch(/nonce/i);
    // The same signed request without the Authorization header (a shell's fallback after a token error).
    const tokenless = await send(auditApp(fake), pc, { ts, devNonce, token: null });
    expect(tokenless.status).toBe(401);
    expect(tokenless.body.error).toMatch(/nonce/i);
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
  });

  it('allows the nonce after a failed request (bad signature first)', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake);
    const ts = new Date().toISOString();
    const devNonce = nonce();
    expect((await send(app, pc, { ts, devNonce, signWith: makePc().privateKey })).status).toBe(401);
    expect((await send(app, pc, { ts, devNonce })).status).toBe(200);
  });

  it('releases the nonce when writing the audit row fails, so the same signed request can be resent', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake);
    const ts = new Date().toISOString();
    const devNonce = nonce();
    vi.mocked(writeAuditLogStrict).mockRejectedValueOnce(new Error('DB connection lost'));
    const first = await send(app, pc, { ts, devNonce });
    expect(first.status).toBe(500);
    expect(first.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
    expect((await send(app, pc, { ts, devNonce })).status).toBe(200);
    fake.assertAllReleased();
  });

  it('device problems answer UNAUTHORIZED (not a token code), so a shell does not retry them without its token', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc, { organization_id: 'org-1' })]);
    const res = await send(auditApp(fake), pc, { token: userToken('user-9', 'org-9') });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  // ── Limits ────────────────────────────────────────────────────────────────

  it('requests sent one by one are never refused by the PC limit, only slowed down', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake, { pcBurst: 2, pcRatePerSec: 50, pcMaxWaiting: 1 });
    const started = Date.now();
    for (let i = 0; i < 8; i += 1) expect((await send(app, pc)).status).toBe(200);
    // 2 at once, then 6 at 50/s ≈ 120 ms of waiting.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(8);
  });

  it('requests sent all at once (with or without the shell marker) cannot exceed the PC\'s allowance', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake, { pcBurst: 3, pcRatePerSec: 20, pcMaxWaiting: 1 });
    expect((await send(app, pc)).status).toBe(200); // the PC is known now (no key scan per request below)
    const bodies = Array.from({ length: 6 }, (_, i) => (i % 2 ? { ...VALID_BODY, extra: { shellAudit: 2 } } : VALID_BODY));
    const results = await Promise.all(bodies.map((body) => send(app, pc, { body })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]); // the 2 left of the burst + 1 waiting
    const limited = results.find((r) => r.status === 429)!;
    expect(limited.body).toEqual({ code: 'RATE_LIMITED', error: 'Too many audit events from this device, please retry later' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(4);
  });

  it('a replayed (already recorded) nonce or a bad signature does not use up the PC\'s allowance', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake, { pcBurst: 2, pcRatePerSec: 0.001, pcMaxWaiting: 0 });
    const ts = new Date().toISOString();
    const devNonce = nonce();
    expect((await send(app, pc, { ts, devNonce })).status).toBe(200);
    for (let i = 0; i < 3; i += 1) expect((await send(app, pc, { ts, devNonce })).status).toBe(401);
    expect((await send(app, pc, { signWith: makePc().privateKey })).status).toBe(401);
    expect((await send(app, pc)).status).toBe(200); // the second real event still fits the burst of 2
    expect((await send(app, pc)).status).toBe(429);
  });

  it('accepted requests do not use up the address limit (120 failed requests per minute), also while in progress', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake);
    for (let i = 0; i < 125; i += 1) {
      const res = await send(app, pc);
      expect(res.status).toBe(200);
    }
    // 130 at once from one address (the PC is known, so no key scan): none refused by the address limit.
    const results = await Promise.all(Array.from({ length: 130 }, () => send(app, pc)));
    expect(results.every((r) => r.status === 200)).toBe(true);
  }, 30_000);

  it('120 failed requests from one address → the next one is refused before any lookup', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const app = auditApp(fake);
    for (let i = 0; i < 120; i += 1) {
      expect((await send(app, pc, { headerId: 'not-a-uuid' })).status).toBe(401);
    }
    const blocked = await send(app, pc);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ code: 'RATE_LIMITED', error: 'Too many audit requests, please try again later' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(fake.callsTo('devices.scan')).toHaveLength(0);
  }, 30_000);
  // ── Current shell: actor claim and event time (extra.shellAudit: 2) ──────

  // ── The same event sent again (FX-6) ──────────────────────────────────────

  describe('the same current-shell event sent again under a new nonce', () => {
    const EVENT_ID = '0b7e3c55-4d1a-4e8f-9a2b-6c7d8e9f0a1b';
    const event = (eventId: unknown = EVENT_ID, extra: Record<string, unknown> = {}) => ({
      ...VALID_BODY, extra: { shellAudit: 2, eventId, ...extra },
    });

    it('both answer 200 with the same body, one audit row; the second still uses the PC\'s allowance', async () => {
      const pc = makePc();
      const fake = makeFake([row(pc)]);
      const app = auditApp(fake, { pcBurst: 2, pcRatePerSec: 0.001, pcMaxWaiting: 0 });
      const first = await send(app, pc, { body: event() });
      const second = await send(app, pc, { body: event(), token: null });
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.body).toEqual(first.body);
      expect(first.body).toEqual({ ok: true });
      expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
      expect(fake.callsTo('devices.touch')).toHaveLength(2); // last seen is updated for both
      // The allowance of 2 was used by both requests.
      expect((await send(app, pc, { body: event('0b7e3c55-4d1a-4e8f-9a2b-6c7d8e9f0a1c') })).status).toBe(429);
      fake.assertAllReleased();
    });

    it('the event id is compared without regard to letter case', async () => {
      const pc = makePc();
      const fake = makeFake([row(pc)]);
      const app = auditApp(fake);
      expect((await send(app, pc, { body: event(EVENT_ID) })).status).toBe(200);
      expect((await send(app, pc, { body: event(EVENT_ID.toUpperCase()) })).status).toBe(200);
      expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
    });

    it('the same event id from another PC is recorded for each PC', async () => {
      const pcA = makePc();
      const pcB = makePc();
      const fake = makeFake([row(pcA), row(pcB)]);
      const app = auditApp(fake);
      expect((await send(app, pcA, { body: event() })).status).toBe(200);
      expect((await send(app, pcB, { body: event() })).status).toBe(200);
      expect(writeAuditLogStrict).toHaveBeenCalledTimes(2);
    });

    it('older shells\' events and event ids that are not UUIDs are recorded each time, as before', async () => {
      const pc = makePc();
      const fake = makeFake([row(pc)]);
      const app = auditApp(fake);
      const legacy = { ...VALID_BODY, extra: { eventId: EVENT_ID } }; // no current-shell marker
      expect((await send(app, pc, { body: legacy })).status).toBe(200);
      expect((await send(app, pc, { body: legacy })).status).toBe(200);
      expect((await send(app, pc, { body: event('e-1') })).status).toBe(200);
      expect((await send(app, pc, { body: event('e-1') })).status).toBe(200);
      expect((await send(app, pc, { body: event(42) })).status).toBe(200);
      expect((await send(app, pc, { body: event(42) })).status).toBe(200);
      expect(writeAuditLogStrict).toHaveBeenCalledTimes(6);
    });

    it('when writing the first audit row fails, the marker is rolled back too and the event is recorded when resent', async () => {
      const pc = makePc();
      const fake = makeFake([row(pc)]);
      const app = auditApp(fake);
      vi.mocked(writeAuditLogStrict).mockRejectedValueOnce(new Error('DB connection lost'));
      expect((await send(app, pc, { body: event() })).status).toBe(500);
      expect((await send(app, pc, { body: event() })).status).toBe(200);
      expect(writeAuditLogStrict).toHaveBeenCalledTimes(2); // the failed attempt and the recorded one
      fake.assertAllReleased();
    });

    it('the nonce of a request answered without a second row cannot be used again', async () => {
      const pc = makePc();
      const fake = makeFake([row(pc)]);
      const app = auditApp(fake);
      expect((await send(app, pc, { body: event() })).status).toBe(200);
      const ts = new Date().toISOString();
      const devNonce = nonce();
      expect((await send(app, pc, { body: event(), ts, devNonce })).status).toBe(200);
      const replay = await send(app, pc, { body: event(), ts, devNonce });
      expect(replay.status).toBe(401);
      expect(replay.body.error).toMatch(/nonce/i);
      expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
    });

    it('a request nonce in the event-marker form is refused before any lookup', async () => {
      const pc = makePc();
      const fake = makeFake([row(pc)]);
      const res = await send(auditApp(fake), pc, { body: event(), devNonce: `event:${EVENT_ID}` });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(fake.callsTo('devices.scan')).toHaveLength(0);
      expect(writeAuditLogStrict).not.toHaveBeenCalled();
    });
  });

  describe('current shell values', () => {
    const SAME_ORG = '3f0c2b1a-1111-4222-8333-444455556666';
    const OTHER_ORG = '3f0c2b1a-1111-4222-8333-444455557777';
    const NO_ORG = '3f0c2b1a-1111-4222-8333-444455558888';
    const SESSION_USER = '3f0c2b1a-1111-4222-8333-444455559999';
    beforeEach(() => {
      USERS[SAME_ORG] = 'org-1';
      USERS[OTHER_ORG] = 'org-2';
      USERS[NO_ORG] = null;
      USERS[SESSION_USER] = 'org-1';
    });
    const current = (extra: Record<string, unknown>) => ({ ...VALID_BODY, extra: { shellAudit: 2, eventId: 'e-1', ...extra } });
    const sessionTok = () => userToken(SESSION_USER);

    async function record(extra: Record<string, unknown>, options: { token?: string | null; ts?: string } = {}) {
      const pc = makePc();
      const fake = makeFake([row(pc)]);
      const res = await send(auditApp(fake), pc, { body: current(extra), token: options.token === undefined ? sessionTok() : options.token, ts: options.ts });
      expect(res.status).toBe(200); // never refused for these values
      return { entry: lastAuditEntry(), fake };
    }

    it('claim = session user → the session user, no uncertainty flag; a valid event time is recorded', async () => {
      const ts = new Date().toISOString();
      const occurredAt = new Date(Date.now() - 60_000).toISOString();
      const { entry, fake } = await record({ actorUserId: SESSION_USER, occurredAt }, { ts });
      expect(entry).toMatchObject({ actorUserId: SESSION_USER, actorOrgId: 'org-1' });
      expect(entry.extra).toMatchObject({ actor_source: 'session', occurred_at: occurredAt, eventId: 'e-1', shellAudit: 2 });
      for (const k of ['actor_uncertain', 'actor_unverified', 'legacy_shell', 'occurred_at_unknown', 'occurred_at_invalid', 'burst']) {
        expect(entry.extra).not.toHaveProperty(k);
      }
      expect(fake.callsTo('users.org')).toHaveLength(0); // no lookup for the session's own user
    });

    it('a valid claim different from the session → the claimed user, flagged unverified, with the sender', async () => {
      const { entry } = await record({ actorUserId: SAME_ORG, occurredAt: new Date().toISOString() });
      expect(entry).toMatchObject({ actorUserId: SAME_ORG, actorOrgId: 'org-1' });
      expect(entry.extra).toMatchObject({ actor_source: 'device_claim', actor_unverified: true, sent_by_user_id: SESSION_USER });
    });

    it('a valid claim without a session → the claimed user, flagged unverified and session missing', async () => {
      const { entry } = await record({ actorUserId: SAME_ORG, occurredAt: new Date().toISOString(), queued: true }, { token: null });
      expect(entry).toMatchObject({ actorUserId: SAME_ORG, actorOrgId: 'org-1' });
      expect(entry.extra).toMatchObject({ actor_source: 'device_claim', actor_unverified: true, session_missing: true, queued: true });
      expect(entry.extra).not.toHaveProperty('sent_by_user_id');
    });

    it.each([
      ['an unknown user', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
      ['a user of another organisation', OTHER_ORG],
      ['an account without an organisation', NO_ORG],
      ['a value that is not a UUID', 'user-1'],
      ['a value that is not a string', 42],
    ])('a claim of %s is rejected: fallback actor, flagged uncertain and claim rejected', async (_name, claim) => {
      const withSession = await record({ actorUserId: claim, occurredAt: new Date().toISOString() });
      expect(withSession.entry).toMatchObject({ actorUserId: SESSION_USER, actorOrgId: 'org-1' });
      expect(withSession.entry.extra).toMatchObject({ actor_source: 'session_fallback', actor_uncertain: true, actor_claim_rejected: true });
      const noSession = await record({ actorUserId: claim }, { token: null });
      expect(noSession.entry).toMatchObject({ actorUserId: 'user-1', actorOrgId: 'org-1' }); // the PC's registrant
      expect(noSession.entry.extra).toMatchObject({ actor_source: 'device_registrant', actor_uncertain: true, actor_claim_rejected: true, session_missing: true });
    });

    it('a current-shell event without a claim: fallback actor flagged uncertain (no claim-rejected flag), time unknown', async () => {
      const { entry } = await record({});
      expect(entry).toMatchObject({ actorUserId: SESSION_USER });
      expect(entry.extra).toMatchObject({ actor_source: 'session_fallback', actor_uncertain: true, occurred_at_unknown: true });
      expect(entry.extra).not.toHaveProperty('actor_claim_rejected');
      expect(entry.extra).not.toHaveProperty('legacy_shell');
    });

    it.each([
      ['later than the signed time', () => new Date(Date.now() + 60_000).toISOString()],
      ['malformed', () => '2026-11-23 10:00'],
      ['not a string', () => 1700000000000],
      ['an impossible date', () => '2026-13-45T00:00:00.000Z'],
      ['a day that does not exist in its month (Feb 30)', () => '2026-02-30T00:00:00.000Z'],
      ['a day that does not exist in its month (Apr 31)', () => '2026-04-31T12:00:00Z'],
    ])('an event time %s is flagged invalid and the event is still recorded', async (_name, value) => {
      const { entry } = await record({ actorUserId: SESSION_USER, occurredAt: value() });
      expect(entry.extra).toMatchObject({ occurred_at_invalid: true, actor_source: 'session' });
      expect(entry.extra).not.toHaveProperty('occurred_at');
    });

    it('a key in several organisations: no actor, org_unresolved, the claim rejected', async () => {
      const pc = makePc();
      const fake = makeFake([row(pc, { organization_id: 'org-1' }), row(pc, { organization_id: 'org-2', user_id: 'user-2' })]);
      const res = await send(auditApp(fake), pc, { body: current({ actorUserId: SESSION_USER }), token: sessionTok() });
      expect(res.status).toBe(200);
      expect(lastAuditEntry()).toMatchObject({ actorUserId: null, actorOrgId: null });
      expect(lastAuditEntry().extra).toMatchObject({ org_unresolved: true, actor_uncertain: true, actor_claim_rejected: true });
    });

    it('every case without the session user confirmed carries an uncertainty or unverified flag', async () => {
      const cases: [Record<string, unknown>, string | null][] = [
        [{}, null], [{}, sessionTok()], [{ actorUserId: SAME_ORG }, null], [{ actorUserId: SAME_ORG }, sessionTok()],
        [{ actorUserId: OTHER_ORG }, sessionTok()], [{ actorUserId: 'nope' }, null],
      ];
      for (const [extra, tok] of cases) {
        const { entry } = await record(extra, { token: tok });
        expect(entry.extra.actor_uncertain === true || entry.extra.actor_unverified === true).toBe(true);
      }
    });
  });
});

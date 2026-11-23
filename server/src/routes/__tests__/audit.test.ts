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

// emr_audit_nonces as the handler uses it (SEC-A L11): a claimed nonce is kept on COMMIT and dropped on
// ROLLBACK; the pre-check and the next claim see only kept ones. One store per fake (per test).
function nonceHandlers(): QueryHandler[] {
  const committed = new Set<string>();
  let pending: string | null = null;
  return [
    {
      name: 'nonce.seen', via: 'pool', match: /SELECT 1 FROM emr_audit_nonces/,
      reply: (_sql, params) => ((params[0] as string[]).some((id) => committed.has(`${id}:${String(params[1])}`)) ? { rows: [{ '?column?': 1 }] } : { rows: [] }),
    },
    {
      name: 'nonce.claim', via: 'client', match: /INSERT INTO emr_audit_nonces/,
      reply: (_sql, params) => {
        const key = `${String(params[0])}:${String(params[1])}`;
        if (committed.has(key)) return { rows: [], rowCount: 0 };
        pending = key;
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      },
    },
    { name: 'tx.commit', via: 'client', match: /^\s*COMMIT\b/, reply: () => { if (pending) committed.add(pending); pending = null; return { rows: [] }; } },
    { name: 'tx.rollback', via: 'client', match: /^\s*ROLLBACK\b/, reply: () => { pending = null; return { rows: [] }; } },
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

function makeFake(rows: DeviceRow[], options: { session?: boolean } = {}): FakePool {
  return createFakePool({ handlers: [...(options.session === false ? [] : [authSessionHandler()]), ...deviceHandlers(rows)] });
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

  it('the current shell\'s marker turns off the older-shell flags', async () => {
    const pc = makePc();
    const fake = makeFake([row(pc)]);
    const body = { ...VALID_BODY, extra: { shellAudit: 2 } };
    expect((await send(auditApp(fake), pc, { body })).status).toBe(200);
    expect(lastAuditEntry().extra).not.toHaveProperty('legacy_shell');
    expect(lastAuditEntry().extra).not.toHaveProperty('occurred_at_unknown');
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
});

// POST /api/audit/emr against a device created through the registration API (real PostgreSQL).
// The desktop shell signs with its own device id (X-WR-Device-Id), which is not the id the server
// gives the registration row; the server identifies the device by the signing key.
// Runs in the integration project (npm run check:full).
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { createApp } from '../../app';
import {
  TEST_DATABASE_URL, createIntegrationOrg, integrationAuditPool, integrationPool,
  type IntegrationOrg, type IntegrationUser,
} from '../../testing/integrationDb';

const ELECTRON_UA = 'Mozilla/5.0 wr-evaluation-unified Electron/22.3.27';

function rawPublicKey(pub: crypto.KeyObject): string {
  return (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');
}

function sign(priv: crypto.KeyObject, headerId: string, ts: string, nonce: string, body: object): string {
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.sign(null, Buffer.from(`${headerId}.${ts}.${nonce}.${JSON.stringify(sorted)}`), priv).toString('base64');
}

describe.skipIf(!TEST_DATABASE_URL)('EMR audit from a device registered through the API (real PostgreSQL)', () => {
  let pool: Pool;
  let auditReader: Pool;
  let org: IntegrationOrg;
  let doctor: IntegrationUser;
  let admin: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool('itest-audit-device');
    auditReader = integrationAuditPool('itest-audit-device-reader');
    org = await createIntegrationOrg(pool, 'audit_device');
    doctor = await org.makeUser('doctor', 'EMR 의사');
    admin = await org.makeUser('admin', 'EMR 관리자');
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM devices WHERE organization_id = $1`, [org.orgId]); // cascades emr_audit_nonces
    await org.destroy();
    await pool.end();
    await auditReader.end();
  });

  // A new app per call: the registration route allows one request per minute per address.
  const app = (): Express => createApp({ pool, auditPool: auditReader });

  async function registerAndApprove(user: IntegrationUser, publicKey: string): Promise<string> {
    const reg = await request(app())
      .post('/api/devices/register')
      .set(org.headers(user)).set('User-Agent', ELECTRON_UA)
      .send({ publicKey, buildTarget: 'intranet' });
    expect([200, 201]).toContain(reg.status);
    const serverId = reg.body.deviceId as string;
    const approved = await request(app())
      .post(`/api/admin/devices/${serverId}/approve`)
      .set(org.headers(admin)).set('User-Agent', ELECTRON_UA)
      .send({});
    expect(approved.status).toBe(200);
    return serverId;
  }

  it('accepts an audit event signed with the shell\'s own device id, not the registration response id', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const serverId = await registerAndApprove(doctor, rawPublicKey(keys.publicKey));
    const shellId = crypto.randomUUID();
    expect(shellId).not.toBe(serverId);

    const probe = crypto.randomUUID();
    const body = { action: 'emr_extract_record', outcome: 'success' as const, extra: { probe } };
    const ts = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const res = await request(app())
      .post('/api/audit/emr')
      .set(org.headers(doctor)).set('User-Agent', ELECTRON_UA)
      .set('x-wr-source', 'electron-main')
      .set('x-wr-device-id', shellId)
      .set('x-wr-device-sig', sign(keys.privateKey, shellId, ts, nonce, body))
      .set('x-wr-device-ts', ts)
      .set('x-wr-device-nonce', nonce)
      .send(body);
    expect(res.status).toBe(200);

    const rows = (await auditReader.query<{ actor_user_id: string; actor_org_id: string; target_type: string; extra: Record<string, unknown> }>(
      `SELECT actor_user_id, actor_org_id, target_type, extra FROM audit_logs
        WHERE action = 'emr_extract_record' AND extra->>'probe' = $1`, [probe],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: doctor.id, actor_org_id: org.orgId, target_type: 'emr' });
    expect(rows[0].extra).toMatchObject({ deviceId: serverId, header_device_id: shellId, source: 'electron-main' });
  });

  // A signed event for `keys`, with `user`'s session or (user = null) without one.
  function sendEvent(keys: crypto.KeyPairKeyObjectResult, shellId: string, user: IntegrationUser | null, extra: Record<string, unknown>,
    options: { orgHeaders?: IntegrationOrg; ts?: string; nonce?: string } = {}) {
    const body = { action: 'emr_inject', outcome: 'failure' as const, extra };
    const ts = options.ts ?? new Date().toISOString();
    const nonce = options.nonce ?? crypto.randomUUID();
    let req = request(app()).post('/api/audit/emr').set('User-Agent', ELECTRON_UA);
    if (user) req = req.set((options.orgHeaders ?? org).headers(user));
    return req
      .set('x-wr-source', 'electron-main')
      .set('x-wr-device-id', shellId)
      .set('x-wr-device-sig', sign(keys.privateKey, shellId, ts, nonce, body))
      .set('x-wr-device-ts', ts)
      .set('x-wr-device-nonce', nonce)
      .send(body);
  }

  const rowsByProbe = async (probe: string) => (await auditReader.query<{ actor_user_id: string | null; actor_org_id: string | null; action: string; extra: Record<string, unknown> }>(
    `SELECT actor_user_id, actor_org_id, action, extra FROM audit_logs WHERE extra->>'probe' = $1`, [probe],
  )).rows;

  async function insertRow(keys: crypto.KeyPairKeyObjectResult, userId: string, orgId: string | null, status: string): Promise<string> {
    const publicKey = rawPublicKey(keys.publicKey);
    const fp = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
    return (await pool.query<{ id: string }>(
      `INSERT INTO devices (user_id, organization_id, public_key, public_key_fingerprint, build_target, status)
       VALUES ($1, $2, $3, $4, 'intranet', $5) RETURNING id`,
      [userId, orgId, publicKey, fp, status],
    )).rows[0].id;
  }

  it('one PC, two users of the organisation: each is the actor of their own events; without a session the first registrant', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const firstId = await registerAndApprove(doctor, rawPublicKey(keys.publicKey));
    const nurse = await org.makeUser('nurse', 'EMR 간호사');
    await insertRow(keys, nurse.id, org.orgId, 'active'); // an existing second registration of the same key
    const shellId = crypto.randomUUID();

    const p1 = crypto.randomUUID();
    expect((await sendEvent(keys, shellId, nurse, { probe: p1 })).status).toBe(200);
    expect(await rowsByProbe(p1)).toEqual([expect.objectContaining({ actor_user_id: nurse.id, actor_org_id: org.orgId })]);

    const p2 = crypto.randomUUID();
    expect((await sendEvent(keys, shellId, null, { probe: p2 })).status).toBe(200);
    const [queued] = await rowsByProbe(p2);
    expect(queued).toMatchObject({ actor_user_id: doctor.id, actor_org_id: org.orgId });
    expect(queued.extra).toMatchObject({
      deviceId: firstId, session_missing: true, actor_uncertain: true, actor_source: 'device_registrant', legacy_shell: true,
    });
  });

  it('a session of another organisation is refused; a key registered in two organisations is recorded without actor or organisation', async () => {
    const other = await createIntegrationOrg(pool, 'audit_device_other');
    try {
      const outsider = await other.makeUser('doctor', '다른 기관 의사');
      const keys = crypto.generateKeyPairSync('ed25519');
      await registerAndApprove(doctor, rawPublicKey(keys.publicKey));
      const shellId = crypto.randomUUID();

      const p1 = crypto.randomUUID();
      const refused = await sendEvent(keys, shellId, outsider, { probe: p1 }, { orgHeaders: other });
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('UNAUTHORIZED');
      expect(await rowsByProbe(p1)).toHaveLength(0);

      await insertRow(keys, outsider.id, other.orgId, 'active'); // the same key in a second organisation
      const p2 = crypto.randomUUID();
      expect((await sendEvent(keys, shellId, outsider, { probe: p2 }, { orgHeaders: other })).status).toBe(200);
      const [unresolved] = await rowsByProbe(p2);
      expect(unresolved).toMatchObject({ actor_user_id: null, actor_org_id: null });
      expect(unresolved.extra).toMatchObject({ org_unresolved: true, actor_uncertain: true, sent_by_user_id: outsider.id });
    } finally {
      await pool.query(`DELETE FROM devices WHERE organization_id = $1`, [other.orgId]);
      await other.destroy();
    }
  });

  it('a reused nonce is refused also when resent without the token; a revoked row closes the PC; a malformed id is a 401', async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    await registerAndApprove(doctor, rawPublicKey(keys.publicKey));
    const shellId = crypto.randomUUID();
    const ts = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const probe = crypto.randomUUID();
    expect((await sendEvent(keys, shellId, doctor, { probe }, { ts, nonce })).status).toBe(200);
    const replay = await sendEvent(keys, shellId, null, { probe }, { ts, nonce });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/nonce/i);
    expect(await rowsByProbe(probe)).toHaveLength(1);

    // A nonce recorded under another row of the PC (earlier versions keyed nonces by the header id) is still a replay.
    const second = await insertRow(keys, (await org.makeUser('doctor', 'EMR 의사 2')).id, org.orgId, 'active');
    const oldNonce = crypto.randomUUID();
    await pool.query(`INSERT INTO emr_audit_nonces (device_id, nonce) VALUES ($1, $2)`, [second, oldNonce]);
    const oldReplay = await sendEvent(keys, second, doctor, { probe: crypto.randomUUID() }, { nonce: oldNonce });
    expect(oldReplay.status).toBe(401);
    expect(oldReplay.body.error).toMatch(/nonce/i);

    const malformed = await sendEvent(keys, 'not-a-uuid', doctor, { probe: crypto.randomUUID() });
    expect(malformed.status).toBe(401);
    expect(malformed.body).toEqual({ code: 'UNAUTHORIZED', error: 'Device not recognized' });

    const nurse = await org.makeUser('nurse', 'EMR 간호사 2');
    await insertRow(keys, nurse.id, org.orgId, 'revoked');
    const closed = await sendEvent(keys, shellId, doctor, { probe: crypto.randomUUID() });
    expect(closed.status).toBe(401);
    expect(closed.body).toEqual({ code: 'UNAUTHORIZED', error: 'Device not recognized' });
  });
});

// Device registration, approval and revocation per PC (signing key) on a real PostgreSQL: one PC belongs to one
// organisation, a second user's registration returns the PC's row, revocation covers every row of the PC and an
// approval cannot undo it. Runs in the integration project (npm run check:full).
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

function newKey() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');
  const fingerprint = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  return { ...keys, publicKey, fingerprint };
}

function sign(priv: crypto.KeyObject, headerId: string, ts: string, nonce: string, body: object): string {
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.sign(null, Buffer.from(`${headerId}.${ts}.${nonce}.${JSON.stringify(sorted)}`), priv).toString('base64');
}

describe.skipIf(!TEST_DATABASE_URL)('devices per PC (real PostgreSQL)', () => {
  let pool: Pool;
  let auditReader: Pool;
  let org: IntegrationOrg;
  let other: IntegrationOrg;
  let doctor: IntegrationUser;
  let nurse: IntegrationUser;
  let admin: IntegrationUser;
  let outsider: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool('itest-devices-pc');
    auditReader = integrationAuditPool('itest-devices-pc-reader');
    org = await createIntegrationOrg(pool, 'devices_pc');
    other = await createIntegrationOrg(pool, 'devices_pc_other');
    doctor = await org.makeUser('doctor', '장치 의사');
    nurse = await org.makeUser('nurse', '장치 간호사');
    admin = await org.makeUser('admin', '장치 관리자');
    outsider = await other.makeUser('doctor', '다른 기관 의사');
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM devices WHERE organization_id = ANY($1::uuid[])`, [[org.orgId, other.orgId]]);
    await org.destroy();
    await other.destroy();
    await pool.end();
    await auditReader.end();
  });

  // A new app per call: the registration route allows one request per minute per address.
  const app = (): Express => createApp({ pool, auditPool: auditReader });
  const register = (o: IntegrationOrg, user: IntegrationUser, publicKey: string) => request(app())
    .post('/api/devices/register').set(o.headers(user)).set('User-Agent', ELECTRON_UA)
    .send({ publicKey, buildTarget: 'intranet' });
  const approve = (id: string) => request(app()).post(`/api/admin/devices/${id}/approve`).set(org.headers(admin)).set('User-Agent', ELECTRON_UA).send({});
  const revoke = (id: string) => request(app()).post(`/api/admin/devices/${id}/revoke`).set(org.headers(admin)).set('User-Agent', ELECTRON_UA).send({});
  const rowsOf = async (fp: string) => (await pool.query<{ id: string; status: string; organization_id: string }>(
    `SELECT id, status, organization_id FROM devices WHERE public_key_fingerprint = $1 ORDER BY registered_at, id`, [fp],
  )).rows;

  it('a second user of the organisation gets the PC\'s row and status — no new row', async () => {
    const key = newKey();
    const first = await register(org, doctor, key.publicKey);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'pending', deviceScope: 'pc', organizationId: org.orgId });
    expect((await approve(first.body.deviceId)).status).toBe(200);
    const second = await register(org, nurse, key.publicKey);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ deviceId: first.body.deviceId, status: 'active', deviceScope: 'pc', organizationId: org.orgId });
    expect(await rowsOf(key.fingerprint)).toHaveLength(1);
  });

  it('a user of another organisation is refused and no row is made', async () => {
    const key = newKey();
    expect((await register(org, doctor, key.publicKey)).status).toBe(201);
    const refused = await register(other, outsider, key.publicKey);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'DEVICE_REGISTERED_TO_OTHER_ORG', status: 'other_org', deviceScope: 'pc', organizationId: other.orgId });
    expect(JSON.stringify(refused.body)).not.toContain(org.orgId);
    const rows = await rowsOf(key.fingerprint);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(org.orgId);
  });

  it('revoking revokes every row of the PC; registering or approving again does not undo it; its events are refused with one summary row', async () => {
    const key = newKey();
    const reg = await register(org, doctor, key.publicKey);
    expect((await approve(reg.body.deviceId)).status).toBe(200);
    // An existing second row of the same key (from before rows were shared per PC), still pending.
    const secondId = (await pool.query<{ id: string }>(
      `INSERT INTO devices (user_id, organization_id, public_key, public_key_fingerprint, build_target, status)
       VALUES ($1, $2, $3, $4, 'intranet', 'pending') RETURNING id`,
      [nurse.id, org.orgId, key.publicKey, key.fingerprint],
    )).rows[0].id;

    const revoked = await revoke(reg.body.deviceId);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedDeviceIds.sort()).toEqual([reg.body.deviceId, secondId].sort());
    expect((await rowsOf(key.fingerprint)).map((r) => r.status)).toEqual(['revoked', 'revoked']);
    expect((await revoke(secondId)).status).toBe(409);

    const again = await register(org, nurse, key.publicKey);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ deviceId: reg.body.deviceId, status: 'revoked' });
    expect(await rowsOf(key.fingerprint)).toHaveLength(2);

    await pool.query(`UPDATE devices SET status = 'pending', revoked_at = NULL WHERE id = $1`, [secondId]);
    const approval = await approve(secondId);
    expect(approval.status).toBe(409);
    expect(approval.body.code).toBe('DEVICE_PC_REVOKED');

    const probe = crypto.randomUUID();
    const body = { action: 'emr_inject', outcome: 'success' as const, extra: { probe } };
    const shellId = crypto.randomUUID();
    const server = app(); // one process: the summary is one row per PC per window
    for (let i = 0; i < 2; i += 1) {
      const ts = new Date().toISOString();
      const nonce = crypto.randomUUID();
      const res = await request(server).post('/api/audit/emr').set('User-Agent', ELECTRON_UA)
        .set('x-wr-source', 'electron-main').set('x-wr-device-id', shellId)
        .set('x-wr-device-sig', sign(key.privateKey, shellId, ts, nonce, body))
        .set('x-wr-device-ts', ts).set('x-wr-device-nonce', nonce)
        .send(body);
      expect(res.status).toBe(401);
    }
    const denied = (await auditReader.query<{ actor_org_id: string; extra: Record<string, unknown> }>(
      `SELECT actor_org_id, extra FROM audit_logs WHERE action = 'emr_audit_denied' AND extra->>'header_device_id' = $1`, [shellId],
    )).rows;
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actor_org_id: org.orgId, extra: { pcStatus: 'revoked', emrAction: 'emr_inject' } });
  });

  it('two registrations of the same new key at the same time make one row', async () => {
    const key = newKey();
    const [a, b] = await Promise.all([register(org, doctor, key.publicKey), register(org, nurse, key.publicKey)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.deviceId).toBe(b.body.deviceId);
    expect(await rowsOf(key.fingerprint)).toHaveLength(1);
  });
});

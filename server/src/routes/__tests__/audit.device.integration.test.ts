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
});

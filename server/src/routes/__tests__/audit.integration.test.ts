// POST /api/audit/emr nonce on a real PostgreSQL (SEC-A L11, migration 0038). The nonce is claimed in
// the same transaction as the audit row, so it survives a restart and concurrent duplicates are
// serialised by the primary key. Runs in the integration project (npm run check:full).
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const BODY = { action: 'emr_inject', outcome: 'success' as const, targetId: 'golden-emr-target' };

function rawPublicKey(pub: crypto.KeyObject): string {
  return (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');
}

function sign(priv: crypto.KeyObject, deviceId: string, ts: string, nonce: string, body: object): string {
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.sign(null, Buffer.from(`${deviceId}.${ts}.${nonce}.${JSON.stringify(sorted)}`), priv).toString('base64');
}

describe.skipIf(!TEST_DB_URL)('EMR audit nonce (real PostgreSQL, SEC-A L11)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;
  let deviceId: string;
  let privateKey: crypto.KeyObject;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('__emr_nonce_org__') RETURNING id`)).rows[0].id;
    userId = (await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,'x','EMR 시험','doctor',$2) RETURNING id`,
      [`__emr_nonce_${crypto.randomUUID()}__`, orgId],
    )).rows[0].id;
    const keys = crypto.generateKeyPairSync('ed25519');
    privateKey = keys.privateKey;
    deviceId = (await pool.query<{ id: string }>(
      `INSERT INTO devices (user_id, organization_id, public_key, public_key_fingerprint, build_target, status)
       VALUES ($1, $2, $3, $4, 'intranet', 'active') RETURNING id`,
      [userId, orgId, rawPublicKey(keys.publicKey), crypto.randomUUID()],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM devices WHERE id = $1`, [deviceId]); // cascades emr_audit_nonces
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  const app = (): Express => createApp({ pool, auditPool: pool });

  // Queue replay form (no Authorization): the actor is the device's user and organization.
  function signedRequest(target: Express, nonce: string) {
    const ts = new Date().toISOString();
    return request(target)
      .post('/api/audit/emr')
      .set('x-wr-source', 'electron-main')
      .set('x-wr-device-id', deviceId)
      .set('x-wr-device-sig', sign(privateKey, deviceId, ts, nonce, BODY))
      .set('x-wr-device-ts', ts)
      .set('x-wr-device-nonce', nonce)
      .send(BODY);
  }

  const auditRows = async (nonce: string) => (await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs
     WHERE actor_org_id = $1 AND action = 'emr_inject' AND extra->>'deviceId' = $2 AND extra->>'nonceProbe' = $3`,
    [orgId, deviceId, nonce],
  )).rows[0].n;

  it('two concurrent requests with the same signed nonce: one 200, one 401, one audit row', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const probe = { ...BODY, extra: { nonceProbe: nonce } };
    const ts = new Date().toISOString();
    const sig = sign(privateKey, deviceId, ts, nonce, probe);
    const send = (target: Express) => request(target)
      .post('/api/audit/emr')
      .set('x-wr-source', 'electron-main').set('x-wr-device-id', deviceId)
      .set('x-wr-device-sig', sig).set('x-wr-device-ts', ts).set('x-wr-device-nonce', nonce)
      .send(probe);

    // Two app instances = two processes sharing the database.
    const [a, b] = await Promise.all([send(app()), send(app())]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const rejected = a.status === 401 ? a : b;
    expect(rejected.body).toEqual({ code: 'UNAUTHORIZED', error: 'Duplicate request (nonce reuse)' });
    expect(await auditRows(nonce)).toBe('1');
    const stored = await pool.query(`SELECT 1 FROM emr_audit_nonces WHERE device_id = $1 AND nonce = $2`, [deviceId, nonce]);
    expect(stored.rowCount).toBe(1);
  });

  it('a nonce recorded before a restart is still rejected (the in-memory store would have forgotten it)', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    await pool.query(`INSERT INTO emr_audit_nonces (device_id, nonce) VALUES ($1, $2)`, [deviceId, nonce]);
    const res = await signedRequest(app(), nonce);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'UNAUTHORIZED', error: 'Duplicate request (nonce reuse)' });
  });

  it('a fresh nonce is accepted once and stored; the server fields win over a client extra', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const forged = { ...BODY, extra: { nonceProbe: nonce, deviceId: 'forged', source: 'forged' } };
    const ts = new Date().toISOString();
    const res = await request(app())
      .post('/api/audit/emr')
      .set('x-wr-source', 'electron-main').set('x-wr-device-id', deviceId)
      .set('x-wr-device-sig', sign(privateKey, deviceId, ts, nonce, forged)).set('x-wr-device-ts', ts).set('x-wr-device-nonce', nonce)
      .send(forged);
    expect(res.status).toBe(200);
    const row = await pool.query<{ extra: Record<string, unknown> }>(
      `SELECT extra FROM audit_logs WHERE actor_org_id = $1 AND extra->>'nonceProbe' = $2`, [orgId, nonce],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].extra).toMatchObject({ deviceId, source: 'electron-main', session_missing: true });
  });

  it('the sweep removes nonces older than 24 hours and keeps recent ones', async () => {
    const { sweepEmrAuditNonces } = await import('../../jobs/emrAuditNonces.js');
    const old = crypto.randomBytes(8).toString('hex');
    const recent = crypto.randomBytes(8).toString('hex');
    await pool.query(`INSERT INTO emr_audit_nonces (device_id, nonce, seen_at) VALUES ($1, $2, now() - interval '25 hours'), ($1, $3, now())`, [deviceId, old, recent]);
    await sweepEmrAuditNonces(pool);
    const left = await pool.query<{ nonce: string }>(`SELECT nonce FROM emr_audit_nonces WHERE device_id = $1 AND nonce = ANY($2)`, [deviceId, [old, recent]]);
    expect(left.rows.map((r) => r.nonce)).toEqual([recent]);
  });
});

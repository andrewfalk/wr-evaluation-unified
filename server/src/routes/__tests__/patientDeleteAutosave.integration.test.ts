// Deleting a patient also removes it from autosave snapshots (SEC-B L12), in the same transaction as
// the soft-delete and the workspace redaction. Real PostgreSQL: the jsonb filtering is the point.
// Runs in the integration project (npm run check:full).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { integrationAuditPool } from '../../testing/integrationDb';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app';
import { generateAccessToken } from '../../auth/tokens';
import { hashToken, generateToken } from '../../auth/tokenHash';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'autosave-cleanup-csrf';
const GOLDEN_PATIENTS = path.resolve(__dirname, '../../../../src/core/fixtures/goldenPatients.json');

describe.skipIf(!TEST_DB_URL)('patient delete → autosave cleanup (real PostgreSQL, SEC-B L12)', () => {
  let pool: Pool;
  let auditReader: Pool; // wr_audit_reader — the app's audit pool, and how tests read audit rows (M9)
  let app: Express;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    auditReader = integrationAuditPool();
    app = createApp({ pool, auditPool: auditReader });
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('__autosave_cleanup_org__') RETURNING id`)).rows[0].id;
    otherOrgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('__autosave_cleanup_other__') RETURNING id`)).rows[0].id;
    userId = (await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,'x','정리 의사','doctor',$2) RETURNING id`,
      [`__autosave_cleanup_${crypto.randomUUID()}__`, orgId],
    )).rows[0].id;
    const sessionId = crypto.randomUUID();
    const csrfHash = hashToken(CSRF_TOKEN);
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, family_id)
       VALUES ($1,$2,$3,$4, now() + interval '1 hour', $5)`,
      [sessionId, userId, hashToken(generateToken()), csrfHash, crypto.randomUUID()],
    );
    token = generateAccessToken({ sub: userId, sessionId, orgId, role: 'doctor', name: '정리 의사', mustChangePassword: false, csrfHash }).token;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM autosaves WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM patient_locks WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgId, otherOrgId]]);
    await pool.end();
    await auditReader.end();
  });

  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`).set('X-CSRF-Token', CSRF_TOKEN);

  const putAutosave = (deviceId: string, org: string | null, payload: unknown[], savedAt = '2026-01-01T00:00:00Z') =>
    pool.query(
      `INSERT INTO autosaves (user_id, device_id, organization_id, saved_at, payload) VALUES ($1, $2, $3, $4, $5)`,
      [userId, deviceId, org, savedAt, JSON.stringify(payload)],
    );
  const autosave = async (deviceId: string) => (await pool.query<{ payload: unknown[]; saved_at: Date }>(
    `SELECT payload, saved_at FROM autosaves WHERE user_id = $1 AND device_id = $2`, [userId, deviceId],
  )).rows[0];

  it('removes the deleted patient (by local id or sync.serverId) and keeps everything else in order', async () => {
    const golden = (JSON.parse(fs.readFileSync(GOLDEN_PATIENTS, 'utf8')) as Array<{ id: string; phase?: string; data: { shared: { doctorName?: string } } }>)[0];
    // The server assigns the doctor by matching data.shared.doctorName to a user's name; make this
    // test's doctor the assigned one so the delete is allowed.
    golden.data.shared.doctorName = '정리 의사';
    const created = await auth(request(app).post('/api/patients'))
      .set('Idempotency-Key', `autosave-cleanup-${crypto.randomUUID()}`)
      .send({ id: crypto.randomUUID(), phase: golden.phase ?? 'intake', data: golden.data });
    expect(created.status).toBe(201);
    const pid: string = created.body.id;
    const revision: number = created.body.sync.revision;

    const keepA = { id: 'keep-a', data: { shared: { name: '남는 환자 A' } } };
    const keepB = { id: 'keep-b', sync: { serverId: crypto.randomUUID() } };
    const noId = { data: { shared: { name: '아이디 없는 항목' } } };
    await putAutosave('dev-mixed', orgId, [
      keepA,
      { id: 'local-copy', sync: { serverId: pid }, data: { shared: { name: '지울 환자(동기화 사본)' } } },
      noId,
      { id: pid, data: { shared: { name: '지울 환자(서버 id)' } } },
      keepB,
    ]);
    await putAutosave('dev-only-this', orgId, [{ id: pid }]);
    await putAutosave('dev-unrelated', orgId, [keepA]);
    await putAutosave('dev-org-removed', null, [{ id: pid }, keepA]);
    await putAutosave('dev-other-org', otherOrgId, [{ id: pid }]);

    const del = await auth(request(app).delete(`/api/patients/${pid}?revision=${revision}`)).send({});
    expect(del.status).toBe(204);

    expect((await autosave('dev-mixed')).payload).toEqual([keepA, noId, keepB]);
    expect((await autosave('dev-only-this')).payload).toEqual([]);
    expect((await autosave('dev-org-removed')).payload).toEqual([keepA]);
    // Untouched: no entry for this patient, or another organization's row.
    const unrelated = await autosave('dev-unrelated');
    expect(unrelated.payload).toEqual([keepA]);
    expect(unrelated.saved_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((await autosave('dev-other-org')).payload).toEqual([{ id: pid }]);
    // saved_at is not bumped by the cleanup.
    expect((await autosave('dev-mixed')).saved_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

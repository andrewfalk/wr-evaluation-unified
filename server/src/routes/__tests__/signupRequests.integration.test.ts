// Signup requests on a real PostgreSQL (SEC-B L4, migration 0041). The public endpoint always answers
// 202 ACCEPTED; a duplicate pending request is a no-op through ON CONFLICT on the partial unique index
// (checked here against the real index — a fake pool cannot), and approval/rejection record the
// reviewing admin's organization, which then scopes the admin list. Runs in the integration project.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { integrationAdminPool, integrationAuditPool } from '../../testing/integrationDb';
import request from 'supertest';
import { createApp } from '../../app';
import { loginIdHash } from '../../auth/loginBackoff';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const ACCEPTED = { code: 'ACCEPTED', message: 'Signup request received; an administrator will review it' };

interface Admin { loginId: string; accessToken: string; csrf: string; refresh: string }

function cookieValue(res: request.Response, name: string): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find(c => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`cookie ${name} not set`);
  return decodeURIComponent(hit.slice(name.length + 1).split(';')[0]);
}

describe.skipIf(!TEST_DB_URL)('signup requests (real PostgreSQL, SEC-B L4)', () => {
  let pool: Pool;
  let auditReader: Pool; // wr_audit_reader — the app's audit pool, and how tests read audit rows (M9)
  const tag = crypto.randomBytes(4).toString('hex');
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const loginIds: string[] = [];
  let adminA: Admin;
  let adminB: Admin;
  let superAdmin: Admin;

  // A fresh app per call: the per-IP limiters (login 5/min, signup) live in each app's memory.
  const app = () => createApp({ pool, auditPool: auditReader });

  async function makeAdmin(orgId: string | null, label: string): Promise<Admin> {
    const loginId = `sr_${tag}_${label}`;
    loginIds.push(loginId);
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
      [loginId, await bcrypt.hash('admin-password-1!', 4), label, orgId],
    )).rows[0].id;
    userIds.push(id);
    const res = await request(app()).post('/api/auth/login').send({ loginId, password: 'admin-password-1!' });
    expect(res.status).toBe(200);
    return { loginId, accessToken: res.body.accessToken, csrf: cookieValue(res, 'wr_csrf'), refresh: cookieValue(res, 'wr_refresh') };
  }

  const signup = (loginId: string, name = '신청자') =>
    request(app()).post('/api/auth/signup-requests').send({ loginId, name, requestedRole: 'doctor' });

  const asAdmin = (a: Admin, r: request.Test) =>
    r.set('Authorization', `Bearer ${a.accessToken}`).set('Cookie', `wr_csrf=${a.csrf}`).set('x-csrf-token', a.csrf);

  const requestRows = (loginId: string) => pool.query<{ id: string; status: string; organization_id: string | null; name: string }>(
    `SELECT id, status, organization_id, name FROM user_signup_requests WHERE login_id = $1 ORDER BY created_at`,
    [loginId],
  ).then(r => r.rows);

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    auditReader = integrationAuditPool();
    for (const name of [`__sr_a_${tag}__`, `__sr_b_${tag}__`]) {
      orgIds.push((await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name])).rows[0].id);
    }
    adminA = await makeAdmin(orgIds[0], 'admin_a');
    adminB = await makeAdmin(orgIds[1], 'admin_b');
    superAdmin = await makeAdmin(null, 'super');
  });

  afterAll(async () => {
    if (!pool) return;
    const all = await pool.query<{ login_id: string }>(`SELECT login_id FROM user_signup_requests WHERE login_id LIKE $1`, [`sr_${tag}_%`]);
    const created = await pool.query<{ id: string }>(`SELECT id FROM users WHERE login_id = ANY($1)`, [all.rows.map(r => r.login_id)]);
    await pool.query(`DELETE FROM user_signup_requests WHERE login_id LIKE $1`, [`sr_${tag}_%`]);
    await pool.query(`DELETE FROM login_backoff WHERE login_hash = ANY($1)`, [loginIds.map(loginIdHash)]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[...userIds, ...created.rows.map(r => r.id)]]);
    await pool.query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgIds]);
    await pool.end();
    await auditReader.end();
  });

  it('a repeated request for the same login ID is 202 both times and keeps the first pending row', async () => {
    const id = `sr_${tag}_dup`;
    const first = await signup(id, '처음');
    const second = await signup(id, '두번째');
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(first.body).toEqual(ACCEPTED);
    expect(second.body).toEqual(ACCEPTED);
    const rows = await requestRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', name: '처음', organization_id: null });
  });

  it('five concurrent identical requests leave exactly one pending row (all 202)', async () => {
    const id = `sr_${tag}_race`;
    const results = await Promise.all(Array.from({ length: 5 }, () => signup(id)));
    expect(results.map(r => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(await requestRows(id)).toHaveLength(1);
  });

  it('a login ID that is already an account gets the same 202 and no request row', async () => {
    const res = await signup(adminA.loginId);
    expect(res.status).toBe(202);
    expect(res.body).toEqual(ACCEPTED);
    expect(await requestRows(adminA.loginId)).toHaveLength(0);
  });

  it('approval records the approver organization; the row is then listed for that organization only', async () => {
    const id = `sr_${tag}_approve`;
    await signup(id);
    const [pending] = await requestRows(id);

    // Every organization admin sees an unassigned pending request.
    for (const a of [adminA, adminB, superAdmin]) {
      const list = await asAdmin(a, request(app()).get('/api/admin/signup-requests'));
      expect(list.status).toBe(200);
      expect(list.body.requests.map((r: { id: string }) => r.id)).toContain(pending.id);
    }

    const approved = await asAdmin(adminA, request(app()).post(`/api/admin/signup-requests/${pending.id}/approve`));
    expect(approved.status).toBe(200);
    expect((await requestRows(id))[0]).toMatchObject({ status: 'approved', organization_id: orgIds[0] });
    const account = await pool.query<{ organization_id: string }>(`SELECT organization_id FROM users WHERE login_id = $1`, [id]);
    expect(account.rows[0].organization_id).toBe(orgIds[0]);

    const listIds = async (a: Admin) => (await asAdmin(a, request(app()).get('/api/admin/signup-requests?status=approved')))
      .body.requests.map((r: { id: string }) => r.id);
    expect(await listIds(adminA)).toContain(pending.id);
    expect(await listIds(adminB)).not.toContain(pending.id);
    expect(await listIds(superAdmin)).toContain(pending.id);
  });

  it('migration 0041 backfills requests reviewed before it from the reviewer organization', async () => {
    const adminAId = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE login_id = $1`, [adminA.loginId])).rows[0].id;
    const superId = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE login_id = $1`, [superAdmin.loginId])).rows[0].id;
    // Rows as they were before 0041: reviewed, organization_id NULL.
    const legacy = (await pool.query<{ id: string }>(
      `INSERT INTO user_signup_requests (login_id, name, requested_role, status, reviewed_by, reviewed_at)
       VALUES ($1, '옛 승인', 'doctor', 'approved', $2, now()) RETURNING id`,
      [`sr_${tag}_legacy`, adminAId],
    )).rows[0].id;
    const legacySuper = (await pool.query<{ id: string }>(
      `INSERT INTO user_signup_requests (login_id, name, requested_role, status, reviewed_by, reviewed_at)
       VALUES ($1, '옛 슈퍼 거절', 'doctor', 'rejected', $2, now()) RETURNING id`,
      [`sr_${tag}_legacy_super`, superId],
    )).rows[0].id;

    // Re-run the migration file (idempotent) — the same SQL the runner applied. Its DDL needs more than wr_app
    // (M9): the superuser pool runs it.
    const migrator = integrationAdminPool('itest-signup-0041');
    try {
      await migrator.query(fs.readFileSync(path.resolve(__dirname, '../../../migrations/0041_signup_request_organization.sql'), 'utf8'));
    } finally {
      await migrator.end();
    }

    expect((await requestRows(`sr_${tag}_legacy`))[0].organization_id).toBe(orgIds[0]);
    expect((await requestRows(`sr_${tag}_legacy_super`))[0].organization_id).toBeNull();
    const listIds = async (a: Admin) => (await asAdmin(a, request(app()).get('/api/admin/signup-requests?status=approved')))
      .body.requests.map((r: { id: string }) => r.id);
    expect(await listIds(adminA)).toContain(legacy);
    expect(await listIds(adminB)).not.toContain(legacy);
    expect(legacySuper).toBeTruthy();
  });

  it("an organization admin cannot reject another organization's reviewed request (404)", async () => {
    const id = `sr_${tag}_reject`;
    await signup(id);
    const [pending] = await requestRows(id);
    const rejected = await asAdmin(adminB, request(app()).post(`/api/admin/signup-requests/${pending.id}/reject`));
    expect(rejected.status).toBe(200);
    expect((await requestRows(id))[0]).toMatchObject({ status: 'rejected', organization_id: orgIds[1] });

    const again = await asAdmin(adminA, request(app()).post(`/api/admin/signup-requests/${pending.id}/reject`));
    expect(again.status).toBe(404);
    const sameOrg = await asAdmin(adminB, request(app()).post(`/api/admin/signup-requests/${pending.id}/reject`));
    expect(sameOrg.status).toBe(409); // visible to its own organization: already reviewed
  });
});

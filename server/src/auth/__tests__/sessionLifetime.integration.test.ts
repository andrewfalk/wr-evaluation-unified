// Absolute session lifetime on a real PostgreSQL (SEC-B M3, migration 0040). A login sets
// absolute_expires_at = login + SESSION_ABSOLUTE_TTL; rotation inherits it, and the auth middleware,
// /refresh and /csrf all refuse a lineage past it with 401 SESSION_EXPIRED. Runs in the integration
// project (npm run check:full).
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { integrationAuditPool } from '../../testing/integrationDb';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app';
import { hashToken } from '../sessionStore';
import { loginIdHash } from '../loginBackoff';
import config from '../../config';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

interface LoggedIn { accessToken: string; refresh: string; csrf: string }

function cookieValue(res: request.Response, name: string): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find(c => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`cookie ${name} not set`);
  return decodeURIComponent(hit.slice(name.length + 1).split(';')[0]);
}

function cookieHeader(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find(c => c.startsWith(`${name}=`));
}

describe.skipIf(!TEST_DB_URL)('session absolute lifetime (real PostgreSQL, SEC-B M3)', () => {
  let pool: Pool;
  let auditReader: Pool; // wr_audit_reader — the app's audit pool, and how tests read audit rows (M9)
  let app: Express;
  let orgId: string;
  let userId: string;
  const loginId = `__lifetime_${crypto.randomBytes(6).toString('hex')}__`;
  const password = 'lifetime-test-password';

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    auditReader = integrationAuditPool();
    app = createApp({ pool, auditPool: auditReader });
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('__lifetime_org__') RETURNING id`)).rows[0].id;
    userId = (await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1, $2, '수명 시험', 'doctor', $3) RETURNING id`,
      [loginId, await bcrypt.hash(password, 4), orgId],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM login_backoff WHERE login_hash = $1`, [loginIdHash(loginId)]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]); // cascades sessions
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
    await auditReader.end();
  });

  async function login(body: Record<string, unknown> = {}): Promise<LoggedIn & { res: request.Response }> {
    // A fresh app per login: the per-IP login limiter (5/min) lives in each app's memory.
    const res = await request(createApp({ pool, auditPool: auditReader })).post('/api/auth/login').send({ loginId, password, ...body });
    expect(res.status).toBe(200);
    return { res, accessToken: res.body.accessToken, refresh: cookieValue(res, 'wr_refresh'), csrf: cookieValue(res, 'wr_csrf') };
  }

  const sessionRow = async (refresh: string) => (await pool.query<{
    family_id: string; absolute_expires_at: Date; expires_at: Date; created_at: Date;
  }>(
    `SELECT family_id, absolute_expires_at, expires_at, created_at FROM sessions WHERE refresh_token_hash = $1`,
    [hashToken(refresh)],
  )).rows[0];

  const refreshCall = (s: LoggedIn) =>
    request(app).post('/api/auth/refresh').set('Cookie', `wr_refresh=${s.refresh}; wr_csrf=${s.csrf}`).set('x-csrf-token', s.csrf);
  const csrfCall = (s: LoggedIn) => request(app).post('/api/auth/csrf').set('Cookie', `wr_refresh=${s.refresh}`);
  const meCall = (s: LoggedIn) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${s.accessToken}`);

  it('a login sets absolute = login + SESSION_ABSOLUTE_TTL and idle = min(now + REFRESH_TOKEN_TTL, absolute)', async () => {
    const s = await login();
    const row = await sessionRow(s.refresh);
    const absSec = (row.absolute_expires_at.getTime() - row.created_at.getTime()) / 1000;
    expect(Math.abs(absSec - config.auth.sessionAbsoluteTtl)).toBeLessThan(5);
    expect(row.expires_at.getTime()).toBeLessThanOrEqual(row.absolute_expires_at.getTime());
  });

  it('rotation keeps the lineage absolute expiry (it never grows) and caps the idle expiry by it', async () => {
    const s1 = await login();
    const before = await sessionRow(s1.refresh);
    // Bring the absolute expiry close so the idle TTL (24 h) would pass it.
    const soon = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(`UPDATE sessions SET absolute_expires_at = $2 WHERE family_id = $1`, [before.family_id, soon]);

    const r = await refreshCall(s1);
    expect(r.status).toBe(200);
    const s2 = { accessToken: r.body.accessToken, refresh: cookieValue(r, 'wr_refresh'), csrf: cookieValue(r, 'wr_csrf') };
    const after = await sessionRow(s2.refresh);
    expect(after.family_id).toBe(before.family_id);
    expect(after.absolute_expires_at.getTime()).toBe(soon.getTime());
    expect(after.expires_at.getTime()).toBe(soon.getTime()); // LEAST(now + 24 h, absolute)
  });

  it('past the absolute lifetime: /me, /refresh and /csrf all answer 401 SESSION_EXPIRED', async () => {
    const s = await login();
    const row = await sessionRow(s.refresh);
    expect((await meCall(s)).status).toBe(200);

    // Absolute expiry passed; the idle expiry is (artificially) still in the future, so only the
    // absolute check can refuse these requests.
    await pool.query(
      `UPDATE sessions SET absolute_expires_at = now() - interval '1 second', expires_at = now() + interval '1 hour' WHERE family_id = $1`,
      [row.family_id],
    );

    for (const res of [await meCall(s), await refreshCall(s), await csrfCall(s)]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SESSION_EXPIRED');
    }
    // Nothing was rotated.
    const count = await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE family_id = $1`, [row.family_id]);
    expect(count.rows[0].n).toBe(1);
  });

  it('an idle-expired (not absolute-expired) session keeps the old codes', async () => {
    const s = await login();
    const row = await sessionRow(s.refresh);
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE family_id = $1`, [row.family_id]);
    expect((await meCall(s)).body.code).toBe('SESSION_REVOKED');
    expect((await refreshCall(s)).body.code).toBe('SESSION_INVALID');
    expect((await csrfCall(s)).body.code).toBe('SESSION_INVALID');
  });

  it('a logged-out session past its absolute lifetime is still reported as invalid, not expired', async () => {
    const s = await login();
    const row = await sessionRow(s.refresh);
    await pool.query(
      `UPDATE sessions SET invalidated_at = now(), absolute_expires_at = now() - interval '1 second' WHERE family_id = $1`,
      [row.family_id],
    );
    expect((await refreshCall(s)).body.code).toBe('SESSION_INVALID');
    expect((await meCall(s)).body.code).toBe('SESSION_REVOKED');
  });

  it('logout of a session past its absolute lifetime needs no CSRF and clears the cookies (200)', async () => {
    const s = await login();
    const row = await sessionRow(s.refresh);
    // What migration 0040 leaves for an old login: absolute expiry passed, idle expiry capped to it.
    await pool.query(
      `UPDATE sessions SET absolute_expires_at = now() - interval '1 second', expires_at = now() - interval '1 second' WHERE family_id = $1`,
      [row.family_id],
    );
    const res = await request(app).post('/api/auth/logout').set('Cookie', `wr_refresh=${s.refresh}`);
    expect(res.status).toBe(200);
    expect(cookieHeader(res, 'wr_refresh')).toMatch(/^wr_refresh=;/);
  });

  it('logout of a session past its absolute lifetime is "nothing to revoke" even if its idle expiry is later', async () => {
    const s = await login();
    const row = await sessionRow(s.refresh);
    await pool.query(
      `UPDATE sessions SET absolute_expires_at = now() - interval '1 second', expires_at = now() + interval '1 hour' WHERE family_id = $1`,
      [row.family_id],
    );
    const res = await request(app).post('/api/auth/logout').set('Cookie', `wr_refresh=${s.refresh}`);
    expect(res.status).toBe(200); // no 403 CSRF_INVALID for a session that is already over
  });

  it('rememberMe defaults to false: the refresh cookie is a session cookie unless rememberMe is true', async () => {
    const plain = await login();
    expect(cookieHeader(plain.res, 'wr_refresh')).not.toMatch(/Expires=/i);
    const kept = await login({ rememberMe: true });
    const header = cookieHeader(kept.res, 'wr_refresh') ?? '';
    expect(header).toMatch(/Expires=/i);
    // The persistent cookie never outlives the absolute lifetime.
    const expires = new Date(/Expires=([^;]+)/i.exec(header)![1]).getTime();
    const row = await sessionRow(kept.refresh);
    expect(expires).toBeLessThanOrEqual(row.absolute_expires_at.getTime() + 1000);
  });
});

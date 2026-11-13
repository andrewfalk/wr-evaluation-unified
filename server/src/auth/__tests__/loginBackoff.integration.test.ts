// Per-login-ID backoff on a real PostgreSQL (SEC-B M2, migration 0039). Each attempt is claimed (counted)
// before its password is checked, in one INSERT … ON CONFLICT DO UPDATE that refuses a locked ID, so
// parallel attempts are serialised by the row lock and no more than the threshold get through; the
// lock length doubles with each attempt after a lock ends and is capped. Runs in the integration project
// (npm run check:full).
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { integrationAuditPool } from '../../testing/integrationDb';
import request from 'supertest';
import { createApp } from '../../app';
import { claimLoginAttempt, lockedRetryAfterSec, loginIdHash } from '../loginBackoff';
import { sweepLoginBackoff } from '../../jobs/loginBackoff';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('login backoff (real PostgreSQL, SEC-B M2)', () => {
  let pool: Pool;
  let auditReader: Pool; // wr_audit_reader — the app's audit pool, and how tests read audit rows (M9)
  let orgId: string;
  let userId: string;
  const loginId = `__backoff_${crypto.randomBytes(6).toString('hex')}__`;
  const password = 'correct-horse-battery';
  const usedKeys: string[] = [];

  const freshKey = () => {
    const key = loginIdHash(`__backoff_key_${crypto.randomUUID()}__`);
    usedKeys.push(key);
    return key;
  };
  const row = async (key: string) => (await pool.query<{ failures: number; lock_sec: number | null }>(
    `SELECT failures, round(extract(epoch FROM locked_until - now()))::int AS lock_sec FROM login_backoff WHERE login_hash = $1`,
    [key],
  )).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    auditReader = integrationAuditPool();
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('__backoff_org__') RETURNING id`)).rows[0].id;
    userId = (await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1, $2, '잠금 시험', 'doctor', $3) RETURNING id`,
      [loginId, await bcrypt.hash(password, 4), orgId],
    )).rows[0].id;
    usedKeys.push(loginIdHash(loginId));
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM login_backoff WHERE login_hash = ANY($1)`, [usedKeys]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
    await auditReader.end();
  });

  const expireLock = (key: string) =>
    pool.query(`UPDATE login_backoff SET locked_until = now() - interval '1 second' WHERE login_hash = $1`, [key]);

  it('10 concurrent attempts for one unlocked ID: exactly 5 are allowed, 5 refused, failures = 5', async () => {
    const key = freshKey();
    const claims = await Promise.all(Array.from({ length: 10 }, () => claimLoginAttempt(pool, key)));
    expect(claims.filter(c => c.allowed)).toHaveLength(5);
    const refused = claims.filter(c => !c.allowed);
    expect(refused).toHaveLength(5);
    for (const c of refused) if (!c.allowed) expect(c.retryAfterSec).toBeGreaterThan(0);
    const r = await row(key);
    expect(r.failures).toBe(5);
    expect(r.lock_sec).toBeGreaterThan(55);
    expect(r.lock_sec).toBeLessThanOrEqual(60);
  });

  it('no lock for the first 4 attempts, 1 minute at the 5th, refused while locked, then doubling', async () => {
    const key = freshKey();
    for (let i = 0; i < 4; i++) expect((await claimLoginAttempt(pool, key)).allowed).toBe(true);
    expect((await row(key)).lock_sec).toBeNull();
    expect(await lockedRetryAfterSec(pool, key)).toBeNull();

    expect((await claimLoginAttempt(pool, key)).allowed).toBe(true); // the 5th attempt itself still runs
    const fifth = await row(key);
    expect(fifth.failures).toBe(5);
    expect(fifth.lock_sec).toBeGreaterThan(55);
    expect(fifth.lock_sec).toBeLessThanOrEqual(60);

    const refused = await claimLoginAttempt(pool, key);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterSec).toBeGreaterThan(55);
      expect(refused.retryAfterSec).toBeLessThanOrEqual(60);
    }
    expect((await row(key)).failures).toBe(5); // a refused attempt is not counted

    await expireLock(key);
    expect((await claimLoginAttempt(pool, key)).allowed).toBe(true);
    expect(await row(key)).toMatchObject({ failures: 6 });
    expect((await row(key)).lock_sec).toBeGreaterThan(115);
    await expireLock(key);
    await claimLoginAttempt(pool, key);
    expect((await row(key)).lock_sec).toBeGreaterThan(235);
  });

  it('a huge failure count does not overflow and stays at the 15-minute cap', async () => {
    const key = freshKey();
    await pool.query(`INSERT INTO login_backoff (login_hash, failures) VALUES ($1, 100000)`, [key]);
    expect((await claimLoginAttempt(pool, key)).allowed).toBe(true);
    const r = await row(key);
    expect(r.failures).toBe(100001);
    expect(r.lock_sec).toBeLessThanOrEqual(900);
    expect(r.lock_sec).toBeGreaterThan(890);
  });

  it('a failure more than 24 hours after the previous one starts again from 1', async () => {
    const key = freshKey();
    await pool.query(
      `INSERT INTO login_backoff (login_hash, failures, locked_until, updated_at)
       VALUES ($1, 9, now() - interval '24 hours', now() - interval '25 hours')`,
      [key],
    );
    expect((await claimLoginAttempt(pool, key)).allowed).toBe(true);
    const r = await row(key);
    expect(r.failures).toBe(1);
    expect(r.lock_sec).toBeNull();
  });

  it('an expired lock is not reported as locked', async () => {
    const key = freshKey();
    await pool.query(`INSERT INTO login_backoff (login_hash, failures, locked_until) VALUES ($1, 5, now() - interval '1 second')`, [key]);
    expect(await lockedRetryAfterSec(pool, key)).toBeNull();
  });

  it('the sweep drops stale unlocked rows and keeps recent or still-locked ones', async () => {
    const stale = freshKey();
    const recent = freshKey();
    const staleLocked = freshKey();
    await pool.query(
      `INSERT INTO login_backoff (login_hash, failures, locked_until, updated_at) VALUES
         ($1, 3, NULL, now() - interval '25 hours'),
         ($2, 3, NULL, now()),
         ($3, 9, now() + interval '5 minutes', now() - interval '25 hours')`,
      [stale, recent, staleLocked],
    );
    await sweepLoginBackoff(pool);
    const left = await pool.query<{ login_hash: string }>(
      `SELECT login_hash FROM login_backoff WHERE login_hash = ANY($1)`, [[stale, recent, staleLocked]],
    );
    expect(left.rows.map(r => r.login_hash).sort()).toEqual([recent, staleLocked].sort());
  });

  // Each request uses a fresh app so the per-IP limiter (5/min, in memory per app) does not interfere.
  const login = (id: string, pw: string) =>
    request(createApp({ pool, auditPool: auditReader })).post('/api/auth/login').send({ loginId: id, password: pw });

  it('route: 5 wrong passwords lock the ID, then even the right password gets 429 until the lock ends', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(loginId, 'wrong-password');
      expect(res.status).toBe(401);
    }
    const locked = await login(loginId, password);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('LOGIN_LOCKED');
    expect(locked.body.retryAfterSec).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBe(locked.body.retryAfterSec);
    // The locked attempt did not count, and the ID is found case- and space-insensitively.
    expect((await row(loginIdHash(` ${loginId.toUpperCase()} `))).failures).toBe(5);

    // Lock over: the right password logs in and deletes the row.
    await pool.query(`UPDATE login_backoff SET locked_until = now() - interval '1 second' WHERE login_hash = $1`, [loginIdHash(loginId)]);
    const ok = await login(loginId, password);
    expect(ok.status).toBe(200);
    expect(await row(loginIdHash(loginId))).toBeUndefined();

    const audits = await auditReader.query<{ outcome: string; extra: Record<string, unknown> | null }>(
      `SELECT outcome, extra FROM audit_logs WHERE action = 'auth_login' AND extra->>'loginIdHash' = $1 ORDER BY id`,
      [loginIdHash(loginId).slice(0, 16)],
    );
    expect(audits.rows.map(r => r.extra?.reason ?? r.outcome)).toEqual(['failure', 'failure', 'failure', 'failure', 'failure', 'locked']);
    expect(JSON.stringify(audits.rows)).not.toContain(loginId);
  });

  it('route: 10 parallel wrong logins for one ID (each from its own app) — 5 are checked (401), 5 refused (429)', async () => {
    const id = `__no_such_user_${crypto.randomBytes(6).toString('hex')}__`;
    usedKeys.push(loginIdHash(id));
    const results = await Promise.all(Array.from({ length: 10 }, () => login(id, 'wrong')));
    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
    expect((await row(loginIdHash(id))).failures).toBe(5);
  });

  it('route: an unknown login ID is locked the same way (no account-existence signal)', async () => {
    const unknown = `__no_such_user_${crypto.randomBytes(6).toString('hex')}__`;
    usedKeys.push(loginIdHash(unknown));
    for (let i = 0; i < 5; i++) expect((await login(unknown, 'whatever')).status).toBe(401);
    const res = await login(unknown, 'whatever');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('LOGIN_LOCKED');
  });
});

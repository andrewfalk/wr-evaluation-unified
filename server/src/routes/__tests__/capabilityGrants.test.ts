import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', () => ({
  default: {
    env:  'test',
    cors: { origins: [] },
    auth: {
      accessTokenTtl:     900,
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
  },
}));

const writeAuditLogStrict = vi.fn().mockResolvedValue(undefined);
vi.mock('../../middleware/audit', () => ({
  writeAuditLog:       vi.fn(),
  writeAuditLogStrict: (...args: unknown[]) => writeAuditLogStrict(...args),
}));

import { createCapabilityGrantsRouter } from '../capabilityGrants';
import { generateAccessToken } from '../../auth/tokens';

// ---------------------------------------------------------------------------
// Helpers (mirrors server/src/routes/__tests__/admin.test.ts)
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function token(role: 'admin' | 'doctor' = 'admin', userId = 'admin-1'): string {
  return generateAccessToken({
    sub: userId, sessionId: 'sess-1', orgId: 'org-1',
    role, name: 'Test User', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/capabilities', createCapabilityGrantsRouter(pool));
  return app;
}

function wireQueries(pool: Pool, ...results: unknown[][]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth middleware
  for (const rows of results) {
    mock.mockResolvedValueOnce({ rows });
  }
}

// client sequence: BEGIN (implied) → ...results → COMMIT/ROLLBACK (implied, catch-all).
function wireTxClient(pool: Pool, ...results: { rows: unknown[] }[]): ReturnType<typeof vi.fn> {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
  const clientMock = { query: vi.fn(), release: vi.fn() } as unknown as PoolClient;
  const q = clientMock.query as ReturnType<typeof vi.fn>;
  q.mockResolvedValueOnce(undefined); // BEGIN
  for (const r of results) q.mockResolvedValueOnce(r);
  q.mockResolvedValue(undefined); // COMMIT / ROLLBACK catch-all
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);
  return q;
}

const GRANT_ROW = {
  id: 'grant-1', user_id: 'user-1', user_name: 'Dr. Kim',
  capability: 'stats.view', granted_by: 'admin-1', granted_by_name: 'Admin User',
  granted_at: new Date('2026-01-01T00:00:00Z'), expires_at: null,
  reason: 'research', revoked_at: null, revocation_reason: null,
};

describe('POST /api/capabilities/grants', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('doctor')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid body (missing reason)', async () => {
    const pool = makePool();
    wireQueries(pool); // auth only — zod validation fails before any DB call
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('blocks stats.export_phi grants to a non-admin target user', async () => {
    const pool = makePool();
    wireQueries(pool, [{ role: 'doctor' }]); // auth, then PHI target-role lookup
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.export_phi', reason: 'audit prep' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PHI_GRANT_REQUIRES_ADMIN');
  });

  it('creates a new grant when none is currently open', async () => {
    const pool = makePool();
    const q = wireTxClient(
      pool,
      { rows: [] },                // SELECT open grant — none
      { rows: [{ id: 'grant-1' }] } // INSERT ... RETURNING id
    );
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [GRANT_ROW] }); // post-commit re-fetch
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'research' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('grant-1');
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'capability_grant' }));
    // BEGIN, SELECT open, INSERT, COMMIT — no UPDATE (nothing to close).
    const sqlCalls = q.mock.calls.map(c => String(c[0]));
    expect(sqlCalls.some(s => s.includes('UPDATE user_capability_grants'))).toBe(false);
  });

  it('closes an expired open grant (expired_regrant) before inserting the new one', async () => {
    const pool = makePool();
    const pastExpiry = new Date(Date.now() - 60_000);
    const q = wireTxClient(
      pool,
      { rows: [{ id: 'old-grant', expires_at: pastExpiry }] }, // SELECT open — expired
      { rows: [] },                                            // UPDATE close
      { rows: [{ id: 'grant-2' }] }                             // INSERT RETURNING id
    );
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [GRANT_ROW] });
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'renewed' });
    expect(res.status).toBe(201);
    const closeCall = q.mock.calls.find(c => String(c[0]).includes("revocation_reason = 'expired_regrant'"));
    expect(closeCall).toBeDefined();
    expect(closeCall?.[1]).toEqual(['old-grant']);
  });

  it('returns 409 when an active (non-expired) grant already exists', async () => {
    const pool = makePool();
    const q = wireTxClient(
      pool,
      { rows: [{ id: 'old-grant', expires_at: null }] }, // SELECT open — active, never expires
    );
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'dup' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GRANT_ALREADY_ACTIVE');
    expect(q.mock.calls.some(c => String(c[0]).startsWith('INSERT'))).toBe(false);
  });

  it('returns 409 (not 500) when INSERT loses the open-grant unique-index race', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    const uniqueViolation = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'user_capability_grants_open_uniq',
    });
    const clientMock = { query: vi.fn(), release: vi.fn() } as unknown as PoolClient;
    const q = clientMock.query as ReturnType<typeof vi.fn>;
    q.mockResolvedValueOnce(undefined)   // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT open — none seen (winner just committed elsewhere)
      .mockRejectedValueOnce(uniqueViolation) // INSERT loses the race
      .mockResolvedValue(undefined);       // ROLLBACK
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);

    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'race' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GRANT_ALREADY_ACTIVE');
    expect(q.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
  });

  it('rolls back the whole grant when the strict audit write fails', async () => {
    const pool = makePool();
    const q = wireTxClient(
      pool,
      { rows: [] },
      { rows: [{ id: 'grant-3' }] },
    );
    writeAuditLogStrict.mockRejectedValueOnce(new Error('audit db down'));
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'research' });
    expect(res.status).toBe(500);
    expect(q.mock.calls.some(c => c[0] === 'COMMIT')).toBe(false);
    expect(q.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
  });
});

describe('POST /api/capabilities/grants/:id/revoke', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('allows self-revoke for a non-admin subject and records self_revoke', async () => {
    const pool = makePool();
    const q = wireTxClient(
      pool,
      { rows: [{ id: 'grant-1', user_id: 'user-1', capability: 'stats.view', revoked_at: null }] },
    );
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [GRANT_ROW] });
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set('Authorization', `Bearer ${token('doctor', 'user-1')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({});
    expect(res.status).toBe(200);
    const updateCall = q.mock.calls.find(c => String(c[0]).includes('UPDATE user_capability_grants'));
    expect(updateCall?.[1]).toEqual(['grant-1', 'user-1', 'org-1', 'self_revoke']);
  });

  it('returns 403 when a non-admin tries to revoke someone else\'s grant', async () => {
    const pool = makePool();
    const q = wireTxClient(
      pool,
      { rows: [{ id: 'grant-1', user_id: 'someone-else', capability: 'stats.view', revoked_at: null }] },
    );
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set('Authorization', `Bearer ${token('doctor', 'user-1')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({});
    expect(res.status).toBe(403);
    expect(q.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
  });

  it('returns 404 when the grant does not exist', async () => {
    const pool = makePool();
    wireTxClient(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants/missing/revoke')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({});
    expect(res.status).toBe(404);
  });

  it('returns 409 when the grant is already revoked', async () => {
    const pool = makePool();
    wireTxClient(
      pool,
      { rows: [{ id: 'grant-1', user_id: 'user-1', capability: 'stats.view', revoked_at: new Date() }] },
    );
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({});
    expect(res.status).toBe(409);
  });

  it('rolls back when the strict audit write fails', async () => {
    const pool = makePool();
    const q = wireTxClient(
      pool,
      { rows: [{ id: 'grant-1', user_id: 'user-1', capability: 'stats.view', revoked_at: null }] },
    );
    writeAuditLogStrict.mockRejectedValueOnce(new Error('audit db down'));
    const res = await request(makeApp(pool))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({});
    expect(res.status).toBe(500);
    expect(q.mock.calls.some(c => c[0] === 'COMMIT')).toBe(false);
    expect(q.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
  });
});

describe('GET /api/capabilities/grants/me', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('scopes the query to the caller\'s own userId and org', async () => {
    const pool = makePool();
    wireQueries(pool, [GRANT_ROW]);
    const res = await request(makeApp(pool))
      .get('/api/capabilities/grants/me')
      .set('Authorization', `Bearer ${token('doctor', 'user-1')}`);
    expect(res.status).toBe(200);
    expect(res.body.grants).toHaveLength(1);
    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[1]).toEqual(['org-1', 'user-1']);
  });
});

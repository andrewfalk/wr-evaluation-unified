import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig(),
}));

const writeAuditLogStrict = vi.fn().mockResolvedValue(undefined);
vi.mock('../../middleware/audit', () => ({
  writeAuditLog:       vi.fn(),
  writeAuditLogStrict: (...args: unknown[]) => writeAuditLogStrict(...args),
}));

import { createCapabilityGrantsRouter } from '../capabilityGrants';
import {
  createFakePool, authSessionHandler, sequenceHandler,
  type FakePool, type FakeQueryReply, type RecordedQuery,
} from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// CSRF 원문은 testing/tokens 기본값('ok') — authHeaders()가 같은 값을 x-csrf-token으로 싣는다.
function token(role: 'admin' | 'doctor' = 'admin', userId = 'admin-1'): string {
  return makeAccessToken({ userId, sessionId: 'sess-1', orgId: 'org-1', role, name: 'Test User' });
}

function grantsApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/capabilities', createCapabilityGrantsRouter(fake.pool)));
}

// auth middleware session check, then pool.query route queries in call order.
function makeFake(...results: unknown[][]): FakePool {
  return createFakePool({
    handlers: [authSessionHandler(), sequenceHandler(results.map(rows => ({ rows })), { via: 'pool' })],
  });
}

const TX_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;

// client sequence: BEGIN (implied) → ...results → COMMIT/ROLLBACK (implied).
// 트랜잭션 제어문은 fakePool 기본 응답(빈 결과)으로 넘어가고 fake.calls·fake.transactions에 기록된다.
function makeTxFake(...results: (FakeQueryReply | Error)[]): FakePool {
  return createFakePool({
    handlers: [
      authSessionHandler(),
      sequenceHandler(results, { name: 'tx', via: 'client', match: sql => !TX_CONTROL.test(sql) }),
    ],
  });
}

// 트랜잭션 client가 보낸 쿼리(기존 테스트의 clientMock.query.mock.calls에 해당).
function clientCalls(fake: FakePool): RecordedQuery[] {
  return fake.calls.filter(c => c.via === 'client');
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
    const fake = makeFake();
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('doctor')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid body (missing reason)', async () => {
    const fake = makeFake(); // auth only — zod validation fails before any DB call
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 for a whitespace-only reason', async () => {
    const fake = makeFake();
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 for a non-ISO expiresAt', async () => {
    const fake = makeFake();
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'x', expiresAt: 'next tuesday' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when expiresAt is in the past (grant_ttl CHECK precondition)', async () => {
    const fake = makeFake();
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({
        userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'x',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EXPIRES_AT');
  });

  it('blocks stats.export_phi grants to a non-admin target user', async () => {
    const fake = makeFake([{ role: 'doctor' }]); // auth, then PHI target-role lookup
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.export_phi', reason: 'audit prep' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PHI_GRANT_REQUIRES_ADMIN');
  });

  it('creates a new grant when none is currently open', async () => {
    const fake = makeTxFake(
      { rows: [] },                 // SELECT open grant — none
      { rows: [{ id: 'grant-1' }] }, // INSERT ... RETURNING id
      { rows: [{ ...GRANT_ROW, id: 'grant-1' }] }, // 커밋 전 응답용 재조회(같은 트랜잭션)
    );
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'research' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('grant-1');
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'capability_grant' }));
    // BEGIN, SELECT open, INSERT, COMMIT — no UPDATE (nothing to close).
    const sqlCalls = clientCalls(fake).map(c => c.sql);
    expect(sqlCalls.some(s => s.includes('UPDATE user_capability_grants'))).toBe(false);
  });

  it('closes an expired open grant (expired_regrant) before inserting the new one', async () => {
    const pastExpiry = new Date(Date.now() - 60_000);
    const fake = makeTxFake(
      { rows: [{ id: 'old-grant', expires_at: pastExpiry }] }, // SELECT open — expired
      { rows: [] },                                            // UPDATE close
      { rows: [{ id: 'grant-2' }] },                            // INSERT RETURNING id
      { rows: [{ ...GRANT_ROW, id: 'grant-2' }] },              // 커밋 전 응답용 재조회
    );
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'renewed' });
    expect(res.status).toBe(201);
    const closeCall = clientCalls(fake).find(c => c.sql.includes("revocation_reason = 'expired_regrant'"));
    expect(closeCall).toBeDefined();
    expect(closeCall?.params).toEqual(['old-grant']);
  });

  it('returns 409 when an active (non-expired) grant already exists', async () => {
    const fake = makeTxFake(
      { rows: [{ id: 'old-grant', expires_at: null }] }, // SELECT open — active, never expires
    );
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'dup' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GRANT_ALREADY_ACTIVE');
    expect(clientCalls(fake).some(c => c.sql.startsWith('INSERT'))).toBe(false);
  });

  it('returns 400 (not 500) when the DB grant_ttl CHECK rejects a near-future expiresAt', async () => {
    // 앱단 검사(Date.now() 기준)는 통과하지만, INSERT 시점에는 DB의 granted_at(now())이
    // 이미 expiresAt을 넘어선 경쟁 상황을 흉내낸다 — PHI 조회·FOR UPDATE 대기·시계 차이 등.
    const ttlViolation = Object.assign(new Error('check constraint violated'), {
      code: '23514', constraint: 'grant_ttl',
    });
    // auth, then client: BEGIN (implied) → SELECT open — none → INSERT rejected by DB — grant_ttl → ROLLBACK (implied)
    const fake = makeTxFake({ rows: [] }, ttlViolation);

    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({
        userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'race',
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EXPIRES_AT');
    expect(clientCalls(fake).some(c => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('returns 409 (not 500) when INSERT loses the open-grant unique-index race', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'user_capability_grants_open_uniq',
    });
    // auth, then client: BEGIN (implied) → SELECT open — none seen (winner just committed elsewhere)
    // → INSERT loses the race → ROLLBACK (implied)
    const fake = makeTxFake({ rows: [] }, uniqueViolation);

    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'race' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GRANT_ALREADY_ACTIVE');
    expect(clientCalls(fake).some(c => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('rolls back the whole grant when the strict audit write fails', async () => {
    const fake = makeTxFake(
      { rows: [] },
      { rows: [{ id: 'grant-3' }] },
    );
    writeAuditLogStrict.mockRejectedValueOnce(new Error('audit db down'));
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants')
      .set(authHeaders(token('admin')))
      .send({ userId: '11111111-1111-4111-8111-111111111111', capability: 'stats.view', reason: 'research' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
    expect(clientCalls(fake).some(c => c.sql === 'COMMIT')).toBe(false);
    expect(clientCalls(fake).some(c => c.sql === 'ROLLBACK')).toBe(true);
  });
});

describe('POST /api/capabilities/grants/:id/revoke', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('allows self-revoke for a non-admin subject and records self_revoke', async () => {
    const fake = makeTxFake(
      { rows: [{ id: 'grant-1', user_id: 'user-1', capability: 'stats.view', revoked_at: null }] }, // SELECT grant
      { rows: [] },           // UPDATE revoke
      { rows: [GRANT_ROW] },  // 커밋 전 응답용 재조회
    );
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set(authHeaders(token('doctor', 'user-1')))
      .send({});
    expect(res.status).toBe(200);
    const updateCall = clientCalls(fake).find(c => c.sql.includes('UPDATE user_capability_grants'));
    expect(updateCall?.params).toEqual(['grant-1', 'user-1', 'org-1', 'self_revoke']);
  });

  it('returns 403 when a non-admin tries to revoke someone else\'s grant', async () => {
    const fake = makeTxFake(
      { rows: [{ id: 'grant-1', user_id: 'someone-else', capability: 'stats.view', revoked_at: null }] },
    );
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set(authHeaders(token('doctor', 'user-1')))
      .send({});
    expect(res.status).toBe(403);
    expect(clientCalls(fake).some(c => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('returns 404 when the grant does not exist', async () => {
    const fake = makeTxFake({ rows: [] });
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants/missing/revoke')
      .set(authHeaders(token('admin')))
      .send({});
    expect(res.status).toBe(404);
  });

  it('returns 409 when the grant is already revoked', async () => {
    const fake = makeTxFake(
      { rows: [{ id: 'grant-1', user_id: 'user-1', capability: 'stats.view', revoked_at: new Date() }] },
    );
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set(authHeaders(token('admin')))
      .send({});
    expect(res.status).toBe(409);
  });

  it('rolls back when the strict audit write fails', async () => {
    const fake = makeTxFake(
      { rows: [{ id: 'grant-1', user_id: 'user-1', capability: 'stats.view', revoked_at: null }] },
    );
    writeAuditLogStrict.mockRejectedValueOnce(new Error('audit db down'));
    const res = await request(grantsApp(fake))
      .post('/api/capabilities/grants/grant-1/revoke')
      .set(authHeaders(token('admin')))
      .send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
    expect(clientCalls(fake).some(c => c.sql === 'COMMIT')).toBe(false);
    expect(clientCalls(fake).some(c => c.sql === 'ROLLBACK')).toBe(true);
  });
});

describe('GET /api/capabilities/grants/me', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('scopes the query to the caller\'s own userId and org', async () => {
    const fake = makeFake([GRANT_ROW]);
    const res = await request(grantsApp(fake))
      .get('/api/capabilities/grants/me')
      .set('Authorization', `Bearer ${token('doctor', 'user-1')}`);
    expect(res.status).toBe(200);
    expect(res.body.grants).toHaveLength(1);
    const call = fake.calls[1]!;
    expect(call.params).toEqual(['org-1', 'user-1']);
  });
});

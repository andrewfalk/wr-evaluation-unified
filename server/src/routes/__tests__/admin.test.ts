import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig(),
}));

vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn() }));

import { createAdminRouter } from '../admin';
import {
  createFakePool, authSessionHandler, sequenceHandler, pgError,
  type FakePool, type FakeQueryReply, type RecordedQuery,
} from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// CSRF 원문은 testing/tokens 기본값('ok') — authHeaders()가 같은 값을 x-csrf-token으로 싣는다.
function token(role: 'admin' | 'doctor' = 'admin'): string {
  return makeAccessToken({ userId: 'admin-1', sessionId: 'sess-1', orgId: 'org-1', role, name: 'Admin User' });
}

function adminApp(fake: FakePool, auditFake?: FakePool) {
  return makeRouterApp(a => a.use('/api/admin', createAdminRouter(fake.pool, (auditFake ?? fake).pool)));
}

// auth middleware session check(authSessionHandler), then successive pool.query replies in call order.
function fakePoolReplies(...replies: (FakeQueryReply | Error)[]): FakePool {
  return createFakePool({
    handlers: [authSessionHandler(), sequenceHandler(replies, { via: 'pool' })],
  });
}

// auth middleware session check, then successive pool.query results (rows) in call order.
function fakeQueries(...results: unknown[][]): FakePool {
  return fakePoolReplies(...results.map(rows => ({ rows })));
}

const TX_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;

// auth middleware on pool.query, and a transaction client on pool.connect.
// client sequence: BEGIN (implied), ...results, COMMIT/ROLLBACK (implied) — 트랜잭션 제어문은 fakePool
// 기본 응답(빈 결과)으로 넘어가고 fake.calls·fake.transactions에 기록된다.
function fakeTx(...results: (FakeQueryReply | Error)[]): FakePool {
  return createFakePool({
    handlers: [
      authSessionHandler(),
      sequenceHandler(results, { name: 'tx', via: 'client', match: sql => !TX_CONTROL.test(sql) }),
    ],
  });
}

// 트랜잭션 client가 보낸 쿼리(기존 테스트의 clientMock.query.mock.calls에 해당 — BEGIN/COMMIT 포함).
function clientCalls(fake: FakePool): RecordedQuery[] {
  return fake.calls.filter(c => c.via === 'client');
}

// auditPool(감사 로그 조회 전용) — 인증 미들웨어는 pool 쪽이라 세션 확인 handler가 없다.
function fakeAuditPool(...results: unknown[][]): FakePool {
  return createFakePool({
    handlers: [sequenceHandler(results.map(rows => ({ rows })), { name: 'audit' })],
  });
}

const DEVICE_ROW = {
  id: 'dev-1', user_id: 'user-1', user_name: 'Dr. Kim',
  user_login_id: 'doc1', organization_id: 'org-1',
  public_key: 'abc', build_target: 'intranet', status: 'pending',
  approved_by: null, approver_name: null, approved_at: null,
  registered_at: new Date(), revoked_at: null, last_seen_at: null,
  register_origin: 'https://wr.hospital.local:8443',
  register_ua: 'Electron/28.0 Chrome/120',
  register_ip: '10.0.0.1',
};

// ---------------------------------------------------------------------------
// GET /api/admin/devices
// ---------------------------------------------------------------------------
describe('GET /api/admin/devices', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = fakeQueries(); // no Bearer — the auth middleware rejects before any query
    const res = await request(adminApp(fake)).get('/api/admin/devices');
    expect(res.status).toBe(401);
    fake.assertNoUnmatched();
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 403 when user is not admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .get('/api/admin/devices')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns device list with suspicious flag', async () => {
    const fake = fakeQueries([DEVICE_ROW]);

    const res = await request(adminApp(fake))
      .get('/api/admin/devices')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].status).toBe('pending');
    // Electron UA → not suspicious
    expect(res.body.devices[0].suspicious).toBe(false);
  });

  it('flags non-Electron UA as suspicious', async () => {
    const fake = fakeQueries([{
      ...DEVICE_ROW,
      register_ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
    }]);

    const res = await request(adminApp(fake))
      .get('/api/admin/devices')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.body.devices[0].suspicious).toBe(true);
    fake.assertNoUnmatched();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/devices/:id/approve
// ---------------------------------------------------------------------------
describe('POST /api/admin/devices/:id/approve', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .post('/api/admin/devices/dev-1/approve')
      .set(authHeaders(token('doctor')));
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns 404 when device does not exist', async () => {
    const fake = fakeQueries(
      [],               // UPDATE returns nothing (no pending row with this id)
      []                // SELECT status returns nothing
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/devices/missing-id/approve')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('returns 409 when device is not pending', async () => {
    const fake = fakeQueries(
      [],                                   // UPDATE: no pending row
      [{ status: 'active' }]                // SELECT: device exists but not pending
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/devices/dev-1/approve')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('DEVICE_NOT_PENDING');
  });

  it('approves pending device and returns active status', async () => {
    const fake = fakeQueries([{ id: 'dev-1', status: 'active' }]);

    const res = await request(adminApp(fake))
      .post('/api/admin/devices/dev-1/approve')
      .set(authHeaders(token('admin')));

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.deviceId).toBe('dev-1');
    expect(res.body.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/devices/:id/revoke
// ---------------------------------------------------------------------------
describe('POST /api/admin/devices/:id/revoke', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 404 when device does not exist', async () => {
    const fake = fakeQueries([], []);
    const res = await request(adminApp(fake))
      .post('/api/admin/devices/gone/revoke')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    fake.assertNoUnmatched();
  });

  it('returns 409 when device is already revoked', async () => {
    const fake = fakeQueries(
      [],                               // UPDATE: nothing (already revoked)
      [{ status: 'revoked' }]           // SELECT confirms it exists
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/devices/dev-1/revoke')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('DEVICE_ALREADY_REVOKED');
  });

  it('revokes active device and returns revoked status', async () => {
    const fake = fakeQueries([{ id: 'dev-1', status: 'revoked' }]);

    const res = await request(adminApp(fake))
      .post('/api/admin/devices/dev-1/revoke')
      .set(authHeaders(token('admin')));

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.status).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/audit
// auditPool is passed separately; pool handles auth middleware only.
// ---------------------------------------------------------------------------
const AUDIT_ROW = {
  id:            'a1b2c3d4-0000-0000-0000-000000000001',
  actor_user_id: 'user-1',
  actor_org_id:  'org-1',
  action:        'patient_view',
  target_type:   'patient',
  target_id:     'pat-1',
  outcome:       'success',
  ip:            '10.0.0.1',
  user_agent:    'Mozilla/5.0',
  extra:         null,
  created_at:    new Date('2026-01-01T00:00:00Z'),
};

describe('PATCH /api/admin/org-settings', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function tokenNoOrg(): string {
    return makeAccessToken({ userId: 'admin-1', sessionId: 'sess-1', orgId: null, role: 'admin', name: 'Admin User' });
  }

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .patch('/api/admin/org-settings')
      .set(authHeaders(token('doctor')))
      .send({ inferenceDevice: 'cpu' });
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns 403 FORBIDDEN (requireOrg) when admin has no organization', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .patch('/api/admin/org-settings')
      .set(authHeaders(tokenNoOrg()))
      .send({ inferenceDevice: 'cpu' });
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 400 for invalid device value', async () => {
    const fake = fakeQueries(); // auth only — validation fails before any DB write
    const res = await request(adminApp(fake))
      .patch('/api/admin/org-settings')
      .set(authHeaders(token('admin')))
      .send({ inferenceDevice: 'tpu' });
    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('updates inference device and returns it', async () => {
    const fake = fakeQueries([{ inference_device: 'cuda' }]); // auth, then UPDATE RETURNING
    const res = await request(adminApp(fake))
      .patch('/api/admin/org-settings')
      .set(authHeaders(token('admin')))
      .send({ inferenceDevice: 'cuda' });
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.inferenceDevice).toBe('cuda');
  });
});

describe('GET /api/admin/audit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when unauthenticated', async () => {
    const fake = fakeQueries(); // no Bearer — the auth middleware rejects before any query
    const res = await request(adminApp(fake)).get('/api/admin/audit');
    expect(res.status).toBe(401);
    fake.assertNoUnmatched();
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 403 for non-admin role', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns paginated audit logs from auditPool', async () => {
    // pool: auth middleware session check
    const fake = fakeQueries();

    // auditPool: COUNT query + SELECT query (Promise.all)
    const auditFake = fakeAuditPool([{ total: '1' }], [AUDIT_ROW]);

    const res = await request(adminApp(fake, auditFake))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].action).toBe('patient_view');
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
  });

  it('applies action/targetType filters', async () => {
    const fake      = fakeQueries();
    const auditFake = fakeAuditPool([{ total: '0' }], []);

    const res = await request(adminApp(fake, auditFake))
      .get('/api/admin/audit?action=login&targetType=session')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.items).toHaveLength(0);

    // Both COUNT and SELECT queries must have received filter params
    const calls = auditFake.calls;
    expect(calls[0]!.params).toContain('login');
    expect(calls[0]!.params).toContain('session');
  });

  it('returns 400 for limit exceeding 200', async () => {
    const fake      = fakeQueries();
    const auditFake = fakeAuditPool();

    const res = await request(adminApp(fake, auditFake))
      .get('/api/admin/audit?limit=9999')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('INVALID_PARAMS');
    expect(auditFake.calls).toHaveLength(0);
  });

  it('returns 400 for invalid actorUserId (not a UUID)', async () => {
    const fake      = fakeQueries();
    const auditFake = fakeAuditPool();

    const res = await request(adminApp(fake, auditFake))
      .get('/api/admin/audit?actorUserId=not-a-uuid')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('INVALID_PARAMS');
    // auditPool should not have been queried
    expect(auditFake.calls).toHaveLength(0);
  });

  it('returns 400 for invalid from date', async () => {
    const fake      = fakeQueries();
    const auditFake = fakeAuditPool();

    const res = await request(adminApp(fake, auditFake))
      .get('/api/admin/audit?from=not-a-date')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('INVALID_PARAMS');
  });

  it('records admin_audit_view in audit log after successful query', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake      = fakeQueries();
    const auditFake = fakeAuditPool([{ total: '0' }], []);

    await request(adminApp(fake, auditFake))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(writeAuditLog).toHaveBeenCalledWith(
      fake.pool,
      expect.objectContaining({ action: 'admin_audit_view', outcome: 'success' })
    );
    fake.assertNoUnmatched();
    auditFake.assertNoUnmatched();
  });

  it('uses auditPool not pool for queries', async () => {
    const fake      = fakeQueries();
    const auditFake = fakeAuditPool([{ total: '0' }], []);

    await request(adminApp(fake, auditFake))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('admin')}`);

    // auditPool called twice (COUNT + SELECT), pool only once (auth)
    expect(fake.calls).toHaveLength(1);
    expect(fake.callsTo('auth.session')).toHaveLength(1);
    expect(auditFake.calls).toHaveLength(2);
    auditFake.assertNoUnmatched();
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------
const USER_ROW = {
  id: 'user-2', login_id: 'doc1', name: 'Dr. Park', role: 'doctor',
  organization_id: 'org-1', must_change_password: false, disabled_at: null,
  created_at: new Date(), last_login_at: null,
};

describe('GET /api/admin/users', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns user list with disabled flag', async () => {
    const fake = fakeQueries([USER_ROW, { ...USER_ROW, id: 'user-3', disabled_at: new Date() }]);
    const res = await request(adminApp(fake))
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[0].disabled).toBe(false);
    expect(res.body.users[1].disabled).toBe(true);
  });

  it('answers a DB failure with the 500 envelope (central error handler, S1)', async () => {
    const fake = fakePoolReplies(new Error('connection terminated')); // auth middleware: authSessionHandler
    const res = await request(adminApp(fake))
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(500);
    fake.assertNoUnmatched();
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
    expect(fake.callsTo('sequence')).toHaveLength(1); // 500은 준비한 DB 오류에서 나왔다
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users
// ---------------------------------------------------------------------------
// Valid password satisfying checkPasswordPolicy: ≥10 chars, letter+digit+special
const VALID_PASSWORD = 'Admin@12345';

describe('POST /api/admin/users', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .post('/api/admin/users')
      .set(authHeaders(token('doctor')))
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: VALID_PASSWORD });
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns 400 PASSWORD_POLICY for a new password over 128 characters (SEC-A L6)', async () => {
    const fake = fakeQueries(); // only auth — rejected before any query
    const res = await request(adminApp(fake))
      .post('/api/admin/users')
      .set(authHeaders(token('admin')))
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: VALID_PASSWORD + 'x'.repeat(129 - VALID_PASSWORD.length) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'PASSWORD_POLICY', error: '비밀번호는 최대 128자까지 사용할 수 있습니다.' });
    fake.assertNoUnmatched();
  });

  it('returns 400 when password does not meet policy (too short)', async () => {
    const fake = fakeQueries(); // only auth
    const res = await request(adminApp(fake))
      .post('/api/admin/users')
      .set(authHeaders(token('admin')))
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: 'short' });
    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });

  it('returns 400 when password has no special character', async () => {
    const fake = fakeQueries();
    const res = await request(adminApp(fake))
      .post('/api/admin/users')
      .set(authHeaders(token('admin')))
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: 'NoSpecial1234' });
    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });

  it('creates user and returns 201', async () => {
    const insertedRow = { ...USER_ROW, id: 'new-id', login_id: 'new1', name: 'New' };
    const fake = fakeQueries([insertedRow]);
    const res = await request(adminApp(fake))
      .post('/api/admin/users')
      .set(authHeaders(token('admin')))
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: VALID_PASSWORD });
    expect(res.status).toBe(201);
    fake.assertNoUnmatched();
    expect(res.body.user.loginId).toBe('new1');
    expect(res.body.user.disabled).toBe(false);
  });

  it('returns 409 when loginId already exists (pg 23505)', async () => {
    // auth: authSessionHandler, then INSERT INTO users → unique violation
    const fake = fakePoolReplies(pgError('23505', 'unique violation'));
    const res = await request(adminApp(fake))
      .post('/api/admin/users')
      .set(authHeaders(token('admin')))
      .send({ loginId: 'dup', name: 'Dup', role: 'doctor', password: VALID_PASSWORD });
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('LOGIN_ID_TAKEN');
    expect(fake.callsTo('sequence')).toHaveLength(1); // 준비한 INSERT 23505까지 도달
  });

  it('records admin_user_create audit log on success', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = fakeQueries([USER_ROW]);
    await request(adminApp(fake))
      .post('/api/admin/users')
      .set(authHeaders(token('admin')))
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: VALID_PASSWORD });
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action: 'admin_user_create', outcome: 'success',
    }));
    fake.assertNoUnmatched();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/reset-password
// ---------------------------------------------------------------------------
describe('POST /api/admin/users/:id/reset-password', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when password does not meet policy', async () => {
    const fake = fakeQueries();
    const res = await request(adminApp(fake))
      .post('/api/admin/users/user-2/reset-password')
      .set(authHeaders(token('admin')))
      .send({ password: 'weak' });
    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });

  it('returns 404 when user not found in org', async () => {
    // Transaction: BEGIN → SELECT users (empty) → ROLLBACK
    const fake = fakeTx({ rows: [] });
    const res = await request(adminApp(fake))
      .post('/api/admin/users/missing/reset-password')
      .set(authHeaders(token('admin')))
      .send({ password: VALID_PASSWORD });
    expect(res.status).toBe(404);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  const USER_HASH_ROW = { password_hash: 'old-hash', password_history: [] };

  it('resets password, preserves history, invalidates sessions, returns 200', async () => {
    const fake = fakeTx(
      { rows: [USER_HASH_ROW] }, // SELECT password_hash + history
      { rows: [] },               // UPDATE users SET password_hash + history
      { rows: [] },               // UPDATE sessions invalidated_at
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/users/user-2/reset-password')
      .set(authHeaders(token('admin')))
      .send({ password: VALID_PASSWORD });
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.userId).toBe('user-2');
    // Verify sessions invalidation was called
    const calls = clientCalls(fake);
    const sessionCall = calls.find(c => c.sql.includes('invalidated_at'));
    expect(sessionCall).toBeDefined();
    // Verify password_history was included in UPDATE
    const updateCall = calls.find(c => c.sql.includes('password_history'));
    expect(updateCall).toBeDefined();
  });

  it('records admin_user_reset_password audit log', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = fakeTx({ rows: [USER_HASH_ROW] }, { rows: [] }, { rows: [] });
    await request(adminApp(fake))
      .post('/api/admin/users/user-2/reset-password')
      .set(authHeaders(token('admin')))
      .send({ password: VALID_PASSWORD });
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action: 'admin_user_reset_password', outcome: 'success',
    }));
    fake.assertNoUnmatched();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/disable  &  /enable
// ---------------------------------------------------------------------------
describe('POST /api/admin/users/:id/disable', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when trying to disable own account', async () => {
    const fake = fakeQueries(); // auth only
    // Token sub is 'admin-1', so request to disable 'admin-1' is self-disable
    const res = await request(adminApp(fake))
      .post('/api/admin/users/admin-1/disable')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('returns 404 when user not found', async () => {
    const fake = fakeQueries([], []); // UPDATE → empty, SELECT → empty
    const res = await request(adminApp(fake))
      .post('/api/admin/users/missing/disable')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('returns 409 when user already disabled', async () => {
    const fake = fakeQueries(
      [],                      // UPDATE: user already has disabled_at set
      [{ id: 'user-2' }]      // SELECT: user exists
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/users/user-2/disable')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('USER_ALREADY_DISABLED');
  });

  it('disables user and writes audit log', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = fakeQueries([{ id: 'user-2' }]); // UPDATE RETURNING
    const res = await request(adminApp(fake))
      .post('/api/admin/users/user-2/disable')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action: 'admin_user_disable', targetId: 'user-2', outcome: 'success',
    }));
  });
});

describe('POST /api/admin/users/:id/enable', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 409 when user already enabled (disabled_at IS NULL)', async () => {
    const fake = fakeQueries(
      [],                      // UPDATE: no rows (already enabled)
      [{ id: 'user-2' }]      // SELECT: user exists
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/users/user-2/enable')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('USER_ALREADY_ENABLED');
  });

  it('enables user and writes audit log', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = fakeQueries([{ id: 'user-2' }]);
    const res = await request(adminApp(fake))
      .post('/api/admin/users/user-2/enable')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action: 'admin_user_enable', targetId: 'user-2', outcome: 'success',
    }));
  });
});

// ---------------------------------------------------------------------------
// Signup-requests shared fixture
// ---------------------------------------------------------------------------
const REQ_ROW = {
  id:             'req-1',
  login_id:       'newdoc',
  name:           '김의사',
  requested_role: 'doctor',
  note:           null,
  status:         'pending',
  reviewer_name:  null,
  reviewed_at:    null,
  created_at:     new Date(),
};

// ---------------------------------------------------------------------------
// GET /api/admin/signup-requests
// ---------------------------------------------------------------------------
describe('GET /api/admin/signup-requests', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .get('/api/admin/signup-requests')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns list of pending requests by default', async () => {
    const fake = fakeQueries([REQ_ROW]);
    const res = await request(adminApp(fake))
      .get('/api/admin/signup-requests')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].loginId).toBe('newdoc');
    expect(res.body.requests[0].requestedRole).toBe('doctor');
    expect(res.body.requests[0].status).toBe('pending');
  });

  it('applies status filter for approved requests', async () => {
    const fake = fakeQueries([{ ...REQ_ROW, status: 'approved', reviewer_name: 'Admin User' }]);
    const res = await request(adminApp(fake))
      .get('/api/admin/signup-requests?status=approved')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.requests[0].status).toBe('approved');
    expect(res.body.requests[0].reviewerName).toBe('Admin User');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/signup-requests/:id/approve
// ---------------------------------------------------------------------------
describe('POST /api/admin/signup-requests/:id/approve', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/approve')
      .set(authHeaders(token('doctor')));
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns 404 when request does not exist', async () => {
    const fake = fakeTx({ rows: [] }); // SELECT FOR UPDATE → not found
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/missing/approve')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('REQUEST_NOT_FOUND');
  });

  it('returns 409 when request has already been reviewed', async () => {
    const fake = fakeTx({ rows: [{ ...REQ_ROW, status: 'approved' }] }); // SELECT FOR UPDATE → already reviewed
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/approve')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('ALREADY_REVIEWED');
  });

  it('returns 409 when login_id is already taken (INSERT 23505)', async () => {
    // auth: authSessionHandler. client: BEGIN (implied) → SELECT FOR UPDATE → INSERT (reject) → ROLLBACK (implied)
    const fake = fakeTx(
      { rows: [REQ_ROW] },                   // SELECT FOR UPDATE → pending
      pgError('23505', 'duplicate key'),     // INSERT INTO users → unique violation
    );

    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/approve')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('LOGIN_ID_TAKEN');
    // 409는 준비한 INSERT 23505에서 나와야 한다 — INSERT까지 도달했고 트랜잭션은 롤백.
    expect(fake.callsTo('tx')).toHaveLength(2);
    expect(fake.transactions).toEqual([{ clientId: 1, statements: ['BEGIN', 'ROLLBACK'], outcome: 'rollback' }]);
    fake.assertAllReleased();
  });

  it('returns 200 with userId and tempPassword, creates user with must_change_password', async () => {
    const fake = fakeTx(
      { rows: [REQ_ROW] },              // SELECT FOR UPDATE → pending
      { rows: [{ id: 'new-user-1' }] }, // INSERT INTO users RETURNING id
      { rows: [] },                     // UPDATE user_signup_requests SET status='approved' (기존 catchall이 답하던 쿼리)
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/approve')
      .set(authHeaders(token('admin')));

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.userId).toBe('new-user-1');
    expect(res.body.loginId).toBe('newdoc');
    // tempPassword must satisfy password policy (10+ chars, letter + digit + special)
    const pw = res.body.tempPassword as string;
    expect(pw.length).toBeGreaterThanOrEqual(10);
    expect(/[a-zA-Z]/.test(pw)).toBe(true);
    expect(/\d/.test(pw)).toBe(true);
    expect(/[^a-zA-Z0-9]/.test(pw)).toBe(true);
    // INSERT SQL must contain must_change_password = TRUE (literal, not a param)
    const insertCall = clientCalls(fake)[2]!; // calls: [0]=BEGIN, [1]=SELECT, [2]=INSERT
    expect(insertCall.sql).toMatch(/must_change_password/i);
    expect(insertCall.sql).toMatch(/TRUE/i);
  });

  it('writes admin_signup_approve audit log on success', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = fakeTx(
      { rows: [REQ_ROW] },
      { rows: [{ id: 'new-user-2' }] },
      { rows: [] }, // UPDATE user_signup_requests SET status='approved'
    );
    await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/approve')
      .set(authHeaders(token('admin')));

    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action:     'admin_signup_approve',
      targetType: 'user',
      targetId:   'new-user-2',
      outcome:    'success',
    }));
    fake.assertNoUnmatched();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/signup-requests/:id/reject
// ---------------------------------------------------------------------------
describe('POST /api/admin/signup-requests/:id/reject', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/reject')
      .set(authHeaders(token('doctor')));
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns 404 when request does not exist', async () => {
    const fake = fakeQueries([], []); // UPDATE → empty, SELECT → empty
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/missing/reject')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('REQUEST_NOT_FOUND');
  });

  it('returns 409 when request has already been reviewed', async () => {
    const fake = fakeQueries(
      [],                           // UPDATE: was not pending
      [{ status: 'approved' }]      // SELECT: exists but already reviewed
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/reject')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(409);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('ALREADY_REVIEWED');
  });

  it('returns 200 and writes admin_signup_reject audit log', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = fakeQueries([{ id: 'req-1' }]); // UPDATE WHERE status='pending' RETURNING
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/reject')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.id).toBe('req-1');
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action:     'admin_signup_reject',
      targetType: 'signup_request',
      targetId:   'req-1',
      outcome:    'success',
    }));
  });
});

// ---------------------------------------------------------------------------
// Signup requests ↔ organization (SEC-B L4, migration 0041)
// ---------------------------------------------------------------------------
describe('signup requests: organization scope and recorded organization (SEC-B L4)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const superAdminToken = () =>
    makeAccessToken({ userId: 'admin-1', sessionId: 'sess-1', orgId: null, role: 'admin', name: 'Super Admin' });
  const poolCalls = (fake: FakePool) => fake.calls.filter(c => c.via === 'pool' && c.handler !== 'auth.session');

  it('an organization admin lists only their own organization and unassigned requests', async () => {
    const fake = fakeQueries([REQ_ROW]);
    const res = await request(adminApp(fake))
      .get('/api/admin/signup-requests')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(200);
    const [list] = poolCalls(fake);
    expect(list.sql).toMatch(/WHERE r\.status = \$1 AND \(r\.organization_id IS NULL OR r\.organization_id = \$2\)/);
    expect(list.params).toEqual(['pending', 'org-1']);
    fake.assertNoUnmatched();
  });

  it('an admin without an organization (super-administrator) lists every organization', async () => {
    const fake = fakeQueries([REQ_ROW]);
    const res = await request(adminApp(fake))
      .get('/api/admin/signup-requests?status=approved')
      .set('Authorization', `Bearer ${superAdminToken()}`);
    expect(res.status).toBe(200);
    const [list] = poolCalls(fake);
    expect(list.sql).not.toMatch(/organization_id/);
    expect(list.params).toEqual(['approved']);
  });

  it('approval looks the request up within the scope and records the approver organization', async () => {
    const fake = fakeTx(
      { rows: [REQ_ROW] },
      { rows: [{ id: 'new-user-1' }] },
      { rows: [] },
    );
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/approve')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(200);
    const [select, insertUser, update] = fake.callsTo('tx');
    expect(select.sql).toMatch(/WHERE id = \$1 AND \(organization_id IS NULL OR organization_id = \$2\) FOR UPDATE/);
    expect(select.params).toEqual(['req-1', 'org-1']);
    expect(insertUser.params[4]).toBe('org-1'); // the account is created in the same organization
    expect(update.sql).toMatch(/organization_id = \$3/);
    expect(update.params).toEqual(['admin-1', 'req-1', 'org-1']);
    fake.assertNoUnmatched();
  });

  it("another organization's request is not found (404) for an organization admin", async () => {
    const fake = fakeTx({ rows: [] }); // scoped SELECT FOR UPDATE finds nothing
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-other/approve')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('REQUEST_NOT_FOUND');
    fake.assertNoUnmatched();
  });

  it('rejection is scoped the same way and records the rejecting organization', async () => {
    const fake = fakeQueries([{ id: 'req-1' }]);
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-1/reject')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(200);
    const [update] = poolCalls(fake);
    expect(update.sql).toMatch(/organization_id = \$3/);
    expect(update.sql).toMatch(/AND status = 'pending' AND \(organization_id IS NULL OR organization_id = \$4\)/);
    expect(update.params).toEqual(['admin-1', 'req-1', 'org-1', 'org-1']);
  });

  it('a rejection outside the scope is 404, not 409 (the scoped lookup finds nothing)', async () => {
    const fake = fakeQueries([], []); // scoped UPDATE → 0 rows, scoped SELECT → 0 rows
    const res = await request(adminApp(fake))
      .post('/api/admin/signup-requests/req-other/reject')
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    const [, select] = poolCalls(fake);
    expect(select.sql).toMatch(/WHERE id = \$1 AND \(organization_id IS NULL OR organization_id = \$2\)/);
    expect(select.params).toEqual(['req-other', 'org-1']);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/workspaces/:id/purge
// ---------------------------------------------------------------------------
describe('DELETE /api/admin/workspaces/:id/purge', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const WS_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries(); // auth only
    const res = await request(adminApp(fake))
      .delete(`/api/admin/workspaces/${WS_ID}/purge`)
      .set(authHeaders(token('doctor')));
    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns 404 when workspace not found', async () => {
    const fake = fakeQueries([]); // auth: authSessionHandler, then DELETE RETURNING (no rows)
    const res = await request(adminApp(fake))
      .delete(`/api/admin/workspaces/${WS_ID}/purge`)
      .set(authHeaders(token('admin')));
    expect(res.status).toBe(404);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 204 and writes audit log on successful purge', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = fakeQueries([{ id: WS_ID }]); // auth: authSessionHandler, then DELETE RETURNING

    const res = await request(adminApp(fake))
      .delete(`/api/admin/workspaces/${WS_ID}/purge`)
      .set(authHeaders(token('admin')));

    expect(res.status).toBe(204);
    fake.assertNoUnmatched();
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action:     'admin_workspace_purge',
      targetType: 'workspace',
      targetId:   WS_ID,
      outcome:    'success',
    }));
  });
});

// ---------------------------------------------------------------------------
// Preset sharing manager
// ---------------------------------------------------------------------------
const PRESET_ID_1 = '11111111-1111-1111-1111-111111111111';
const PRESET_ID_2 = '22222222-2222-2222-2222-222222222222';
const PRESET_ID_3 = '33333333-3333-3333-3333-333333333333';

function adminPresetRow(overrides = {}) {
  return {
    id:              PRESET_ID_1,
    organization_id: 'org-1',
    job_name:        '토공',
    category:        '건설업',
    description:     '',
    visibility:      'private',
    revision:        1,
    owner_user_id:   'user-9',
    owner_name:      '홍길동',
    updated_at:      new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GET /api/admin/presets', () => {
  it('returns org presets with owner name and organizationId for admin', async () => {
    const fake = fakeQueries([adminPresetRow()]);

    const res = await request(adminApp(fake))
      .get('/api/admin/presets')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].ownerName).toBe('홍길동');
    expect(res.body.presets[0].organizationId).toBe('org-1');
    expect(res.body.presets[0].jobName).toBe('토공');
    expect(res.body.presets[0]).not.toHaveProperty('modules');
  });

  it('returns 403 for non-admin', async () => {
    const fake = fakeQueries();

    const res = await request(adminApp(fake))
      .get('/api/admin/presets')
      .set('Authorization', `Bearer ${token('doctor')}`);

    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });
});

describe('POST /api/admin/presets/visibility', () => {
  it('returns 403 without CSRF token', async () => {
    const fake = fakeQueries();

    const res = await request(adminApp(fake))
      .post('/api/admin/presets/visibility')
      .set('Authorization', `Bearer ${token('admin')}`)
      .send({ ids: [PRESET_ID_1], visibility: 'organization' });

    expect(res.status).toBe(403);
    fake.assertNoUnmatched();
  });

  it('returns 400 for empty ids', async () => {
    const fake = fakeQueries();

    const res = await request(adminApp(fake))
      .post('/api/admin/presets/visibility')
      .set(authHeaders(token('admin')))
      .send({ ids: [], visibility: 'organization' });

    expect(res.status).toBe(400);
    fake.assertNoUnmatched();
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('dedupes ids and returns requested/updated counts', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    // UPDATE … RETURNING id → 2 rows updated.
    const fake = fakeQueries([{ id: PRESET_ID_1 }, { id: PRESET_ID_2 }]);

    const res = await request(adminApp(fake))
      .post('/api/admin/presets/visibility')
      .set(authHeaders(token('admin')))
      // PRESET_ID_2 repeated → deduped to 2 distinct requested.
      .send({ ids: [PRESET_ID_1, PRESET_ID_2, PRESET_ID_2], visibility: 'organization' });

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.requested).toBe(2);
    expect(res.body.updated).toBe(2);
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      action:     'admin_presets_set_visibility',
      targetType: 'custom_preset',
      targetId:   null,
      extra: expect.objectContaining({
        requested: 2,
        updated: 2,
        visibility: 'organization',
        requestedPresetIds: [PRESET_ID_1, PRESET_ID_2],
        updatedPresetIds: [PRESET_ID_1, PRESET_ID_2],
      }),
    }));
  });

  it('reports updated < requested when some rows are already at target', async () => {
    // 3 requested, but UPDATE (visibility <> $2 + org scope) returns only 1.
    const fake = fakeQueries([{ id: PRESET_ID_1 }]);

    const res = await request(adminApp(fake))
      .post('/api/admin/presets/visibility')
      .set(authHeaders(token('admin')))
      .send({ ids: [PRESET_ID_1, PRESET_ID_2, PRESET_ID_3], visibility: 'private' });

    expect(res.status).toBe(200);
    fake.assertNoUnmatched();
    expect(res.body.requested).toBe(3);
    expect(res.body.updated).toBe(1);
  });
});

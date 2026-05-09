import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { PoolClient } from 'pg';

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

vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn() }));

import { createAdminRouter } from '../admin';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return {
    connect: vi.fn(),
    query:   vi.fn(),
  } as unknown as Pool;
}

// CSRF header value used in all mutating test requests.
const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function token(role: 'admin' | 'doctor' = 'admin'): string {
  return generateAccessToken({
    sub: 'admin-1', sessionId: 'sess-1', orgId: 'org-1',
    role, name: 'Admin User', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool, auditPool?: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin', createAdminRouter(pool, auditPool ?? pool));
  return app;
}

// Wire auth middleware session check then successive query results.
function wireQueries(pool: Pool, ...results: unknown[][]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth middleware
  for (const rows of results) {
    mock.mockResolvedValueOnce({ rows });
  }
}

// Wire auth middleware on pool.query, and a transaction client on pool.connect.
// client sequence: BEGIN (implied), ...results, COMMIT/ROLLBACK (implied).
function wireTxClient(pool: Pool, ...results: { rows: unknown[] }[]): ReturnType<typeof vi.fn> {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
  const clientMock = {
    query:   vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
  const q = clientMock.query as ReturnType<typeof vi.fn>;
  q.mockResolvedValueOnce(undefined); // BEGIN
  for (const r of results) {
    q.mockResolvedValueOnce(r);
  }
  q.mockResolvedValue(undefined); // COMMIT / ROLLBACK (catches all remaining calls)
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);
  return q;
}

const DEVICE_ROW = {
  id: 'dev-1', user_id: 'user-1', user_name: 'Dr. Kim',
  user_login_id: 'doc1', organization_id: 'org-1',
  public_key: 'abc', build_target: 'intranet', status: 'pending',
  approved_by: null, approver_name: null, approved_at: null,
  registered_at: new Date(), revoked_at: null, last_seen_at: null,
  register_origin: 'https://wr.hospital.local',
  register_ua: 'Electron/28.0 Chrome/120',
  register_ip: '10.0.0.1',
};

// ---------------------------------------------------------------------------
// GET /api/admin/devices
// ---------------------------------------------------------------------------
describe('GET /api/admin/devices', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp(pool)).get('/api/admin/devices');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/admin/devices')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns device list with suspicious flag', async () => {
    const pool = makePool();
    wireQueries(pool, [DEVICE_ROW]);

    const res = await request(makeApp(pool))
      .get('/api/admin/devices')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].status).toBe('pending');
    // Electron UA → not suspicious
    expect(res.body.devices[0].suspicious).toBe(false);
  });

  it('flags non-Electron UA as suspicious', async () => {
    const pool = makePool();
    wireQueries(pool, [{
      ...DEVICE_ROW,
      register_ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
    }]);

    const res = await request(makeApp(pool))
      .get('/api/admin/devices')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.body.devices[0].suspicious).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/devices/:id/approve
// ---------------------------------------------------------------------------
describe('POST /api/admin/devices/:id/approve', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/admin/devices/dev-1/approve')
      .set('Authorization', `Bearer ${token('doctor')}`)
      .set('x-csrf-token', 'ok');
    expect(res.status).toBe(403);
  });

  it('returns 404 when device does not exist', async () => {
    const pool = makePool();
    wireQueries(pool,
      [],               // UPDATE returns nothing (no pending row with this id)
      []                // SELECT status returns nothing
    );
    const res = await request(makeApp(pool))
      .post('/api/admin/devices/missing-id/approve')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', 'ok');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('returns 409 when device is not pending', async () => {
    const pool = makePool();
    wireQueries(pool,
      [],                                   // UPDATE: no pending row
      [{ status: 'active' }]                // SELECT: device exists but not pending
    );
    const res = await request(makeApp(pool))
      .post('/api/admin/devices/dev-1/approve')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', 'ok');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_NOT_PENDING');
  });

  it('approves pending device and returns active status', async () => {
    const pool = makePool();
    wireQueries(pool, [{ id: 'dev-1', status: 'active' }]);

    const res = await request(makeApp(pool))
      .post('/api/admin/devices/dev-1/approve')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(200);
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
    const pool = makePool();
    wireQueries(pool, [], []);
    const res = await request(makeApp(pool))
      .post('/api/admin/devices/gone/revoke')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', 'ok');
    expect(res.status).toBe(404);
  });

  it('returns 409 when device is already revoked', async () => {
    const pool = makePool();
    wireQueries(pool,
      [],                               // UPDATE: nothing (already revoked)
      [{ status: 'revoked' }]           // SELECT confirms it exists
    );
    const res = await request(makeApp(pool))
      .post('/api/admin/devices/dev-1/revoke')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', 'ok');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_ALREADY_REVOKED');
  });

  it('revokes active device and returns revoked status', async () => {
    const pool = makePool();
    wireQueries(pool, [{ id: 'dev-1', status: 'revoked' }]);

    const res = await request(makeApp(pool))
      .post('/api/admin/devices/dev-1/revoke')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(200);
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

describe('GET /api/admin/audit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when unauthenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp(pool)).get('/api/admin/audit');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
  });

  it('returns paginated audit logs from auditPool', async () => {
    const pool      = makePool();
    const auditPool = makePool();

    // pool: auth middleware session check
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    // auditPool: COUNT query + SELECT query (Promise.all)
    const auditMock = auditPool.query as ReturnType<typeof vi.fn>;
    auditMock
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [AUDIT_ROW] });

    const res = await request(makeApp(pool, auditPool))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].action).toBe('patient_view');
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
  });

  it('applies action/targetType filters', async () => {
    const pool      = makePool();
    const auditPool = makePool();

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const auditMock = auditPool.query as ReturnType<typeof vi.fn>;
    auditMock
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp(pool, auditPool))
      .get('/api/admin/audit?action=login&targetType=session')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);

    // Both COUNT and SELECT queries must have received filter params
    const calls = auditMock.mock.calls;
    expect(calls[0][1]).toContain('login');
    expect(calls[0][1]).toContain('session');
  });

  it('returns 400 for limit exceeding 200', async () => {
    const pool      = makePool();
    const auditPool = makePool();

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool, auditPool))
      .get('/api/admin/audit?limit=9999')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARAMS');
    expect((auditPool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('returns 400 for invalid actorUserId (not a UUID)', async () => {
    const pool      = makePool();
    const auditPool = makePool();

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool, auditPool))
      .get('/api/admin/audit?actorUserId=not-a-uuid')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARAMS');
    // auditPool should not have been queried
    expect((auditPool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('returns 400 for invalid from date', async () => {
    const pool      = makePool();
    const auditPool = makePool();

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool, auditPool))
      .get('/api/admin/audit?from=not-a-date')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARAMS');
  });

  it('records admin_audit_view in audit log after successful query', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const pool      = makePool();
    const auditPool = makePool();

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    (auditPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(makeApp(pool, auditPool))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(writeAuditLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ action: 'admin_audit_view', outcome: 'success' })
    );
  });

  it('uses auditPool not pool for queries', async () => {
    const pool      = makePool();
    const auditPool = makePool();

    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    (auditPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(makeApp(pool, auditPool))
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token('admin')}`);

    // auditPool called twice (COUNT + SELECT), pool only once (auth)
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((auditPool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
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
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
  });

  it('returns user list with disabled flag', async () => {
    const pool = makePool();
    wireQueries(pool, [USER_ROW, { ...USER_ROW, id: 'user-3', disabled_at: new Date() }]);
    const res = await request(makeApp(pool))
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[0].disabled).toBe(false);
    expect(res.body.users[1].disabled).toBe(true);
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
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token('doctor')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: VALID_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('returns 400 when password does not meet policy (too short)', async () => {
    const pool = makePool();
    wireQueries(pool); // only auth
    const res = await request(makeApp(pool))
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });

  it('returns 400 when password has no special character', async () => {
    const pool = makePool();
    wireQueries(pool);
    const res = await request(makeApp(pool))
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: 'NoSpecial1234' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });

  it('creates user and returns 201', async () => {
    const pool = makePool();
    const insertedRow = { ...USER_ROW, id: 'new-id', login_id: 'new1', name: 'New' };
    wireQueries(pool, [insertedRow]);
    const res = await request(makeApp(pool))
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: VALID_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.loginId).toBe('new1');
    expect(res.body.user.disabled).toBe(false);
  });

  it('returns 409 when loginId already exists (pg 23505)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    const pgError = Object.assign(new Error('unique violation'), { code: '23505' });
    (pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(pgError);
    const res = await request(makeApp(pool))
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ loginId: 'dup', name: 'Dup', role: 'doctor', password: VALID_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOGIN_ID_TAKEN');
  });

  it('records admin_user_create audit log on success', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const pool = makePool();
    wireQueries(pool, [USER_ROW]);
    await request(makeApp(pool))
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ loginId: 'new1', name: 'New', role: 'doctor', password: VALID_PASSWORD });
    expect(writeAuditLog).toHaveBeenCalledWith(pool, expect.objectContaining({
      action: 'admin_user_create', outcome: 'success',
    }));
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/reset-password
// ---------------------------------------------------------------------------
describe('POST /api/admin/users/:id/reset-password', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when password does not meet policy', async () => {
    const pool = makePool();
    wireQueries(pool);
    const res = await request(makeApp(pool))
      .post('/api/admin/users/user-2/reset-password')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ password: 'weak' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_POLICY');
  });

  it('returns 404 when user not found in org', async () => {
    const pool = makePool();
    // Transaction: BEGIN → SELECT users (empty) → ROLLBACK
    wireTxClient(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .post('/api/admin/users/missing/reset-password')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ password: VALID_PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  const USER_HASH_ROW = { password_hash: 'old-hash', password_history: [] };

  it('resets password, preserves history, invalidates sessions, returns 200', async () => {
    const pool = makePool();
    const clientQuery = wireTxClient(
      pool,
      { rows: [USER_HASH_ROW] }, // SELECT password_hash + history
      { rows: [] },               // UPDATE users SET password_hash + history
      { rows: [] },               // UPDATE sessions invalidated_at
    );
    const res = await request(makeApp(pool))
      .post('/api/admin/users/user-2/reset-password')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ password: VALID_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-2');
    // Verify sessions invalidation was called
    const calls = (clientQuery as ReturnType<typeof vi.fn>).mock.calls;
    const sessionCall = calls.find(c => typeof c[0] === 'string' && (c[0] as string).includes('invalidated_at'));
    expect(sessionCall).toBeDefined();
    // Verify password_history was included in UPDATE
    const updateCall = calls.find(c => typeof c[0] === 'string' && (c[0] as string).includes('password_history'));
    expect(updateCall).toBeDefined();
  });

  it('records admin_user_reset_password audit log', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const pool = makePool();
    wireTxClient(pool, { rows: [USER_HASH_ROW] }, { rows: [] }, { rows: [] });
    await request(makeApp(pool))
      .post('/api/admin/users/user-2/reset-password')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ password: VALID_PASSWORD });
    expect(writeAuditLog).toHaveBeenCalledWith(pool, expect.objectContaining({
      action: 'admin_user_reset_password', outcome: 'success',
    }));
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/disable  &  /enable
// ---------------------------------------------------------------------------
describe('POST /api/admin/users/:id/disable', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when trying to disable own account', async () => {
    const pool = makePool();
    wireQueries(pool); // auth only
    // Token sub is 'admin-1', so request to disable 'admin-1' is self-disable
    const res = await request(makeApp(pool))
      .post('/api/admin/users/admin-1/disable')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('returns 404 when user not found', async () => {
    const pool = makePool();
    wireQueries(pool, [], []); // UPDATE → empty, SELECT → empty
    const res = await request(makeApp(pool))
      .post('/api/admin/users/missing/disable')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('returns 409 when user already disabled', async () => {
    const pool = makePool();
    wireQueries(pool,
      [],                      // UPDATE: user already has disabled_at set
      [{ id: 'user-2' }]      // SELECT: user exists
    );
    const res = await request(makeApp(pool))
      .post('/api/admin/users/user-2/disable')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USER_ALREADY_DISABLED');
  });

  it('disables user and writes audit log', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const pool = makePool();
    wireQueries(pool, [{ id: 'user-2' }]); // UPDATE RETURNING
    const res = await request(makeApp(pool))
      .post('/api/admin/users/user-2/disable')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledWith(pool, expect.objectContaining({
      action: 'admin_user_disable', targetId: 'user-2', outcome: 'success',
    }));
  });
});

describe('POST /api/admin/users/:id/enable', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 409 when user already enabled (disabled_at IS NULL)', async () => {
    const pool = makePool();
    wireQueries(pool,
      [],                      // UPDATE: no rows (already enabled)
      [{ id: 'user-2' }]      // SELECT: user exists
    );
    const res = await request(makeApp(pool))
      .post('/api/admin/users/user-2/enable')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USER_ALREADY_ENABLED');
  });

  it('enables user and writes audit log', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const pool = makePool();
    wireQueries(pool, [{ id: 'user-2' }]);
    const res = await request(makeApp(pool))
      .post('/api/admin/users/user-2/enable')
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledWith(pool, expect.objectContaining({
      action: 'admin_user_enable', targetId: 'user-2', outcome: 'success',
    }));
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/workspaces/:id/purge
// ---------------------------------------------------------------------------
describe('DELETE /api/admin/workspaces/:id/purge', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const WS_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  it('returns 403 for non-admin', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .delete(`/api/admin/workspaces/${WS_ID}/purge`)
      .set('Authorization', `Bearer ${token('doctor')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] });               // DELETE RETURNING (no rows)
    const res = await request(makeApp(pool))
      .delete(`/api/admin/workspaces/${WS_ID}/purge`)
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 204 and writes audit log on successful purge', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [{ id: WS_ID }] }); // DELETE RETURNING

    const res = await request(makeApp(pool))
      .delete(`/api/admin/workspaces/${WS_ID}/purge`)
      .set('Authorization', `Bearer ${token('admin')}`)
      .set('x-csrf-token', CSRF_TOKEN);

    expect(res.status).toBe(204);
    expect(writeAuditLog).toHaveBeenCalledWith(pool, expect.objectContaining({
      action:     'admin_workspace_purge',
      targetType: 'workspace',
      targetId:   WS_ID,
      outcome:    'success',
    }));
  });
});

import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

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

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin', createAdminRouter(pool));
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

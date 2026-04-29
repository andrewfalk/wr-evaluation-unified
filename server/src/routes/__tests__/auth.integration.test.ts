/**
 * Integration tests for /api/auth routes using supertest + in-process app.
 * DB interactions are mocked so no real Postgres connection is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// ------------------------------------------------------------------
// Mock heavy deps before importing the router under test
// ------------------------------------------------------------------
vi.mock('../../auth/LocalDbAuthProvider', () => ({
  LocalDbAuthProvider: vi.fn(),
}));
vi.mock('../../auth/sessionStore', () => ({
  createSession:       vi.fn(),
  verifySession:       vi.fn(),
  rotateSession:       vi.fn(),
  revokeSession:       vi.fn(),
  hashToken:           vi.fn((t: string) => `hash:${t}`),
}));
vi.mock('../../auth/csrf', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../auth/csrf')>();
  return {
    ...real,
    setCsrfCookie:    vi.fn(),
    clearCsrfCookie:  vi.fn(),
    reissueCsrfToken: vi.fn(),
    validateCsrf:     vi.fn(() => true),   // default: CSRF passes
  };
});
vi.mock('../../config', () => ({
  default: {
    env: 'test',
    auth: {
      refreshTokenTtl:    604800,
      accessTokenTtl:     900,
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
    ai:                  { enabled: false },
    localFallbackAllowed: false,
  },
}));

import { LocalDbAuthProvider } from '../../auth/LocalDbAuthProvider';
import {
  createSession,
  verifySession,
  rotateSession,
  revokeSession,
} from '../../auth/sessionStore';
import { validateCsrf } from '../../auth/csrf';
import { createAuthRouter } from '../auth';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool, PoolClient } from 'pg';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const SESSION_ROW = {
  sessionId:     'sess-1',
  csrfTokenHash: 'hash:csrf-tok',
  userId:        'user-1',
  expiresAt:     new Date(Date.now() + 3_600_000),
};

function makePool(overrides: Partial<Pool> = {}): Pool {
  const release = vi.fn();
  const client  = { query: vi.fn(), release } as unknown as PoolClient;
  return {
    connect: vi.fn().mockResolvedValue(client),
    query:   vi.fn(),
    ...overrides,
  } as unknown as Pool;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter(pool));
  return app;
}

function validToken(extra?: object): string {
  const { token } = generateAccessToken({
    sub:                'user-1',
    sessionId:          'sess-1',
    orgId:              'org-1',
    role:               'doctor',
    name:               'Dr. Kim',
    mustChangePassword: false,
    csrfHash:           'hash:csrf-tok',
    ...extra,
  });
  return token;
}

// ------------------------------------------------------------------
// POST /api/auth/login
// ------------------------------------------------------------------
describe('POST /api/auth/login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when body is missing required fields', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool)).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 401 for invalid credentials', async () => {
    const pool = makePool();
    vi.mocked(LocalDbAuthProvider).mockImplementation(() => ({
      verifyCredentials: vi.fn().mockResolvedValue(null),
    }) as never);

    const res = await request(makeApp(pool))
      .post('/api/auth/login')
      .send({ loginId: 'bad', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 200 with accessToken and sets refresh cookie on success', async () => {
    const pool = makePool();
    vi.mocked(LocalDbAuthProvider).mockImplementation(() => ({
      verifyCredentials: vi.fn().mockResolvedValue({
        userId:             'user-1',
        organizationId:     'org-1',
        role:               'doctor',
        name:               'Dr. Kim',
        mustChangePassword: false,
      }),
    }) as never);
    vi.mocked(createSession).mockResolvedValue({
      sessionId:    'sess-1',
      refreshToken: 'raw-refresh',
      csrfToken:    'raw-csrf',
      expiresAt:    new Date(Date.now() + 3_600_000),
    } as never);

    const client = (await pool.connect()) as unknown as { query: ReturnType<typeof vi.fn> };
    client.query.mockResolvedValue({ rows: [] });

    const res = await request(makeApp(pool))
      .post('/api/auth/login')
      .send({ loginId: 'doc1', password: 'pass123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body.user).toMatchObject({ id: 'user-1', role: 'doctor' });
    const cookie = res.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(cookie) ? cookie.join(';') : String(cookie ?? '');
    expect(cookieStr).toContain('wr_refresh');
  });
});

// ------------------------------------------------------------------
// POST /api/auth/refresh
// ------------------------------------------------------------------
describe('POST /api/auth/refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when refresh cookie is absent', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool)).post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_REFRESH_TOKEN');
  });

  it('returns 401 when session is invalid', async () => {
    const pool = makePool();
    vi.mocked(verifySession).mockResolvedValue(null);

    const res = await request(makeApp(pool))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=bad-token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_INVALID');
  });

  it('returns 403 when CSRF is invalid', async () => {
    const pool = makePool();
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(false);

    const res = await request(makeApp(pool))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'bad-csrf');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
  });

  it('returns 401 when rotation returns null (already rotated)', async () => {
    const pool = makePool();
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(true);
    vi.mocked(rotateSession).mockResolvedValue(null);

    const res = await request(makeApp(pool))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_ALREADY_ROTATED');
  });

  it('returns 200 with new accessToken on valid refresh', async () => {
    const pool   = makePool();
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(true);
    vi.mocked(rotateSession).mockResolvedValue({
      sessionId:    'sess-2',
      refreshToken: 'new-refresh',
      csrfToken:    'new-csrf',
      expiresAt:    new Date(Date.now() + 3_600_000),
    } as never);

    // pool.connect().query for user lookup
    const client = (await pool.connect()) as unknown as { query: ReturnType<typeof vi.fn> };
    client.query.mockResolvedValue({
      rows: [{
        user_id: 'user-1', role: 'doctor', name: 'Dr. Kim',
        organization_id: 'org-1', must_change_password: false,
      }],
    });

    const res = await request(makeApp(pool))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
  });
});

// ------------------------------------------------------------------
// GET /api/auth/me  (requires valid JWT + live DB session)
// ------------------------------------------------------------------
describe('GET /api/auth/me', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when no Authorization header', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool)).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 when DB session is revoked (SESSION_REVOKED)', async () => {
    const token = validToken();
    // pool.query returns empty → session revoked
    const pool  = { ...makePool(), query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;

    const res = await request(makeApp(pool))
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
  });

  it('returns 200 with user info when JWT + session are valid', async () => {
    const token = validToken();
    // pool.query for auth middleware returns a live session row
    const innerPool = makePool();
    vi.mocked(innerPool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    // pool.connect().query for org lookup
    const client = (await innerPool.connect()) as unknown as { query: ReturnType<typeof vi.fn> };
    client.query.mockResolvedValue({ rows: [{ id: 'org-1', name: 'Seoul Hospital' }] });

    const res = await request(makeApp(innerPool))
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'user-1', role: 'doctor' });
  });
});

// ------------------------------------------------------------------
// POST /api/auth/logout — after logout, /me must be blocked
// ------------------------------------------------------------------
describe('POST /api/auth/logout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool)).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });

  it('returns 200 and revokes session when authenticated', async () => {
    const token     = validToken();
    const innerPool = makePool();
    vi.mocked(innerPool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    vi.mocked(revokeSession).mockResolvedValue(undefined);

    const client = (await innerPool.connect()) as unknown as { query: ReturnType<typeof vi.fn> };
    client.query.mockResolvedValue({ rows: [] });

    const res = await request(makeApp(innerPool))
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(revokeSession).toHaveBeenCalled();
  });

  it('blocks /me after session is revoked in DB', async () => {
    const token = validToken();
    // First call (auth middleware check) → revoked (empty rows)
    const innerPool = makePool();
    vi.mocked(innerPool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const meRes = await request(makeApp(innerPool))
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(401);
    expect(meRes.body.code).toBe('SESSION_REVOKED');
  });
});

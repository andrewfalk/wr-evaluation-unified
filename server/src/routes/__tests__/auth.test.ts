import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the hoisted imports.
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

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:       vi.fn(),
  auditLogin:          vi.fn(),
  auditLogout:         vi.fn(),
  auditRefreshFail:    vi.fn(),
  auditRefreshSuccess: vi.fn(),
}));

// Bypass rate limiters so multiple test requests don't trip the in-memory bucket.
vi.mock('../../middleware/rateLimit', () => ({
  loginRateLimit:              () => (_: unknown, __: unknown, next: () => void) => next(),
  csrfRateLimit:               () => (_: unknown, __: unknown, next: () => void) => next(),
  signupRateLimit:             () => (_: unknown, __: unknown, next: () => void) => next(),
  deviceRegisterIpRateLimit:   () => (_: unknown, __: unknown, next: () => void) => next(),
  deviceRegisterUserRateLimit: () => (_: unknown, __: unknown, next: () => void) => next(),
}));

vi.mock('../../auth/LocalDbAuthProvider', () => ({
  LocalDbAuthProvider: vi.fn().mockImplementation(() => ({ verifyCredentials: vi.fn() })),
}));

vi.mock('../../auth/sessionStore', () => ({
  createSession: vi.fn(),
  verifySession: vi.fn().mockResolvedValue(null),
  rotateSession: vi.fn(),
  revokeSession: vi.fn(),
  hashToken:     vi.fn().mockReturnValue('hashed'),
}));

vi.mock('../../auth/tokens', () => ({
  generateAccessToken: vi.fn().mockReturnValue({ token: 'tok', expiresAt: new Date() }),
}));

vi.mock('../../auth/csrf', () => ({
  setCsrfCookie:    vi.fn(),
  clearCsrfCookie:  vi.fn(),
  reissueCsrfToken: vi.fn(),
  CSRF_HEADER:      'x-csrf-token',
  validateCsrf:     vi.fn().mockReturnValue(true),
}));

vi.mock('../../middleware/csrf', () => ({
  csrfMiddleware: (_: unknown, __: unknown, next: () => void) => next(),
}));

import { createAuthRouter } from '../auth';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter(pool));
  return app;
}

const VALID_REQUEST = {
  loginId:       'new.doctor',
  name:          '김의사',
  requestedRole: 'doctor',
};

// ---------------------------------------------------------------------------
// POST /api/auth/signup-requests
// ---------------------------------------------------------------------------
describe('POST /api/auth/signup-requests', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 for invalid body (loginId too short, missing name)', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool))
      .post('/api/auth/signup-requests')
      .send({ loginId: 'x', requestedRole: 'doctor' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 for invalid loginId characters', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool))
      .post('/api/auth/signup-requests')
      .send({ loginId: 'has space', name: '홍길동', requestedRole: 'doctor' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when requestedRole is admin (admin not allowed)', async () => {
    const pool = makePool();
    const res  = await request(makeApp(pool))
      .post('/api/auth/signup-requests')
      .send({ loginId: 'newuser', name: '홍길동', requestedRole: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 409 LOGIN_ID_TAKEN when a user with this loginId already exists', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ id: 'existing-user-1' }] }); // users check

    const res = await request(makeApp(pool))
      .post('/api/auth/signup-requests')
      .send(VALID_REQUEST);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOGIN_ID_TAKEN');
  });

  it('returns 409 ALREADY_REQUESTED when a pending request for this loginId exists', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] }); // users check: no existing user
    const pgError = Object.assign(new Error('duplicate'), { code: '23505' });
    (pool.query as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(pgError); // INSERT INTO user_signup_requests violates unique index

    const res = await request(makeApp(pool))
      .post('/api/auth/signup-requests')
      .send(VALID_REQUEST);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REQUESTED');
  });

  it('returns 201 and writes signup_request_create audit log on success', async () => {
    const { writeAuditLog } = await import('../../middleware/audit');
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] })                    // users check: no existing user
      .mockResolvedValueOnce({ rows: [{ id: 'req-new-1' }] }); // INSERT RETURNING

    const res = await request(makeApp(pool))
      .post('/api/auth/signup-requests')
      .send(VALID_REQUEST);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('req-new-1');
    expect(writeAuditLog).toHaveBeenCalledWith(pool, expect.objectContaining({
      actorUserId: null,
      action:      'signup_request_create',
      targetType:  'signup_request',
      targetId:    'req-new-1',
      outcome:     'success',
    }));
  });

  it('includes optional note field in the insert', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [] })                    // users check
        .mockResolvedValueOnce({ rows: [{ id: 'req-2' }] });   // INSERT

    const res = await request(makeApp(pool))
      .post('/api/auth/signup-requests')
      .send({ ...VALID_REQUEST, note: '신경외과 협진 담당' });

    expect(res.status).toBe(201);
    // Verify the note was passed to the INSERT query (4th parameter).
    const insertCall = mock.mock.calls[1];
    expect(insertCall[1][3]).toBe('신경외과 협진 담당');
  });
});

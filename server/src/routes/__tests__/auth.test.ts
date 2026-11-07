import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the hoisted imports.
// ---------------------------------------------------------------------------
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig(),
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
  refreshRateLimit:            () => (_: unknown, __: unknown, next: () => void) => next(),
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
import { createFakePool, pgError, type FakePool, type FakeQueryReply } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// 공개 경로(인증 없음)라 세션 확인 쿼리가 없다 — SQL로 고르는 handler 두 개(기존 사용자 확인, INSERT)만 둔다.
// 준비하지 않은 쿼리는 미매치로 거부되므로 오류 테스트는 assertNoUnmatched()로 의도한 실패인지 확인한다.
function makeFake(
  opts: { existing?: FakeQueryReply; insert?: FakeQueryReply | Error } = {},
): FakePool {
  return createFakePool({
    handlers: [
      ...(opts.existing
        ? [{ name: 'users.byLoginId', match: /SELECT id FROM users WHERE login_id = \$1/, reply: opts.existing }]
        : []),
      ...(opts.insert
        ? [{ name: 'signup.insert', match: /INSERT INTO user_signup_requests/, reply: opts.insert }]
        : []),
    ],
  });
}

function authApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/auth', createAuthRouter(fake.pool)));
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
    const fake = makeFake();
    const res  = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send({ loginId: 'x', requestedRole: 'doctor' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(fake.calls).toHaveLength(0); // zod 검증에서 끝남 — DB 호출 없음
  });

  it('returns 400 for invalid loginId characters', async () => {
    const fake = makeFake();
    const res  = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send({ loginId: 'has space', name: '홍길동', requestedRole: 'doctor' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 400 when requestedRole is admin (admin not allowed)', async () => {
    const fake = makeFake();
    const res  = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send({ loginId: 'newuser', name: '홍길동', requestedRole: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 409 LOGIN_ID_TAKEN when a user with this loginId already exists', async () => {
    const fake = makeFake({ existing: { rows: [{ id: 'existing-user-1' }] } }); // users check

    const res = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send(VALID_REQUEST);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOGIN_ID_TAKEN');
    fake.assertNoUnmatched();
  });

  it('returns 409 ALREADY_REQUESTED when a pending request for this loginId exists', async () => {
    const fake = makeFake({
      existing: { rows: [] },                    // users check: no existing user
      insert:   pgError('23505', 'duplicate'),   // INSERT INTO user_signup_requests violates unique index
    });

    const res = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send(VALID_REQUEST);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REQUESTED');
    fake.assertNoUnmatched();
    expect(fake.callsTo('signup.insert')).toHaveLength(1);
  });

  it('answers any other DB failure with the 500 envelope (central error handler, S1)', async () => {
    const fake = makeFake({
      existing: { rows: [] }, // users check
      insert:   Object.assign(new Error('connection reset'), { code: '08006', severity: 'FATAL' }),
    });

    const res = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send(VALID_REQUEST);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
    // 500은 준비한 INSERT 오류에서 나와야 한다(미매치 쿼리 거부가 아니라).
    fake.assertNoUnmatched();
    expect(fake.callsTo('signup.insert')).toHaveLength(1);
  });

  it('returns 201 and writes signup_request_create audit log on success', async () => {
    const { writeAuditLog } = await import('../../middleware/audit.js');
    const fake = makeFake({
      existing: { rows: [] },                    // users check: no existing user
      insert:   { rows: [{ id: 'req-new-1' }] }, // INSERT RETURNING
    });

    const res = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send(VALID_REQUEST);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('req-new-1');
    expect(writeAuditLog).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      actorUserId: null,
      action:      'signup_request_create',
      targetType:  'signup_request',
      targetId:    'req-new-1',
      outcome:     'success',
    }));
    fake.assertNoUnmatched();
  });

  it('includes optional note field in the insert', async () => {
    const fake = makeFake({
      existing: { rows: [] },                // users check
      insert:   { rows: [{ id: 'req-2' }] }, // INSERT
    });

    const res = await request(authApp(fake))
      .post('/api/auth/signup-requests')
      .send({ ...VALID_REQUEST, note: '신경외과 협진 담당' });

    expect(res.status).toBe(201);
    // Verify the note was passed to the INSERT query (4th parameter).
    const insertCall = fake.calls[1]!;
    expect(insertCall.handler).toBe('signup.insert');
    expect(insertCall.params[3]).toBe('신경외과 협진 담당');
  });
});

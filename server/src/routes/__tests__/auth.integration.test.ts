/**
 * Integration tests for /api/auth routes using supertest + in-process app.
 * DB interactions are mocked so no real Postgres connection is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

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
  revokeSessionFamily: vi.fn(),
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
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig({
    auth:                 { refreshTokenTtl: 604800 },
    ai:                   { enabled: false },
    localFallbackAllowed: false,
  }),
}));

import { LocalDbAuthProvider } from '../../auth/LocalDbAuthProvider';
import {
  createSession,
  verifySession,
  rotateSession,
  revokeSessionFamily,
} from '../../auth/sessionStore';
import { validateCsrf } from '../../auth/csrf';
import { createAuthRouter } from '../auth';
import { loginIdHash } from '../../auth/loginBackoff';
import { generateAccessToken } from '../../auth/tokens';
import {
  createFakePool,
  authSessionHandler,
  type FakePool,
  type QueryHandler,
} from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const SESSION_ROW = {
  sessionId:     'sess-1',
  csrfTokenHash: 'hash:csrf-tok',
  userId:        'user-1',
  expiresAt:     new Date(Date.now() + 3_600_000),
  familyId:      'fam-1',
};

// middleware/audit을 mock 하지 않으므로 auditLogin·auditLogout·auditRefresh*가 pool.query로
// INSERT INTO audit_logs를 실제로 보낸다(기존 vi.fn() pool.query는 undefined를 돌려 조용히 통과).
// 모든 가짜 Pool에 이 handler를 깔아 두고, 그 밖의 쿼리는 테스트마다 SQL로 고른 handler만 준다 —
// 준비하지 않은 쿼리는 미매치로 거부되므로 각 테스트 끝에 assertNoUnmatched()로 확인한다.
function makeFake(handlers: QueryHandler[] = []): FakePool {
  return createFakePool({
    handlers: [
      { name: 'audit', match: /INSERT INTO audit_logs/, via: 'pool', reply: { rowCount: 1 } },
      ...handlers,
    ],
  });
}

function authApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/auth', createAuthRouter(fake.pool)));
}

// login의 마지막 로그인 시각 갱신(트랜잭션 client).
const lastLoginHandler: QueryHandler = {
  name: 'users.lastLogin', match: /UPDATE users SET last_login_at = now\(\) WHERE id = \$1/, via: 'client', reply: { rowCount: 1 },
};

// SEC-B M2 계정별 잠금: 비밀번호 확인 전에 시도를 센다(pool INSERT … ON CONFLICT). 잠겨 있으면 INSERT가
// 0행 → 남은 시간 조회(pool). 성공 시 행 삭제는 로그인 트랜잭션 client.
function backoffClaimHandler(locked = false): QueryHandler {
  return {
    name:  'backoff.claim',
    match: /INSERT INTO login_backoff AS b/,
    via:   'pool',
    reply: locked ? { rows: [], rowCount: 0 } : { rows: [{ failures: 1, locked_until: null }], rowCount: 1 },
  };
}
function backoffRetryAfterHandler(retryAfterSec: number): QueryHandler {
  return {
    name:  'backoff.retryAfter',
    match: /FROM login_backoff\s+WHERE login_hash = \$1 AND locked_until > now\(\)/,
    via:   'pool',
    reply: { rows: [{ retry_after: retryAfterSec }] },
  };
}
const backoffClearHandler: QueryHandler = {
  name: 'backoff.clear', match: /DELETE FROM login_backoff WHERE login_hash = \$1/, via: 'client', reply: { rowCount: 1 },
};

function auditExtras(fake: FakePool): unknown[] {
  return fake.callsTo('audit').map(c => (c.params[8] === null ? null : JSON.parse(String(c.params[8]))));
}

// refresh의 회전 전 사용자 조회(별도 client).
function userLookupHandler(row: Record<string, unknown>): QueryHandler {
  return {
    name:  'users.byId',
    match: /SELECT id AS user_id, role, name, organization_id, must_change_password, disabled_at\s+FROM users WHERE id = \$1/,
    via:   'client',
    reply: { rows: [row] },
  };
}

// 토큰 클레임(sub 'user-1', csrfHash 'hash:csrf-tok')이 testing/tokens의 기본값(UUID·sha256)과 달라
// makeAccessToken으로 바꾸지 않고 로컬 도우미를 그대로 둔다.
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
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when body is missing required fields', async () => {
    const fake = makeFake();
    const res  = await request(authApp(fake)).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    fake.assertNoUnmatched();
    expect(LocalDbAuthProvider).not.toHaveBeenCalled();
    expect(fake.connected).toBe(0);
  });

  it('returns 401 for invalid credentials', async () => {
    const fake = makeFake([backoffClaimHandler()]);
    const verifyCredentials = vi.fn().mockResolvedValue(null);
    vi.mocked(LocalDbAuthProvider).mockImplementation(() => ({
      verifyCredentials,
    }) as never);

    const res = await request(authApp(fake))
      .post('/api/auth/login')
      .send({ loginId: 'bad', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    fake.assertNoUnmatched();
    expect(verifyCredentials).toHaveBeenCalledWith('bad', 'wrong');
    expect(fake.connected).toBe(0);
    // The failure is counted under the hashed login ID, and the audit row carries only its prefix.
    const key = loginIdHash('bad');
    expect(fake.callsTo('backoff.claim')).toHaveLength(1);
    expect(fake.callsTo('backoff.claim')[0].params[0]).toBe(key);
    expect(auditExtras(fake)).toEqual([{ loginIdHash: key.slice(0, 16) }]);
    expect(JSON.stringify(fake.calls.map(c => c.params))).not.toContain('"bad"');
  });

  it('returns 429 LOGIN_LOCKED without checking the password while the login ID is locked', async () => {
    const fake = makeFake([backoffClaimHandler(true), backoffRetryAfterHandler(37)]);
    const verifyCredentials = vi.fn();
    vi.mocked(LocalDbAuthProvider).mockImplementation(() => ({ verifyCredentials }) as never);

    const res = await request(authApp(fake))
      .post('/api/auth/login')
      .send({ loginId: 'doc1', password: 'pass123' });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('37');
    expect(res.body).toEqual({
      code:          'LOGIN_LOCKED',
      error:         'Too many failed login attempts for this login ID, please try again later',
      retryAfterSec: 37,
    });
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(fake.callsTo('backoff.claim')).toHaveLength(1); // the claim was refused (0 rows) — not counted
    expect(fake.callsTo('backoff.retryAfter')).toHaveLength(1);
    expect(fake.connected).toBe(0);
    expect(auditExtras(fake)).toEqual([{ loginIdHash: loginIdHash('doc1').slice(0, 16), reason: 'locked' }]);
    fake.assertNoUnmatched();
  });

  it('returns 200 with accessToken and sets refresh cookie on success', async () => {
    const fake = makeFake([lastLoginHandler, backoffClaimHandler(), backoffClearHandler]);
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
      sessionId:        'sess-1',
      refreshToken:     'raw-refresh',
      csrfToken:        'raw-csrf',
      expiresAt:        new Date(Date.now() + 3_600_000),
      persistentCookie: true,
    } as never);

    const res = await request(authApp(fake))
      .post('/api/auth/login')
      .send({ loginId: 'doc1', password: 'pass123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body.user).toMatchObject({ id: 'user-1', role: 'doctor' });
    const cookie = res.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(cookie) ? cookie.join(';') : String(cookie ?? '');
    expect(cookieStr).toContain('wr_refresh');
    // rememberMe omitted → defaults to true → persistent cookie with Expires.
    expect(cookieStr).toContain('Expires=');
    expect(vi.mocked(createSession).mock.calls[0][4]).toBe(true);
    fake.assertNoUnmatched();
    expect(fake.callsTo('users.lastLogin')).toHaveLength(1);
    expect(fake.transactions.map(t => t.outcome)).toEqual(['commit']);
    // The failure count is cleared inside the login transaction (before COMMIT).
    const clear = fake.callsTo('backoff.clear');
    expect(clear).toHaveLength(1);
    expect(clear[0].params).toEqual([loginIdHash('doc1')]);
    const order = fake.calls.filter(c => c.clientId === clear[0].clientId).map(c => c.handler === 'transaction-control' ? c.sql.trim().split(/\s+/)[0].toUpperCase() : c.handler);
    expect(order.indexOf('backoff.clear')).toBeLessThan(order.indexOf('COMMIT'));
    expect(auditExtras(fake)).toEqual([null]);
    fake.assertAllReleased();
  });

  it('issues a session cookie (no Expires) when rememberMe is false', async () => {
    const fake = makeFake([lastLoginHandler, backoffClaimHandler(), backoffClearHandler]);
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
      sessionId:        'sess-1',
      refreshToken:     'raw-refresh',
      csrfToken:        'raw-csrf',
      expiresAt:        new Date(Date.now() + 3_600_000),
      persistentCookie: false,
    } as never);

    const res = await request(authApp(fake))
      .post('/api/auth/login')
      .send({ loginId: 'doc1', password: 'pass123', rememberMe: false });

    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(cookie) ? cookie.join(';') : String(cookie ?? '');
    expect(cookieStr).toContain('wr_refresh');
    expect(cookieStr).not.toContain('Expires=');
    // rememberMe=false is forwarded to createSession as the persistentCookie arg.
    expect(vi.mocked(createSession).mock.calls[0][4]).toBe(false);
    fake.assertNoUnmatched();
    expect(fake.transactions.map(t => t.outcome)).toEqual(['commit']);
    fake.assertAllReleased();
  });
});

// ------------------------------------------------------------------
// POST /api/auth/refresh
// ------------------------------------------------------------------
describe('POST /api/auth/refresh', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('is rate limited per IP: the 61st refresh within a minute gets 429 (SEC-A L3)', async () => {
    const app = authApp(makeFake());
    for (let i = 0; i < 60; i += 1) {
      expect((await request(app).post('/api/auth/refresh')).status).toBe(401); // NO_REFRESH_TOKEN, counted
    }
    const limited = await request(app).post('/api/auth/refresh');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ code: 'RATE_LIMITED', error: 'Too many token refresh requests, please try again later' });
  });

  it('returns 401 when refresh cookie is absent', async () => {
    const fake = makeFake();
    const res  = await request(authApp(fake)).post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_REFRESH_TOKEN');
    fake.assertNoUnmatched();
    expect(verifySession).not.toHaveBeenCalled();
  });

  it('returns 401 when session is invalid', async () => {
    const fake = makeFake();
    vi.mocked(verifySession).mockResolvedValue(null);

    const res = await request(authApp(fake))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=bad-token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_INVALID');
    fake.assertNoUnmatched();
    expect(verifySession).toHaveBeenCalledWith(expect.anything(), 'bad-token');
    fake.assertAllReleased();
  });

  it('returns 403 when CSRF is invalid', async () => {
    const fake = makeFake();
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(false);

    const res = await request(authApp(fake))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'bad-csrf');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
    fake.assertNoUnmatched();
    expect(validateCsrf).toHaveBeenCalledWith('bad-csrf', SESSION_ROW.csrfTokenHash);
    fake.assertAllReleased();
  });

  it('returns 401 when rotation returns null (already rotated)', async () => {
    const fake = makeFake([userLookupHandler({
      user_id: 'user-1', role: 'doctor', name: 'Dr. Kim',
      organization_id: 'org-1', must_change_password: false, disabled_at: null,
    })]);
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(true);
    vi.mocked(rotateSession).mockResolvedValue(null);

    const res = await request(authApp(fake))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_ALREADY_ROTATED');
    fake.assertNoUnmatched();
    expect(fake.callsTo('users.byId')).toHaveLength(1);
    expect(rotateSession).toHaveBeenCalledTimes(1);
    fake.assertAllReleased();
  });

  it('returns 200 with new accessToken and current user on valid refresh', async () => {
    // client query for the user lookup
    const fake = makeFake([userLookupHandler({
      user_id: 'user-1', role: 'doctor', name: 'Dr. Kim',
      organization_id: 'org-1', must_change_password: false, disabled_at: null,
    })]);
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(true);
    vi.mocked(rotateSession).mockResolvedValue({
      sessionId:        'sess-2',
      refreshToken:     'new-refresh',
      csrfToken:        'new-csrf',
      expiresAt:        new Date(Date.now() + 3_600_000),
      persistentCookie: true,
    } as never);

    const res = await request(authApp(fake))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body.user).toMatchObject({
      id:                 'user-1',
      role:               'doctor',
      organizationId:     'org-1',
      mustChangePassword: false,
    });
    fake.assertNoUnmatched();
    fake.assertAllReleased();
  });

  it('keeps a session cookie (no Expires) on refresh when the session policy is non-persistent', async () => {
    const fake = makeFake([userLookupHandler({
      user_id: 'user-1', role: 'doctor', name: 'Dr. Kim',
      organization_id: 'org-1', must_change_password: false, disabled_at: null,
    })]);
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(true);
    vi.mocked(rotateSession).mockResolvedValue({
      sessionId:        'sess-2',
      refreshToken:     'new-refresh',
      csrfToken:        'new-csrf',
      expiresAt:        new Date(Date.now() + 3_600_000),
      persistentCookie: false,
    } as never);

    const res = await request(authApp(fake))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(cookie) ? cookie.join(';') : String(cookie ?? '');
    expect(cookieStr).toContain('wr_refresh');
    expect(cookieStr).not.toContain('Expires=');
    fake.assertNoUnmatched();
    fake.assertAllReleased();
  });

  it('returns 401 and does not rotate when the user account is disabled', async () => {
    const fake = makeFake([userLookupHandler({
      user_id: 'user-1', role: 'doctor', name: 'Dr. Kim',
      organization_id: 'org-1', must_change_password: false,
      disabled_at: '2026-01-01T00:00:00Z',
    })]);
    vi.mocked(verifySession).mockResolvedValue(SESSION_ROW as never);
    vi.mocked(validateCsrf).mockReturnValue(true);

    const res = await request(authApp(fake))
      .post('/api/auth/refresh')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'ok');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('USER_DISABLED');
    expect(rotateSession).not.toHaveBeenCalled();
    fake.assertNoUnmatched();
    expect(fake.callsTo('users.byId')).toHaveLength(1);
    fake.assertAllReleased();
  });
});

// ------------------------------------------------------------------
// GET /api/auth/me  (requires valid JWT + live DB session)
// ------------------------------------------------------------------
describe('GET /api/auth/me', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when no Authorization header', async () => {
    const fake = makeFake();
    const res  = await request(authApp(fake)).get('/api/auth/me');
    expect(res.status).toBe(401);
    fake.assertNoUnmatched();
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 401 when DB session is revoked (SESSION_REVOKED)', async () => {
    const token = validToken();
    // session check returns no rows → session revoked
    const fake  = makeFake([authSessionHandler({ revoked: true })]);

    const res = await request(authApp(fake))
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
    fake.assertNoUnmatched();
    expect(fake.callsTo('auth.session')).toHaveLength(1);
    expect(fake.connected).toBe(0);
  });

  it('returns 200 with user info when JWT + session are valid', async () => {
    const token = validToken();
    const fake = makeFake([
      // auth middleware session check returns a live session row
      authSessionHandler(),
      // client query for org lookup
      {
        name:  'organizations.byId',
        match: /SELECT id, name FROM organizations WHERE id = \$1/,
        via:   'client',
        reply: { rows: [{ id: 'org-1', name: 'Seoul Hospital' }] },
      },
    ]);

    const res = await request(authApp(fake))
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'user-1', role: 'doctor' });
    fake.assertNoUnmatched();
    fake.assertAllReleased();
  });
});

// ------------------------------------------------------------------
// POST /api/auth/logout — after logout, /me must be blocked
// ------------------------------------------------------------------
// logout authenticates via the wr_refresh cookie + manual CSRF check (like /refresh),
// NOT the Bearer access token — it must work even with an expired/absent access token.
describe('POST /api/auth/logout', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('is idempotent (200) when no refresh cookie is present — nothing to revoke', async () => {
    const fake = makeFake();
    const res  = await request(authApp(fake)).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(revokeSessionFamily).not.toHaveBeenCalled();
    fake.assertNoUnmatched();
  });

  it('is idempotent (200) when the refresh cookie is invalid/expired — nothing to revoke', async () => {
    const fake = makeFake();
    vi.mocked(revokeSessionFamily).mockResolvedValue({ status: 'not_found' });

    const res = await request(authApp(fake))
      .post('/api/auth/logout')
      .set('Cookie', 'wr_refresh=stale-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    fake.assertNoUnmatched();
    expect(revokeSessionFamily).toHaveBeenCalledTimes(1);
    expect(fake.connected).toBe(0);
  });

  it('returns 403 when CSRF is invalid — does not revoke', async () => {
    // CSRF is now validated inside revokeSessionFamily itself (same transaction
    // as the revoke), not as a separate route-level pre-check — see auth.ts.
    const fake = makeFake();
    vi.mocked(revokeSessionFamily).mockResolvedValue({ status: 'csrf_invalid' });

    const res = await request(authApp(fake))
      .post('/api/auth/logout')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'bad-csrf');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
    fake.assertNoUnmatched();
    expect(revokeSessionFamily).toHaveBeenCalledWith(expect.anything(), 'valid-token', 'bad-csrf');
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 200 and revokes the session family when the refresh cookie + CSRF are valid — no access token needed', async () => {
    const fake = makeFake([{
      name:  'users.orgById',
      match: /SELECT organization_id FROM users WHERE id = \$1/,
      via:   'client',
      reply: { rows: [{ organization_id: 'org-1' }] },
    }]);
    vi.mocked(revokeSessionFamily).mockResolvedValue({
      status:    'revoked',
      sessionId: SESSION_ROW.sessionId,
      userId:    SESSION_ROW.userId,
      familyId:  SESSION_ROW.familyId,
    });

    const res = await request(authApp(fake))
      .post('/api/auth/logout')
      .set('Cookie', 'wr_refresh=valid-token')
      .set('x-csrf-token', 'ok');
      // Deliberately no Authorization header — logout must not require one.

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(revokeSessionFamily).toHaveBeenCalledWith(expect.anything(), 'valid-token', 'ok');
    fake.assertNoUnmatched();
    expect(fake.callsTo('users.orgById')).toHaveLength(1);
    fake.assertAllReleased();
  });

  it('blocks /me after session is revoked in DB', async () => {
    const token = validToken();
    // auth middleware session check → revoked (empty rows)
    const fake = makeFake([authSessionHandler({ revoked: true })]);

    const meRes = await request(authApp(fake))
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(401);
    expect(meRes.body.code).toBe('SESSION_REVOKED');
    fake.assertNoUnmatched();
    expect(fake.callsTo('auth.session')).toHaveLength(1);
  });
});

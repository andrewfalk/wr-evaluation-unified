/**
 * Tests for POST /api/auth/change-password
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig({
    ai:                   { enabled: false },
    localFallbackAllowed: false,
  }),
}));
vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn() }));

// Mock bcrypt so tests run fast (no real hashing)
vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn(),
    hash:    vi.fn().mockResolvedValue('$newhash$'),
  },
}));

// Mock passwordPolicy so we control validation without real regex/bcrypt calls
vi.mock('../../auth/passwordPolicy', () => ({
  checkPasswordPolicy:   vi.fn(() => ({ ok: true, error: null })),
  isPasswordReused:      vi.fn().mockResolvedValue(false),
  appendPasswordHistory: vi.fn((hist: string[], h: string) => [...hist, h].slice(-5)),
}));

import bcrypt from 'bcrypt';
import { checkPasswordPolicy, isPasswordReused } from '../../auth/passwordPolicy';
import { createAuthRouter } from '../auth';
import { verifyAccessToken } from '../../auth/tokens';
import {
  createFakePool, authSessionHandler, sequenceHandler,
  type FakePool, type FakeQueryReply,
} from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function changePasswordApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/auth', createAuthRouter(fake.pool)));
}

// The auth middleware checks session liveness with pool.query (authSessionHandler);
// CSRF passes because the token carries the hash of CSRF_TOKEN and authHeaders() sends it.
const CSRF_TOKEN = 'csrf-tok';

function authedToken(): string {
  return makeAccessToken({
    userId:             'user-1',
    sessionId:          'sess-1',
    orgId:              'org-1',
    role:               'doctor',
    name:               'Dr. Kim',
    mustChangePassword: false,
    csrfToken:          CSRF_TOKEN,
  });
}

const TX_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;

// auth middleware session check (pool.query), then client.query for the handler in call order.
// BEGIN/COMMIT은 fakePool 기본 응답(빈 결과)으로 넘어가고 fake.calls·fake.transactions에 기록된다.
function makeFake(...clientReplies: FakeQueryReply[]): FakePool {
  return createFakePool({
    handlers: [
      authSessionHandler(),
      sequenceHandler(clientReplies, { name: 'client', via: 'client', match: sql => !TX_CONTROL.test(sql) }),
    ],
  });
}

const PASSWORD_ROW: FakeQueryReply = { rows: [{ password_hash: '$oldhash$', password_history: [] }] };

// Wire: SELECT password_hash/history → (BEGIN) → UPDATE users RETURNING → UPDATE sessions → (COMMIT)
function wireSuccess(): FakePool {
  return makeFake(
    PASSWORD_ROW, // SELECT
    {
      rows: [{
        id:                   'user-1',
        name:                 'Dr. Kim',
        role:                 'doctor',
        organization_id:      'org-1',
        must_change_password: false,
      }],
    }, // UPDATE users RETURNING
    { rows: [] }, // UPDATE sessions
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/auth/change-password', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = makeFake();

    const res = await request(changePasswordApp(fake))
      .post('/api/auth/change-password')
      .send({ currentPassword: 'old1234!A', newPassword: 'new1234!A' });

    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0); // Bearer 없음 — DB까지 가지 않음
  });

  it('returns 400 when body is missing fields', async () => {
    const fake = makeFake();

    const res = await request(changePasswordApp(fake))
      .post('/api/auth/change-password')
      .set(authHeaders(authedToken(), CSRF_TOKEN))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    fake.assertNoUnmatched();
  });

  it('returns 400 when new password fails policy', async () => {
    const fake = makeFake();
    vi.mocked(checkPasswordPolicy).mockReturnValueOnce({ ok: false, error: 'Too short' });

    const res = await request(changePasswordApp(fake))
      .post('/api/auth/change-password')
      .set(authHeaders(authedToken(), CSRF_TOKEN))
      .send({ currentPassword: 'old1234!A', newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_POLICY_VIOLATION');
    fake.assertNoUnmatched();
  });

  it('returns 401 when current password is wrong', async () => {
    const fake = makeFake(PASSWORD_ROW);
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never); // wrong password

    const res = await request(changePasswordApp(fake))
      .post('/api/auth/change-password')
      .set(authHeaders(authedToken(), CSRF_TOKEN))
      .send({ currentPassword: 'wrongpass', newPassword: 'new1234!A' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('WRONG_CURRENT_PASSWORD');
    fake.assertNoUnmatched();
    fake.assertAllReleased();
  });

  it('returns 400 when new password was recently used', async () => {
    const fake = makeFake(PASSWORD_ROW);
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never); // current password ok
    vi.mocked(isPasswordReused).mockResolvedValueOnce(true);        // but reused

    const res = await request(changePasswordApp(fake))
      .post('/api/auth/change-password')
      .set(authHeaders(authedToken(), CSRF_TOKEN))
      .send({ currentPassword: 'old1234!A', newPassword: 'old1234!A' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_RECENTLY_USED');
    fake.assertNoUnmatched();
    fake.assertAllReleased();
  });

  it('returns 200 and revokes other sessions on success', async () => {
    const fake = wireSuccess();
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

    const res = await request(changePasswordApp(fake))
      .post('/api/auth/change-password')
      .set(authHeaders(authedToken(), CSRF_TOKEN))
      .send({ currentPassword: 'old1234!A', newPassword: 'New1234!A' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toMatchObject({
      id:                 'user-1',
      name:               'Dr. Kim',
      role:               'doctor',
      organizationId:     'org-1',
      mustChangePassword: false,
    });
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.accessExpiresAt).toBe('string');

    const decoded = verifyAccessToken(res.body.accessToken);
    expect(decoded?.sub).toBe('user-1');
    expect(decoded?.sessionId).toBe('sess-1');
    expect(decoded?.orgId).toBe('org-1');
    expect(decoded?.mustChangePassword).toBe(false);

    // Verify COMMIT was called
    const calls = fake.calls.filter(c => c.via === 'client').map(c => c.sql);
    expect(calls).toContain('COMMIT');
    expect(fake.transactions).toEqual([{ clientId: 1, statements: ['BEGIN', 'COMMIT'], outcome: 'commit' }]);

    // Verify UPDATE sessions was called to revoke other sessions
    const revokeCall = calls.find(q => q.includes('UPDATE sessions'));
    expect(revokeCall).toBeDefined();
    fake.assertNoUnmatched();
    fake.assertAllReleased();
  });
});

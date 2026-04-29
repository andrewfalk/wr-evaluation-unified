/**
 * Tests for POST /api/auth/change-password
 */
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
    ai:                  { enabled: false },
    localFallbackAllowed: false,
  },
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
import { generateAccessToken } from '../../auth/tokens';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  const release = vi.fn();
  const client: Partial<PoolClient> = { query: vi.fn(), release };
  return {
    connect: vi.fn().mockResolvedValue(client),
    query:   vi.fn(),
  } as unknown as Pool;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter(pool));
  return app;
}

// SHA-256 of 'csrf-tok' (matches validateCsrf internals when it reads from real csrf module)
// For simplicity: the auth middleware uses pool.query to check session liveness;
// we short-circuit by returning { exists: 1 }. CSRF passes because validateCsrf
// is exported from the real module and we wire the token accordingly.
import crypto from 'crypto';
const CSRF_TOKEN = 'csrf-tok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function authedToken(): string {
  const { token } = generateAccessToken({
    sub:                'user-1',
    sessionId:          'sess-1',
    orgId:              'org-1',
    role:               'doctor',
    name:               'Dr. Kim',
    mustChangePassword: false,
    csrfHash:           CSRF_HASH,
  });
  return token;
}

// Wire: auth middleware session check (pool.query), then client.query for the handler
function wireSuccess(pool: Pool) {
  // pool.query: auth middleware session check
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
  // client.query: SELECT password_hash/history
  const client = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
  client.query
    .mockResolvedValueOnce({ rows: [{ password_hash: '$oldhash$', password_history: [] }] }) // SELECT
    .mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [] }) // UPDATE users
    .mockResolvedValueOnce({ rows: [] }) // UPDATE sessions
    .mockResolvedValueOnce({ rows: [] }); // COMMIT
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/auth/change-password', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp(pool))
      .post('/api/auth/change-password')
      .send({ currentPassword: 'old1234!A', newPassword: 'new1234!A' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when body is missing fields', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });

    const res = await request(makeApp(pool))
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${authedToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when new password fails policy', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    vi.mocked(checkPasswordPolicy).mockReturnValueOnce({ ok: false, error: 'Too short' });

    const res = await request(makeApp(pool))
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${authedToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ currentPassword: 'old1234!A', newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_POLICY_VIOLATION');
  });

  it('returns 401 when current password is wrong', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const client = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    client.query.mockResolvedValueOnce({
      rows: [{ password_hash: '$oldhash$', password_history: [] }],
    });
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never); // wrong password

    const res = await request(makeApp(pool))
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${authedToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ currentPassword: 'wrongpass', newPassword: 'new1234!A' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('WRONG_CURRENT_PASSWORD');
  });

  it('returns 400 when new password was recently used', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const client = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    client.query.mockResolvedValueOnce({
      rows: [{ password_hash: '$oldhash$', password_history: [] }],
    });
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never); // current password ok
    vi.mocked(isPasswordReused).mockResolvedValueOnce(true);        // but reused

    const res = await request(makeApp(pool))
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${authedToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ currentPassword: 'old1234!A', newPassword: 'old1234!A' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_RECENTLY_USED');
  });

  it('returns 200 and revokes other sessions on success', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const client = wireSuccess(pool);
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

    const res = await request(makeApp(pool))
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${authedToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ currentPassword: 'old1234!A', newPassword: 'New1234!A' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify COMMIT was called
    const calls = client.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('COMMIT');

    // Verify UPDATE sessions was called to revoke other sessions
    const revokeCall = calls.find(
      (q: unknown) => typeof q === 'string' && q.includes('UPDATE sessions')
    );
    expect(revokeCall).toBeDefined();
  });
});

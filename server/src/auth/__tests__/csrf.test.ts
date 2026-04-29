import { describe, it, expect, vi } from 'vitest';
import { validateCsrf, setCsrfCookie, clearCsrfCookie, reissueCsrfToken, CSRF_COOKIE } from '../csrf';
import { hashToken } from '../sessionStore';
import type { Response } from 'express';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// validateCsrf
// ---------------------------------------------------------------------------
describe('validateCsrf', () => {
  const stored = hashToken('correct-token');

  it('returns true for matching token', () => {
    expect(validateCsrf('correct-token', stored)).toBe(true);
  });

  it('returns false for wrong token', () => {
    expect(validateCsrf('wrong-token', stored)).toBe(false);
  });

  it('returns false when header is undefined', () => {
    expect(validateCsrf(undefined, stored)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(validateCsrf('', stored)).toBe(false);
  });

  it('uses first element when header is an array', () => {
    expect(validateCsrf(['correct-token', 'other'], stored)).toBe(true);
    expect(validateCsrf(['wrong', 'correct-token'], stored)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------
function makeMockRes(): Response {
  return { cookie: vi.fn() } as unknown as Response;
}

describe('setCsrfCookie', () => {
  it('sets wr_csrf as non-HttpOnly, SameSite=strict', () => {
    const res = makeMockRes();
    setCsrfCookie(res, 'mytoken', true);

    expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE, 'mytoken', {
      httpOnly: false,
      secure:   true,
      sameSite: 'strict',
      path:     '/',
    });
  });

  it('respects secure=false in dev', () => {
    const res = makeMockRes();
    setCsrfCookie(res, 'tok', false);
    const opts = (res.cookie as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.secure).toBe(false);
  });
});

describe('clearCsrfCookie', () => {
  it('sets maxAge=0 to expire the cookie', () => {
    const res = makeMockRes();
    clearCsrfCookie(res, true);
    const opts = (res.cookie as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.maxAge).toBe(0);
    expect(opts.httpOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reissueCsrfToken
// ---------------------------------------------------------------------------
describe('reissueCsrfToken', () => {
  function makePool(): Pool {
    const client: Partial<PoolClient> = {
      query:   vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  }

  it('updates csrf_token_hash in DB and sets cookie', async () => {
    const pool = makePool();
    const res  = makeMockRes();

    await reissueCsrfToken(pool, 'sess-id', res, true);

    const client = await (pool.connect as ReturnType<typeof vi.fn>).mock.results[0].value;
    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('UPDATE sessions SET csrf_token_hash');
    expect(params[1]).toBe('sess-id');

    // Stored value must be the hash of the raw token, not the raw token
    const storedHash = params[0] as string;
    expect(storedHash).toHaveLength(64);

    // Cookie was set with the raw token (which hashes to storedHash)
    const [, cookieValue] = (res.cookie as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(hashToken(cookieValue)).toBe(storedHash);
  });

  it('generates a unique token each call', async () => {
    const pool1 = makePool();
    const pool2 = makePool();
    const res1  = makeMockRes();
    const res2  = makeMockRes();

    await reissueCsrfToken(pool1, 'sess-1', res1, false);
    await reissueCsrfToken(pool2, 'sess-2', res2, false);

    const tok1 = (res1.cookie as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const tok2 = (res2.cookie as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(tok1).not.toBe(tok2);
  });

  it('releases the DB connection even on error', async () => {
    const client: Partial<PoolClient> = {
      query:   vi.fn().mockRejectedValue(new Error('DB error')),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const res  = makeMockRes();

    await expect(reissueCsrfToken(pool, 'sess', res, true)).rejects.toThrow('DB error');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { PoolClient, Pool } from 'pg';
import {
  createSession,
  verifySession,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
  hashToken,
} from '../sessionStore';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeClientWithResponses(responses: Array<{ rows: unknown[] }>): PoolClient {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
  let callIndex = 0;
  (client.query as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const resp = responses[callIndex] ?? { rows: [] };
    callIndex++;
    return Promise.resolve(resp);
  });
  return client;
}

function makePool(clientResponses: Array<{ rows: unknown[] }>): Pool {
  const client = makeClientWithResponses(clientResponses);
  return {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// hashToken
// ---------------------------------------------------------------------------
describe('hashToken', () => {
  it('produces a consistent SHA-256 hex digest', () => {
    const h1 = hashToken('mytoken');
    const h2 = hashToken('mytoken');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('different tokens produce different hashes', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------
describe('createSession', () => {
  it('inserts hashed tokens (not raw) and returns raw tokens', async () => {
    const fakeId = 'session-uuid-123';
    const client = makeClientWithResponses([{ rows: [{ id: fakeId }] }]);

    const result = await createSession(
      client,
      'user-1',
      { userAgent: 'Mozilla/5.0', ip: '127.0.0.1' },
      900
    );

    expect(result.sessionId).toBe(fakeId);
    expect(result.refreshToken).toHaveLength(64); // 32 bytes hex
    expect(result.csrfToken).toHaveLength(64);

    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO sessions');

    // Params[1] is refresh_token_hash — must NOT equal the raw token
    const refreshHash = params[1] as string;
    expect(refreshHash).not.toBe(result.refreshToken);
    expect(refreshHash).toBe(hashToken(result.refreshToken));

    // Params[2] is csrf_token_hash
    const csrfHash = params[2] as string;
    expect(csrfHash).toBe(hashToken(result.csrfToken));
  });

  it('each call generates unique tokens', async () => {
    const client1 = makeClientWithResponses([{ rows: [{ id: 'id-1' }] }]);
    const client2 = makeClientWithResponses([{ rows: [{ id: 'id-2' }] }]);

    const r1 = await createSession(client1, 'user-1', {}, 900);
    const r2 = await createSession(client2, 'user-1', {}, 900);

    expect(r1.refreshToken).not.toBe(r2.refreshToken);
    expect(r1.csrfToken).not.toBe(r2.csrfToken);
  });

  it('expiresAt is ~ttlSeconds in the future', async () => {
    const client = makeClientWithResponses([{ rows: [{ id: 'x' }] }]);
    const before = Date.now();
    const result = await createSession(client, 'user-1', {}, 900);
    const after  = Date.now();

    const expiresMs = result.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 900_000);
    expect(expiresMs).toBeLessThanOrEqual(after  + 900_000);
  });
});

// ---------------------------------------------------------------------------
// verifySession
// ---------------------------------------------------------------------------
describe('verifySession', () => {
  it('returns null when no row found', async () => {
    const client = makeClientWithResponses([{ rows: [] }]);
    const result = await verifySession(client, 'some-token');
    expect(result).toBeNull();
  });

  it('returns session info when row found', async () => {
    const row = { id: 'sess-1', user_id: 'user-1', csrf_token_hash: 'csrfhash' };
    const client = makeClientWithResponses([{ rows: [row] }]);

    const result = await verifySession(client, 'token');
    expect(result).toEqual({
      sessionId:     'sess-1',
      userId:        'user-1',
      csrfTokenHash: 'csrfhash',
    });
  });

  it('passes the token hash (not raw) to the DB', async () => {
    const client = makeClientWithResponses([{ rows: [] }]);
    const rawToken = 'raw-token-value';
    await verifySession(client, rawToken);

    const [_sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(hashToken(rawToken));
    expect(params[0]).not.toBe(rawToken);
  });

  it('SQL includes 30-second grace window clause', async () => {
    const client = makeClientWithResponses([{ rows: [] }]);
    await verifySession(client, 'token');

    const [sql] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("interval '30 seconds'");
  });

  it('SQL checks invalidated_at IS NULL (terminal revoke has no grace)', async () => {
    const client = makeClientWithResponses([{ rows: [] }]);
    await verifySession(client, 'token');

    const [sql] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('invalidated_at IS NULL');
  });
});

// ---------------------------------------------------------------------------
// rotateSession
// ---------------------------------------------------------------------------
describe('rotateSession', () => {
  it('returns null when old token is not valid', async () => {
    // verifySessionStrict returns empty rows → existing is null
    const pool = makePool([
      { rows: [] }, // BEGIN
      { rows: [] }, // verifySessionStrict SELECT → empty
      { rows: [] }, // ROLLBACK
    ]);
    const result = await rotateSession(pool, 'bad-token', {}, 900);
    expect(result).toBeNull();
  });

  it('returns null when old token was already rotated (revoked_at IS NOT NULL)', async () => {
    // verifySessionStrict requires revoked_at IS NULL — already-rotated token returns empty
    const pool = makePool([
      { rows: [] }, // BEGIN
      { rows: [] }, // verifySessionStrict SELECT → empty (token already rotated)
      { rows: [] }, // ROLLBACK
    ]);
    const result = await rotateSession(pool, 'already-rotated-token', {}, 900);
    expect(result).toBeNull();
  });

  it('creates new session and revokes old one atomically', async () => {
    const oldRow = { id: 'old-sess', user_id: 'user-1', csrf_token_hash: 'oldhash' };
    const newId  = 'new-sess';

    const pool = makePool([
      { rows: [] },          // BEGIN
      { rows: [oldRow] },    // verifySession SELECT
      { rows: [] },          // UPDATE revoked_at (old session)
      { rows: [{ id: newId }] }, // INSERT new session
      { rows: [] },          // COMMIT
    ]);

    const result = await rotateSession(pool, 'old-refresh-token', {}, 900);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(newId);
    expect(result!.refreshToken).toHaveLength(64);
    expect(result!.csrfToken).toHaveLength(64);

    const client = await (pool.connect as ReturnType<typeof vi.fn>).mock.results[0].value;
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;

    expect(calls[0][0]).toBe('BEGIN');
    expect(calls[2][0]).toContain('UPDATE sessions SET revoked_at');
    expect(calls[2][1][0]).toBe('old-sess'); // revokes the old session id
    expect(calls[4][0]).toBe('COMMIT');
  });

  it('rolls back and throws if an error occurs mid-transaction', async () => {
    const oldRow = { id: 'old-sess', user_id: 'user-1', csrf_token_hash: 'h' };
    let callCount = 0;
    const client = {
      query: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ rows: [] }); // BEGIN
        if (callCount === 2) return Promise.resolve({ rows: [oldRow] }); // verify
        if (callCount === 3) return Promise.reject(new Error('DB error')); // UPDATE fails
        return Promise.resolve({ rows: [] }); // ROLLBACK
      }),
      release: vi.fn(),
    } as unknown as PoolClient;

    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    await expect(rotateSession(pool, 'token', {}, 900)).rejects.toThrow('DB error');

    const rollbackCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'ROLLBACK'
    );
    expect(rollbackCall).toBeDefined();
  });

  it('releases the connection even on error', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })   // BEGIN
        .mockResolvedValueOnce({ rows: [] })   // verifySession → null
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    } as unknown as PoolClient;

    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    await rotateSession(pool, 'bad', {}, 900);

    expect((client.release as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// revokeSession  (terminal — logout)
// ---------------------------------------------------------------------------
describe('revokeSession', () => {
  it('sets invalidated_at (not revoked_at) for immediate terminal revoke', async () => {
    const client = makeClientWithResponses([{ rows: [] }]);
    await revokeSession(client, 'sess-123');

    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('invalidated_at = now()');
    expect(sql).not.toContain('revoked_at');
    expect(params[0]).toBe('sess-123');
  });
});

// ---------------------------------------------------------------------------
// revokeAllUserSessions  (terminal — password change)
// ---------------------------------------------------------------------------
describe('revokeAllUserSessions', () => {
  it('sets invalidated_at for all user sessions', async () => {
    const client = makeClientWithResponses([{ rows: [] }]);
    await revokeAllUserSessions(client, 'user-1');

    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('invalidated_at = now()');
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).not.toContain('id !=');
    expect(params[0]).toBe('user-1');
  });

  it('excludes the current session when exceptSessionId is provided', async () => {
    const client = makeClientWithResponses([{ rows: [] }]);
    await revokeAllUserSessions(client, 'user-1', 'current-sess');

    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('id != $2');
    expect(params[1]).toBe('current-sess');
  });
});

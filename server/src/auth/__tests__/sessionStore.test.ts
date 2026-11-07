import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import {
  createSession,
  verifySession,
  rotateSession,
  revokeSessionFamily,
  revokeAllUserSessions,
  hashToken,
} from '../sessionStore';
import { createFakePool, sequenceHandler, type FakePool, type FakeQueryReply } from '../../testing/fakePool';

// ---------------------------------------------------------------------------
// Fake pool helpers — 기존 순서형 응답 큐를 sequenceHandler(via client)로 옮긴 것.
// 응답은 connect()한 client의 쿼리(BEGIN/COMMIT/ROLLBACK 포함)에 호출 순서대로 하나씩 간다.
// ---------------------------------------------------------------------------

function orderedFake(clientResponses: Array<FakeQueryReply | Error>): FakePool {
  return createFakePool({ handlers: [sequenceHandler(clientResponses, { via: 'client' })] });
}

/** client를 직접 받는 함수(createSession·verifySession·revokeAllUserSessions)용. */
async function orderedClient(responses: Array<FakeQueryReply | Error>): Promise<{ fake: FakePool; client: PoolClient }> {
  const fake = orderedFake(responses);
  return { fake, client: await fake.pool.connect() };
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
    const { fake, client } = await orderedClient([{ rows: [{ id: fakeId }] }]);

    const result = await createSession(
      client,
      'user-1',
      { userAgent: 'Mozilla/5.0', ip: '127.0.0.1' },
      900
    );

    expect(result.sessionId).toBe(fakeId);
    expect(result.refreshToken).toHaveLength(64); // 32 bytes hex
    expect(result.csrfToken).toHaveLength(64);

    const { sql, params } = fake.calls[0]!;
    expect(sql).toContain('INSERT INTO sessions');

    // Params[1] is refresh_token_hash — must NOT equal the raw token
    const refreshHash = params[1] as string;
    expect(refreshHash).not.toBe(result.refreshToken);
    expect(refreshHash).toBe(hashToken(result.refreshToken));

    // Params[2] is csrf_token_hash
    const csrfHash = params[2] as string;
    expect(csrfHash).toBe(hashToken(result.csrfToken));

    // Params[6] is persistent_cookie — defaults to true when not specified
    expect(params[6]).toBe(true);
    expect(result.persistentCookie).toBe(true);

    // Params[7] is family_id — auto-generated when not specified
    expect(typeof params[7]).toBe('string');
    expect(result.familyId).toBe(params[7]);
  });

  it('passes persistentCookie=false through to the INSERT and the result', async () => {
    const { fake, client } = await orderedClient([{ rows: [{ id: 'sess-2' }] }]);

    const result = await createSession(client, 'user-1', {}, 900, false);

    const { params } = fake.calls[0]!;
    expect(params[6]).toBe(false);
    expect(result.persistentCookie).toBe(false);
  });

  it('generates a different familyId per call when not provided', async () => {
    const { client: client1 } = await orderedClient([{ rows: [{ id: 'id-1' }] }]);
    const { client: client2 } = await orderedClient([{ rows: [{ id: 'id-2' }] }]);

    const r1 = await createSession(client1, 'user-1', {}, 900);
    const r2 = await createSession(client2, 'user-1', {}, 900);

    expect(r1.familyId).not.toBe(r2.familyId);
  });

  it('uses the provided familyId instead of generating one (rotation case)', async () => {
    const { fake, client } = await orderedClient([{ rows: [{ id: 'sess-3' }] }]);

    const result = await createSession(client, 'user-1', {}, 900, true, 'inherited-family-id');

    const { params } = fake.calls[0]!;
    expect(params[7]).toBe('inherited-family-id');
    expect(result.familyId).toBe('inherited-family-id');
  });

  it('each call generates unique tokens', async () => {
    const { client: client1 } = await orderedClient([{ rows: [{ id: 'id-1' }] }]);
    const { client: client2 } = await orderedClient([{ rows: [{ id: 'id-2' }] }]);

    const r1 = await createSession(client1, 'user-1', {}, 900);
    const r2 = await createSession(client2, 'user-1', {}, 900);

    expect(r1.refreshToken).not.toBe(r2.refreshToken);
    expect(r1.csrfToken).not.toBe(r2.csrfToken);
  });

  it('expiresAt is ~ttlSeconds in the future', async () => {
    const { client } = await orderedClient([{ rows: [{ id: 'x' }] }]);
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
    const { client } = await orderedClient([{ rows: [] }]);
    const result = await verifySession(client, 'some-token');
    expect(result).toBeNull();
  });

  it('returns session info when row found', async () => {
    const row = { id: 'sess-1', user_id: 'user-1', csrf_token_hash: 'csrfhash', persistent_cookie: true, family_id: 'fam-1' };
    const { client } = await orderedClient([{ rows: [row] }]);

    const result = await verifySession(client, 'token');
    expect(result).toEqual({
      sessionId:        'sess-1',
      userId:           'user-1',
      csrfTokenHash:    'csrfhash',
      persistentCookie: true,
      familyId:         'fam-1',
    });
  });

  it('passes the token hash (not raw) to the DB', async () => {
    const { fake, client } = await orderedClient([{ rows: [] }]);
    const rawToken = 'raw-token-value';
    await verifySession(client, rawToken);

    const { params } = fake.calls[0]!;
    expect(params[0]).toBe(hashToken(rawToken));
    expect(params[0]).not.toBe(rawToken);
  });

  it('SQL includes 30-second grace window clause', async () => {
    const { fake, client } = await orderedClient([{ rows: [] }]);
    await verifySession(client, 'token');

    const { sql } = fake.calls[0]!;
    expect(sql).toContain("interval '30 seconds'");
  });

  it('SQL checks invalidated_at IS NULL (terminal revoke has no grace)', async () => {
    const { fake, client } = await orderedClient([{ rows: [] }]);
    await verifySession(client, 'token');

    const { sql } = fake.calls[0]!;
    expect(sql).toContain('invalidated_at IS NULL');
  });
});

// ---------------------------------------------------------------------------
// rotateSession
// ---------------------------------------------------------------------------
describe('rotateSession', () => {
  it('returns null when the token matches no session at all (family lookup empty)', async () => {
    const fake = orderedFake([
      { rows: [] }, // BEGIN
      { rows: [] }, // findFamilyIdForToken → empty
      { rows: [] }, // ROLLBACK
    ]);
    const result = await rotateSession(fake.pool, 'bad-token', {}, 900);
    expect(result).toBeNull();
  });

  it('returns null when old token was already rotated (revoked_at IS NOT NULL)', async () => {
    // Family exists (lookup succeeds, so the advisory lock is taken), but
    // verifySessionStrict requires revoked_at IS NULL — already-rotated
    // token returns empty.
    const fake = orderedFake([
      { rows: [] },                     // BEGIN
      { rows: [{ family_id: 'fam-1' }] }, // findFamilyIdForToken
      { rows: [] },                     // lockFamily (pg_advisory_xact_lock)
      { rows: [] },                     // verifySessionStrict SELECT → empty (already rotated)
      { rows: [] },                     // ROLLBACK
    ]);
    const result = await rotateSession(fake.pool, 'already-rotated-token', {}, 900);
    expect(result).toBeNull();
  });

  it('creates new session and revokes old one atomically', async () => {
    const oldRow = { id: 'old-sess', user_id: 'user-1', csrf_token_hash: 'oldhash', persistent_cookie: true, family_id: 'fam-1' };
    const newId  = 'new-sess';

    const fake = orderedFake([
      { rows: [] },                     // BEGIN
      { rows: [{ family_id: 'fam-1' }] }, // findFamilyIdForToken
      { rows: [] },                     // lockFamily
      { rows: [oldRow] },               // verifySessionStrict SELECT
      { rows: [] },                     // UPDATE revoked_at (old session)
      { rows: [{ id: newId }] },        // INSERT new session
      { rows: [] },                     // COMMIT
    ]);

    const result = await rotateSession(fake.pool, 'old-refresh-token', {}, 900);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(newId);
    expect(result!.refreshToken).toHaveLength(64);
    expect(result!.csrfToken).toHaveLength(64);

    const calls = fake.calls;

    expect(calls[0]!.sql).toBe('BEGIN');
    expect(calls[2]!.sql).toContain('pg_advisory_xact_lock'); // family-wide lock before real verification
    expect(calls[3]!.sql).toContain('FOR UPDATE'); // verifySessionStrict must also lock the row
    expect(calls[4]!.sql).toContain('UPDATE sessions SET revoked_at');
    expect(calls[4]!.params[0]).toBe('old-sess'); // revokes the old session id
    expect(calls[6]!.sql).toBe('COMMIT');
  });

  it('carries the old session persistentCookie policy and familyId over to the new session', async () => {
    const oldRow = { id: 'old-sess', user_id: 'user-1', csrf_token_hash: 'oldhash', persistent_cookie: false, family_id: 'fam-2' };
    const newId  = 'new-sess';

    const fake = orderedFake([
      { rows: [] },                     // BEGIN
      { rows: [{ family_id: 'fam-2' }] }, // findFamilyIdForToken
      { rows: [] },                     // lockFamily
      { rows: [oldRow] },               // verifySessionStrict SELECT
      { rows: [] },                     // UPDATE revoked_at (old session)
      { rows: [{ id: newId }] },        // INSERT new session
      { rows: [] },                     // COMMIT
    ]);

    const result = await rotateSession(fake.pool, 'old-refresh-token', {}, 900);

    expect(result!.persistentCookie).toBe(false);
    expect(result!.familyId).toBe('fam-2');

    const calls = fake.calls;
    // INSERT call (index 5) — persistent_cookie (param 6) and family_id (param 7)
    // must match the old session's values.
    expect(calls[5]!.params[6]).toBe(false);
    expect(calls[5]!.params[7]).toBe('fam-2');
  });

  it('rolls back and throws if an error occurs mid-transaction', async () => {
    const oldRow = { id: 'old-sess', user_id: 'user-1', csrf_token_hash: 'h', family_id: 'fam-1' };
    const fake = orderedFake([
      { rows: [] },                       // BEGIN
      { rows: [{ family_id: 'fam-1' }] }, // findFamilyIdForToken
      { rows: [] },                       // lockFamily
      { rows: [oldRow] },                 // verifySessionStrict
      new Error('DB error'),              // UPDATE fails
      { rows: [] },                       // ROLLBACK
    ]);

    await expect(rotateSession(fake.pool, 'token', {}, 900)).rejects.toThrow('DB error');

    const rollbackCall = fake.calls.find(c => c.sql === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
  });

  it('releases the connection even on error', async () => {
    const fake = orderedFake([
      { rows: [] }, // BEGIN
      { rows: [] }, // findFamilyIdForToken → empty
      { rows: [] }, // ROLLBACK
    ]);
    await rotateSession(fake.pool, 'bad', {}, 900);

    expect(fake.released).toBe(1);
    fake.assertAllReleased();
  });
});

// ---------------------------------------------------------------------------
// revokeSessionFamily  (terminal — logout)
// ---------------------------------------------------------------------------
describe('revokeSessionFamily', () => {
  it('returns not_found and rolls back when the token matches no session at all', async () => {
    const fake = orderedFake([
      { rows: [] }, // BEGIN
      { rows: [] }, // findFamilyIdForToken → empty
      { rows: [] }, // ROLLBACK
    ]);

    const result = await revokeSessionFamily(fake.pool, 'bad-token', 'csrf');
    expect(result).toEqual({ status: 'not_found' });

    const calls = fake.calls;
    expect(calls[2]!.sql).toBe('ROLLBACK');
  });

  it('locks the whole family (advisory lock), validates CSRF, then invalidates every row in it', async () => {
    const csrfRaw  = 'raw-csrf-token';
    const row = { id: 'sess-123', user_id: 'user-1', csrf_token_hash: hashToken(csrfRaw), persistent_cookie: true, family_id: 'fam-9' };
    const fake = orderedFake([
      { rows: [] },                      // BEGIN
      { rows: [{ family_id: 'fam-9' }] }, // findFamilyIdForToken
      { rows: [] },                      // lockFamily (pg_advisory_xact_lock)
      { rows: [row] },                   // re-verify SELECT (no FOR UPDATE — the family lock already covers it)
      { rows: [] },                      // UPDATE ... WHERE family_id
      { rows: [] },                      // COMMIT
    ]);

    const result = await revokeSessionFamily(fake.pool, 'raw-token', csrfRaw);

    expect(result).toEqual({ status: 'revoked', sessionId: 'sess-123', userId: 'user-1', familyId: 'fam-9' });

    const calls = fake.calls;
    expect(calls[2]!.sql).toContain('pg_advisory_xact_lock');
    expect(calls[3]!.sql).not.toContain('revoked_at IS NULL'); // finds the row even if already rotation-revoked
    expect(calls[4]!.sql).toContain('invalidated_at = now()');
    expect(calls[4]!.sql).toContain('WHERE family_id = $1');
    expect(calls[4]!.params[0]).toBe('fam-9');
    expect(calls[5]!.sql).toBe('COMMIT');
  });

  it('returns csrf_invalid and rolls back without revoking anything when the CSRF token does not match', async () => {
    const row = { id: 'sess-123', user_id: 'user-1', csrf_token_hash: hashToken('correct-csrf'), persistent_cookie: true, family_id: 'fam-9' };
    const fake = orderedFake([
      { rows: [] },                      // BEGIN
      { rows: [{ family_id: 'fam-9' }] }, // findFamilyIdForToken
      { rows: [] },                      // lockFamily
      { rows: [row] },                   // re-verify SELECT
      { rows: [] },                      // ROLLBACK
    ]);

    const result = await revokeSessionFamily(fake.pool, 'raw-token', 'wrong-csrf');
    expect(result).toEqual({ status: 'csrf_invalid' });

    const calls = fake.calls;
    // Must not have reached the family-wide invalidate — only BEGIN, lookup,
    // lock, re-verify, ROLLBACK (5 calls, no UPDATE/COMMIT).
    expect(calls).toHaveLength(5);
    expect(calls[4]!.sql).toBe('ROLLBACK');
  });

  it('rolls back and throws if an error occurs mid-transaction', async () => {
    const csrfRaw = 'raw-csrf-token';
    const row = { id: 'sess-1', user_id: 'user-1', csrf_token_hash: hashToken(csrfRaw), persistent_cookie: true, family_id: 'fam-1' };
    const fake = orderedFake([
      { rows: [] },                       // BEGIN
      { rows: [{ family_id: 'fam-1' }] }, // findFamilyIdForToken
      { rows: [] },                       // lockFamily
      { rows: [row] },                    // re-verify SELECT
      new Error('DB error'),              // family UPDATE fails
      { rows: [] },                       // ROLLBACK
    ]);

    await expect(revokeSessionFamily(fake.pool, 'token', csrfRaw)).rejects.toThrow('DB error');

    const rollbackCall = fake.calls.find(c => c.sql === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
  });

  it('releases the connection even when no session is found', async () => {
    const fake = orderedFake([
      { rows: [] }, // BEGIN
      { rows: [] }, // findFamilyIdForToken → empty
      { rows: [] }, // ROLLBACK
    ]);
    await revokeSessionFamily(fake.pool, 'bad', 'csrf');

    expect(fake.released).toBe(1);
    fake.assertAllReleased();
  });
});

// ---------------------------------------------------------------------------
// revokeAllUserSessions  (terminal — password change)
// ---------------------------------------------------------------------------
describe('revokeAllUserSessions', () => {
  it('sets invalidated_at for all user sessions', async () => {
    const { fake, client } = await orderedClient([{ rows: [] }]);
    await revokeAllUserSessions(client, 'user-1');

    const { sql, params } = fake.calls[0]!;
    expect(sql).toContain('invalidated_at = now()');
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).not.toContain('id !=');
    expect(params[0]).toBe('user-1');
  });

  it('excludes the current session when exceptSessionId is provided', async () => {
    const { fake, client } = await orderedClient([{ rows: [] }]);
    await revokeAllUserSessions(client, 'user-1', 'current-sess');

    const { sql, params } = fake.calls[0]!;
    expect(sql).toContain('id != $2');
    expect(params[1]).toBe('current-sess');
  });
});

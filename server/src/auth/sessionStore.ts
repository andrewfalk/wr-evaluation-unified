import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { generateToken, hashToken } from './tokenHash';
import { validateCsrf } from './csrf';

export { hashToken };

// ---------------------------------------------------------------------------
// Family-wide serialization
//
// Rotation and revocation both need exclusive access to an entire rotation
// lineage (family_id), not just the one row a given token happens to name —
// a logout holding an old (already-rotated) token and a concurrent refresh
// holding the current token operate on *different* rows, so a lock on just
// "the row this token names" never contends between them. A Postgres
// transaction-scoped advisory lock keyed by family_id closes that gap: both
// operations look up which family their token belongs to, then take this
// lock before doing anything else, so only one of them can be mid-transaction
// against a given family at a time (released automatically on COMMIT/ROLLBACK).
// ---------------------------------------------------------------------------
async function lockFamily(client: PoolClient, familyId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [familyId]);
}

async function findFamilyIdForToken(client: PoolClient, refreshToken: string): Promise<string | null> {
  const { rows } = await client.query<{ family_id: string }>(
    `SELECT family_id FROM sessions WHERE refresh_token_hash = $1`,
    [hashToken(refreshToken)]
  );
  return rows[0]?.family_id ?? null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateSessionResult {
  sessionId:        string;
  refreshToken:     string; // raw — caller sets as HttpOnly cookie
  csrfToken:        string; // raw — caller sets as non-HttpOnly cookie
  expiresAt:        Date;
  persistentCookie: boolean;
  familyId:         string;
}

export interface VerifySessionResult {
  sessionId:        string;
  userId:           string;
  csrfTokenHash:    string;
  persistentCookie: boolean;
  familyId:         string;
}

interface SessionRow {
  id:                string;
  user_id:           string;
  csrf_token_hash:   string;
  persistent_cookie: boolean;
  family_id:         string;
}

// ---------------------------------------------------------------------------
// createSession
// Creates a new session row. Caller supplies the client/transaction.
// ---------------------------------------------------------------------------
export async function createSession(
  client: PoolClient,
  userId: string,
  meta: { userAgent?: string; ip?: string },
  ttlSeconds: number,
  persistentCookie: boolean = true,
  familyId?: string
): Promise<CreateSessionResult> {
  const refreshToken = generateToken();
  const csrfToken    = generateToken();
  const expiresAt    = new Date(Date.now() + ttlSeconds * 1000);
  // A fresh login starts a new lineage (family_id = a fresh id of its own).
  // Rotation passes the inherited family_id through instead.
  const resolvedFamilyId = familyId ?? crypto.randomUUID();

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sessions
       (user_id, refresh_token_hash, csrf_token_hash, expires_at, user_agent, ip, persistent_cookie, family_id)
     VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8)
     RETURNING id`,
    [
      userId,
      hashToken(refreshToken),
      hashToken(csrfToken),
      expiresAt,
      meta.userAgent ?? null,
      meta.ip        ?? null,
      persistentCookie,
      resolvedFamilyId,
    ]
  );

  return { sessionId: rows[0].id, refreshToken, csrfToken, expiresAt, persistentCookie, familyId: resolvedFamilyId };
}

// ---------------------------------------------------------------------------
// verifySession
// Used by the auth middleware to validate an incoming refresh token.
// Accepts sessions where:
//   - not expired
//   - not terminally invalidated (logout / password change)
//   - either not rotation-revoked, OR revoked within the 30-second grace
//     window (handles multi-tab race where two tabs share the same old token)
// ---------------------------------------------------------------------------
export async function verifySession(
  client: PoolClient,
  refreshToken: string
): Promise<VerifySessionResult | null> {
  const { rows } = await client.query<SessionRow>(
    `SELECT id, user_id, csrf_token_hash, persistent_cookie, family_id
     FROM sessions
     WHERE refresh_token_hash = $1
       AND expires_at > now()
       AND invalidated_at IS NULL
       AND (revoked_at IS NULL OR revoked_at > now() - interval '30 seconds')`,
    [hashToken(refreshToken)]
  );

  if (rows.length === 0) return null;

  return {
    sessionId:        rows[0].id,
    userId:           rows[0].user_id,
    csrfTokenHash:    rows[0].csrf_token_hash,
    persistentCookie: rows[0].persistent_cookie,
    familyId:         rows[0].family_id,
  };
}

// ---------------------------------------------------------------------------
// verifySessionStrict  (rotation-only path)
// Requires revoked_at IS NULL — already-rotated tokens cannot be rotated
// again, even within the grace window.  This prevents a stolen token from
// spawning multiple sessions during the 30-second grace period.
//
// The real mutual exclusion here comes from rotateSession() taking the
// family-wide advisory lock (lockFamily) before calling this — two
// concurrent rotations of the *same row* would otherwise both pass this
// SELECT before either commits its revoked_at UPDATE, and two rotations of
// *different rows in the same family* (a stale token vs. the current one)
// wouldn't even contend on a row lock at all. FOR UPDATE is kept here as a
// second layer (harmless once the family lock is already held, but still
// correct on its own for the same-row case if this were ever called
// without it).
// ---------------------------------------------------------------------------
async function verifySessionStrict(
  client: PoolClient,
  refreshToken: string
): Promise<VerifySessionResult | null> {
  const { rows } = await client.query<SessionRow>(
    `SELECT id, user_id, csrf_token_hash, persistent_cookie, family_id
     FROM sessions
     WHERE refresh_token_hash = $1
       AND expires_at > now()
       AND invalidated_at IS NULL
       AND revoked_at IS NULL
     FOR UPDATE`,
    [hashToken(refreshToken)]
  );

  if (rows.length === 0) return null;

  return {
    sessionId:        rows[0].id,
    userId:           rows[0].user_id,
    csrfTokenHash:    rows[0].csrf_token_hash,
    persistentCookie: rows[0].persistent_cookie,
    familyId:         rows[0].family_id,
  };
}

// ---------------------------------------------------------------------------
// rotateSession
// Atomically revokes the old session (sets revoked_at) and creates a new one.
// Uses strict verification: a token that has already been rotated cannot be
// rotated again, preventing multi-session issuance from a single stolen token.
// Returns null if the old refresh token is invalid / expired / already rotated.
// ---------------------------------------------------------------------------
export async function rotateSession(
  pool: Pool,
  oldRefreshToken: string,
  meta: { userAgent?: string; ip?: string },
  ttlSeconds: number
): Promise<CreateSessionResult | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Family-wide lock first (see lockFamily) — must happen before the real
    // verification below so a concurrent logout/rotation on a different
    // generation of this same family can't race past us.
    const familyId = await findFamilyIdForToken(client, oldRefreshToken);
    if (!familyId) {
      await client.query('ROLLBACK');
      return null;
    }
    await lockFamily(client, familyId);

    const existing = await verifySessionStrict(client, oldRefreshToken);
    if (!existing) {
      await client.query('ROLLBACK');
      return null;
    }

    // Mark old session as rotation-revoked (grace window still allows verify)
    await client.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1',
      [existing.sessionId]
    );

    const result = await createSession(client, existing.userId, meta, ttlSeconds, existing.persistentCookie, existing.familyId);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type RevokeSessionFamilyResult =
  | { status: 'not_found' }
  | { status: 'csrf_invalid' }
  | { status: 'revoked'; sessionId: string; userId: string; familyId: string };

// ---------------------------------------------------------------------------
// revokeSessionFamily  (logout — terminal, no grace window)
//
// Kills every row in the rotation lineage that owns the given refresh token,
// not just the one row matching it. A naive "find session, revoke that one
// row" would miss a session a concurrent /refresh creates in between the
// lookup and the revoke — including when logout is holding an *older*
// generation's token than the one a concurrent refresh is rotating (they'd
// touch different rows, so a lock on just "the row this token names" never
// makes them contend). lockFamily() closes that: both this function and
// rotateSession() take the same family-scoped advisory lock before doing
// anything else, so only one of them is ever mid-transaction against a given
// family — whichever runs second always sees the first's committed result.
//
// CSRF is validated *inside* this same transaction, against whatever row the
// token currently resolves to, rather than as a separate pre-check with
// looser matching (a caller-side pre-check via verifySession() only tolerates
// a 30s rotation grace window, while a stale-but-not-yet-fully-invalidated
// token could still reach this function and revoke the whole family with no
// CSRF check at all — see auth.ts callers for the historical pre-check this
// replaced).
// ---------------------------------------------------------------------------
export async function revokeSessionFamily(
  pool: Pool,
  refreshToken: string,
  csrfHeaderValue: string | string[] | undefined
): Promise<RevokeSessionFamilyResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const familyId = await findFamilyIdForToken(client, refreshToken);
    if (!familyId) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }
    await lockFamily(client, familyId);

    // Re-verify under the lock — the row may have changed while we waited.
    const { rows } = await client.query<SessionRow>(
      `SELECT id, user_id, csrf_token_hash, persistent_cookie, family_id
       FROM sessions
       WHERE refresh_token_hash = $1
         AND expires_at > now()
         AND invalidated_at IS NULL`,
      [hashToken(refreshToken)]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }

    const sessionId       = rows[0].id;
    const userId          = rows[0].user_id;
    const resolvedFamilyId = rows[0].family_id;

    if (!validateCsrf(csrfHeaderValue, rows[0].csrf_token_hash)) {
      await client.query('ROLLBACK');
      return { status: 'csrf_invalid' };
    }

    await client.query(
      `UPDATE sessions SET invalidated_at = now() WHERE family_id = $1 AND invalidated_at IS NULL`,
      [resolvedFamilyId]
    );

    await client.query('COMMIT');
    return { status: 'revoked', sessionId, userId, familyId: resolvedFamilyId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// revokeAllUserSessions  (password change — revoke all except current)
// Also terminal: sets invalidated_at.
// ---------------------------------------------------------------------------
export async function revokeAllUserSessions(
  client: PoolClient,
  userId: string,
  exceptSessionId?: string
): Promise<void> {
  if (exceptSessionId) {
    await client.query(
      `UPDATE sessions SET invalidated_at = now()
       WHERE user_id = $1 AND id != $2 AND invalidated_at IS NULL`,
      [userId, exceptSessionId]
    );
  } else {
    await client.query(
      `UPDATE sessions SET invalidated_at = now()
       WHERE user_id = $1 AND invalidated_at IS NULL`,
      [userId]
    );
  }
}

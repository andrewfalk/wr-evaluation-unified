import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateSessionResult {
  sessionId:    string;
  refreshToken: string; // raw — caller sets as HttpOnly cookie
  csrfToken:    string; // raw — caller sets as non-HttpOnly cookie
  expiresAt:    Date;
}

export interface VerifySessionResult {
  sessionId:     string;
  userId:        string;
  csrfTokenHash: string;
}

interface SessionRow {
  id:              string;
  user_id:         string;
  csrf_token_hash: string;
}

// ---------------------------------------------------------------------------
// createSession
// Creates a new session row. Caller supplies the client/transaction.
// ---------------------------------------------------------------------------
export async function createSession(
  client: PoolClient,
  userId: string,
  meta: { userAgent?: string; ip?: string },
  ttlSeconds: number
): Promise<CreateSessionResult> {
  const refreshToken = generateToken();
  const csrfToken    = generateToken();
  const expiresAt    = new Date(Date.now() + ttlSeconds * 1000);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sessions
       (user_id, refresh_token_hash, csrf_token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6::inet)
     RETURNING id`,
    [
      userId,
      hashToken(refreshToken),
      hashToken(csrfToken),
      expiresAt,
      meta.userAgent ?? null,
      meta.ip        ?? null,
    ]
  );

  return { sessionId: rows[0].id, refreshToken, csrfToken, expiresAt };
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
    `SELECT id, user_id, csrf_token_hash
     FROM sessions
     WHERE refresh_token_hash = $1
       AND expires_at > now()
       AND invalidated_at IS NULL
       AND (revoked_at IS NULL OR revoked_at > now() - interval '30 seconds')`,
    [hashToken(refreshToken)]
  );

  if (rows.length === 0) return null;

  return {
    sessionId:     rows[0].id,
    userId:        rows[0].user_id,
    csrfTokenHash: rows[0].csrf_token_hash,
  };
}

// ---------------------------------------------------------------------------
// verifySessionStrict  (rotation-only path)
// Requires revoked_at IS NULL — already-rotated tokens cannot be rotated
// again, even within the grace window.  This prevents a stolen token from
// spawning multiple sessions during the 30-second grace period.
// ---------------------------------------------------------------------------
async function verifySessionStrict(
  client: PoolClient,
  refreshToken: string
): Promise<VerifySessionResult | null> {
  const { rows } = await client.query<SessionRow>(
    `SELECT id, user_id, csrf_token_hash
     FROM sessions
     WHERE refresh_token_hash = $1
       AND expires_at > now()
       AND invalidated_at IS NULL
       AND revoked_at IS NULL`,
    [hashToken(refreshToken)]
  );

  if (rows.length === 0) return null;

  return {
    sessionId:     rows[0].id,
    userId:        rows[0].user_id,
    csrfTokenHash: rows[0].csrf_token_hash,
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

    const result = await createSession(client, existing.userId, meta, ttlSeconds);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// revokeSession  (logout — terminal, no grace window)
// Sets invalidated_at so verifySession immediately rejects the token.
// ---------------------------------------------------------------------------
export async function revokeSession(
  client: PoolClient,
  sessionId: string
): Promise<void> {
  await client.query(
    'UPDATE sessions SET invalidated_at = now() WHERE id = $1',
    [sessionId]
  );
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

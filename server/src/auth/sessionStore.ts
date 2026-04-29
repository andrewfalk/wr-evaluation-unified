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
// Creates a new session row. Caller is responsible for the client/transaction.
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
    `INSERT INTO sessions (user_id, refresh_token_hash, csrf_token_hash, expires_at, user_agent, ip)
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
// Accepts a session if:
//   - refresh token hash matches
//   - not expired
//   - either not revoked, OR revoked within the last 30 seconds (grace window
//     for multi-tab / multi-process rotation races — companion to T27 BroadcastChannel)
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
// rotateSession
// Atomically revokes the old session and creates a new one.
// Returns null if the old refresh token is not found / expired / outside grace window.
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

    const existing = await verifySession(client, oldRefreshToken);
    if (!existing) {
      await client.query('ROLLBACK');
      return null;
    }

    // Revoke old session immediately (grace window is in verifySession query)
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
// revokeSession  (logout — immediate, no grace window)
// ---------------------------------------------------------------------------
export async function revokeSession(
  client: PoolClient,
  sessionId: string
): Promise<void> {
  await client.query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1',
    [sessionId]
  );
}

// ---------------------------------------------------------------------------
// revokeAllUserSessions  (password change — revoke all except current)
// ---------------------------------------------------------------------------
export async function revokeAllUserSessions(
  client: PoolClient,
  userId: string,
  exceptSessionId?: string
): Promise<void> {
  if (exceptSessionId) {
    await client.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL`,
      [userId, exceptSessionId]
    );
  } else {
    await client.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
  }
}

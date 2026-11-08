// Per-login-ID failure backoff (SEC-B M2, migration 0039). The IP limiter (5/min) stays in front of
// the route; this counts failures per login ID in the database so attempts spread over several IPs or
// server processes still add up. Unknown login IDs take exactly the same path, so a lockout does not
// tell the caller whether the account exists. Only a hash of the normalised ID is stored.
//
// Policy: the 5th consecutive failure locks the ID for 1 minute, every further failure doubles the
// lock (capped at 15 minutes). A request made while the ID is locked is refused without checking the
// password and does not count. A success deletes the row. A failure more than 24 hours after the
// previous one starts the count again. All times come from the database clock.
import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';

export const LOGIN_BACKOFF_POLICY = Object.freeze({
  threshold:       5,
  baseLockSec:     60,
  maxLockSec:      15 * 60,
  resetAfterHours: 24,
});

export type LoginBackoffPolicy = typeof LOGIN_BACKOFF_POLICY;

/** Key for a login ID: NFC, trimmed, lower-cased, then sha256 (hex). */
export function loginIdHash(loginId: string): string {
  const normalised = loginId.normalize('NFC').trim().toLowerCase();
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/** Seconds until the ID is unlocked, or null when it is not locked. */
export async function lockedRetryAfterSec(pool: Pool, hash: string): Promise<number | null> {
  const { rows } = await pool.query<{ retry_after: number }>(
    `SELECT GREATEST(1, ceil(extract(epoch FROM locked_until - now())))::int AS retry_after
       FROM login_backoff
      WHERE login_hash = $1 AND locked_until > now()`,
    [hash],
  );
  return rows.length > 0 ? rows[0].retry_after : null;
}

// One statement, so concurrent failures for the same ID are serialised by the row lock and none is
// lost. `next` is the failure count after this one; the lock is base * 2^(next - threshold), with the
// exponent clamped so power() cannot overflow, and capped at maxLockSec.
const RECORD_FAILURE_SQL = `
  INSERT INTO login_backoff AS b (login_hash, failures, locked_until, updated_at)
  VALUES ($1, 1, CASE WHEN 1 >= $2::int THEN now() + make_interval(secs => LEAST($3::int, $4::int)) END, now())
  ON CONFLICT (login_hash) DO UPDATE SET
    failures = CASE WHEN b.updated_at < now() - make_interval(hours => $5::int) THEN 1 ELSE b.failures + 1 END,
    locked_until = CASE
      WHEN (CASE WHEN b.updated_at < now() - make_interval(hours => $5::int) THEN 1 ELSE b.failures + 1 END) >= $2::int
      THEN now() + make_interval(secs => LEAST(
             $3::int * power(2, LEAST(
               (CASE WHEN b.updated_at < now() - make_interval(hours => $5::int) THEN 1 ELSE b.failures + 1 END) - $2::int,
               20)),
             $4::int))
      END,
    updated_at = now()
  RETURNING failures, locked_until`;

export async function recordLoginFailure(
  pool: Pool,
  hash: string,
  policy: LoginBackoffPolicy = LOGIN_BACKOFF_POLICY,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const { rows } = await pool.query<{ failures: number; locked_until: Date | null }>(
    RECORD_FAILURE_SQL,
    [hash, policy.threshold, policy.baseLockSec, policy.maxLockSec, policy.resetAfterHours],
  );
  return { failures: rows[0].failures, lockedUntil: rows[0].locked_until };
}

export async function clearLoginFailures(db: Pool | PoolClient, hash: string): Promise<void> {
  await db.query(`DELETE FROM login_backoff WHERE login_hash = $1`, [hash]);
}

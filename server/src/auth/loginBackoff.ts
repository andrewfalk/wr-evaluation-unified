// Per-login-ID failure backoff (SEC-B M2, migration 0039). The IP limiter (5/min) stays in front of
// the route; this counts failures per login ID in the database so attempts spread over several IPs or
// server processes still add up. Unknown login IDs take exactly the same path, so a lockout does not
// tell the caller whether the account exists. Only a hash of the normalised ID is stored.
//
// Policy: every attempt for an unlocked ID is counted as a failure *before* the password is checked
// (claimLoginAttempt), and a success deletes the row. Counting up front is what makes the limit hold
// under concurrency: the claim is one INSERT … ON CONFLICT DO UPDATE, so parallel attempts are
// serialised by the row lock and at most `threshold` of them get past an unlocked ID before the lock
// is set, however many arrive while bcrypt is still running. The 5th attempt sets a 1-minute lock,
// every further attempt after a lock ends doubles it (capped at 15 minutes). A request made while the
// ID is locked is refused without checking the password and does not count. A failure more than 24
// hours after the previous one starts the count again. All times come from the database clock.
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

// One statement: count this attempt unless the ID is locked right now. `next` is the count after this
// attempt (1 again when the previous one is older than resetAfterHours); the lock is
// base * 2^(next - threshold), with the exponent clamped so power() cannot overflow, capped at maxLockSec.
// When the row is locked, the DO UPDATE's WHERE is false and nothing is returned.
const NEXT = `(CASE WHEN b.updated_at < now() - make_interval(hours => $5::int) THEN 1 ELSE b.failures + 1 END)`;
const CLAIM_ATTEMPT_SQL = `
  INSERT INTO login_backoff AS b (login_hash, failures, locked_until, updated_at)
  VALUES ($1, 1, CASE WHEN 1 >= $2::int THEN now() + make_interval(secs => LEAST($3::int, $4::int)) END, now())
  ON CONFLICT (login_hash) DO UPDATE SET
    failures     = ${NEXT},
    locked_until = CASE WHEN ${NEXT} >= $2::int
                        THEN now() + make_interval(secs => LEAST($3::int * power(2, LEAST(${NEXT} - $2::int, 20)), $4::int))
                   END,
    updated_at   = now()
  WHERE b.locked_until IS NULL OR b.locked_until <= now()
  RETURNING failures, locked_until`;

export type LoginAttemptClaim =
  | { allowed: true; failures: number; lockedUntil: Date | null }
  | { allowed: false; retryAfterSec: number };

/**
 * Count an attempt for this ID before its password is checked. Returns allowed: false (and the wait)
 * while the ID is locked; the attempt is then not counted. Call clearLoginFailures on success.
 */
export async function claimLoginAttempt(
  pool: Pool,
  hash: string,
  policy: LoginBackoffPolicy = LOGIN_BACKOFF_POLICY,
): Promise<LoginAttemptClaim> {
  // A lock can end between the claim and the follow-up read; then claim again (bounded).
  for (let i = 0; i < 3; i++) {
    const { rows } = await pool.query<{ failures: number; locked_until: Date | null }>(
      CLAIM_ATTEMPT_SQL,
      [hash, policy.threshold, policy.baseLockSec, policy.maxLockSec, policy.resetAfterHours],
    );
    if (rows.length > 0) return { allowed: true, failures: rows[0].failures, lockedUntil: rows[0].locked_until };
    const retryAfterSec = await lockedRetryAfterSec(pool, hash);
    if (retryAfterSec !== null) return { allowed: false, retryAfterSec };
  }
  return { allowed: false, retryAfterSec: 1 };
}

export async function clearLoginFailures(db: Pool | PoolClient, hash: string): Promise<void> {
  await db.query(`DELETE FROM login_backoff WHERE login_hash = $1`, [hash]);
}

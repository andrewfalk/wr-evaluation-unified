// Cleanup of login backoff rows (SEC-B M2). A row that has not changed for a day and is not locked no
// longer affects anything (the next failure would start counting from 1 anyway), so it is deleted to
// keep failed attempts against unknown IDs from growing the table without bound. Returned as an object
// with stop() so the S9 graceful shutdown can stop it.
import type { Pool } from 'pg';
import { LOGIN_BACKOFF_POLICY } from '../auth/loginBackoff';

export async function sweepLoginBackoff(pool: Pool, olderThanHours = LOGIN_BACKOFF_POLICY.resetAfterHours): Promise<number> {
  const result = await pool.query(
    `DELETE FROM login_backoff
      WHERE updated_at < now() - make_interval(hours => $1)
        AND (locked_until IS NULL OR locked_until <= now())`,
    [olderThanHours],
  );
  return result.rowCount ?? 0;
}

export interface LoginBackoffSweeper {
  stop(): void;
}

export function createLoginBackoffSweeper(
  pool: Pool,
  options: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): LoginBackoffSweeper {
  const { intervalMs = 60 * 60 * 1000, onError = () => undefined } = options;
  const run = () => { sweepLoginBackoff(pool).catch(onError); };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

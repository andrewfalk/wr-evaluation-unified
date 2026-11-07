// Cleanup of EMR audit nonces (SEC-A L11). Rows older than the retention are no longer needed for
// replay protection: a signed request is rejected by its timestamp (±5 minutes) before the nonce is
// looked at. Returned as an object with stop() so the S9 graceful shutdown can stop it (it replaces
// the module-level setInterval that routes/audit.ts used to start on import).
import type { Pool } from 'pg';

export const EMR_AUDIT_NONCE_RETENTION_HOURS = 24;

export async function sweepEmrAuditNonces(pool: Pool, retentionHours = EMR_AUDIT_NONCE_RETENTION_HOURS): Promise<number> {
  const result = await pool.query(
    `DELETE FROM emr_audit_nonces WHERE seen_at < now() - make_interval(hours => $1)`,
    [retentionHours],
  );
  return result.rowCount ?? 0;
}

export interface AuditNonceSweeper {
  stop(): void;
}

export function createAuditNonceSweeper(
  pool: Pool,
  options: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): AuditNonceSweeper {
  const { intervalMs = 60 * 60 * 1000, onError = () => undefined } = options;
  const run = () => { sweepEmrAuditNonces(pool).catch(onError); };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

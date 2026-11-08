import type { Pool } from 'pg';

// Deletes workspaces whose created_at is older than `retentionYears` years.
// Intended to be called by a cron job or admin script (not an HTTP route).
// Default: 5 years per healthcare PHI snapshot retention policy.
// countExpiredWorkspaces uses the same condition for the CLI's --dry-run (SEC-B L12).
const EXPIRED = `created_at < now() - ($1 || ' years')::INTERVAL`;

function checkYears(retentionYears: number): void {
  if (!Number.isInteger(retentionYears) || retentionYears < 1) {
    throw new Error(`retentionYears must be a positive integer, got: ${retentionYears}`);
  }
}

export async function runWorkspaceRetention(
  pool: Pool,
  retentionYears = 5,
): Promise<{ deleted: number }> {
  checkYears(retentionYears);
  const result = await pool.query(`DELETE FROM workspaces WHERE ${EXPIRED}`, [retentionYears]);
  return { deleted: result.rowCount ?? 0 };
}

export async function countExpiredWorkspaces(pool: Pool, retentionYears = 5): Promise<number> {
  checkYears(retentionYears);
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM workspaces WHERE ${EXPIRED}`,
    [retentionYears],
  );
  return rows[0].n;
}

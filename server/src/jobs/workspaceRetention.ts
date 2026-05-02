import type { Pool } from 'pg';

// Deletes workspaces whose created_at is older than `retentionYears` years.
// Intended to be called by a cron job or admin script (not an HTTP route).
// Default: 5 years per healthcare PHI snapshot retention policy.
export async function runWorkspaceRetention(
  pool: Pool,
  retentionYears = 5,
): Promise<{ deleted: number }> {
  if (!Number.isInteger(retentionYears) || retentionYears < 1) {
    throw new Error(`retentionYears must be a positive integer, got: ${retentionYears}`);
  }
  const result = await pool.query(
    `DELETE FROM workspaces WHERE created_at < now() - ($1 || ' years')::INTERVAL`,
    [retentionYears]
  );
  return { deleted: result.rowCount ?? 0 };
}

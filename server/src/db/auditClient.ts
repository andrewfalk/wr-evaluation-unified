import { Pool } from 'pg';

// Separate read-only pool for audit log queries.
// Uses AUDIT_DATABASE_URL (wr_audit_reader role) when configured.
// Falls back to DATABASE_URL only as a last resort — this means /api/admin/audit
// will query with the main app account instead of the restricted reader role.
// In production, always set AUDIT_DATABASE_URL. See docs/BACKUP_RESTORE.md.
if (!process.env.AUDIT_DATABASE_URL) {
  console.warn(
    '[audit-db] AUDIT_DATABASE_URL not set — falling back to DATABASE_URL. ' +
    'Set AUDIT_DATABASE_URL to use the wr_audit_reader read-only role.'
  );
}
const connectionString = process.env.AUDIT_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const auditPool = new Pool({
  connectionString,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

auditPool.on('error', (err) => {
  console.error('[audit-db] Unexpected pool error:', err);
});

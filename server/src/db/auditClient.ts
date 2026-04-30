import { Pool } from 'pg';

// Separate read-only pool for audit log queries.
// Uses AUDIT_DATABASE_URL (wr_audit_reader role) when configured;
// falls back to DATABASE_URL so the server starts even before the
// operator has set the audit reader password.
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

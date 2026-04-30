import { Pool } from 'pg';

// Separate read-only pool for audit log queries (wr_audit_reader role).
// AUDIT_DATABASE_URL is injected by docker-compose via AUDIT_DB_PASSWORD.
// In production/intranet mode the fallback is not allowed — role separation
// must be enforced. In development/test the fallback to DATABASE_URL is
// permitted so the server starts without pre-configuring the reader role.
const isStrictEnv =
  process.env.NODE_ENV === 'production' ||
  process.env.DEPLOYMENT_MODE === 'intranet';

if (!process.env.AUDIT_DATABASE_URL) {
  if (isStrictEnv) {
    throw new Error(
      'AUDIT_DATABASE_URL is required in production/intranet mode. ' +
      'Set AUDIT_DB_PASSWORD in .env and ensure migration 0004 has run.'
    );
  }
  console.warn(
    '[audit-db] AUDIT_DATABASE_URL not set — falling back to DATABASE_URL ' +
    '(development only). Set AUDIT_DB_PASSWORD in .env for production.'
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

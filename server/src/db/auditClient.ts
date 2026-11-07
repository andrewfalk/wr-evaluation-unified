import { Pool } from 'pg';
import config from '../config';

// Separate read-only pool for audit log queries (wr_audit_reader role).
// AUDIT_DATABASE_URL is injected by docker-compose via AUDIT_DB_PASSWORD.
// In production/intranet mode the fallback is not allowed — role separation
// must be enforced. In development/test the fallback to DATABASE_URL is
// permitted so the server starts without pre-configuring the reader role.
//
// Created by the process entry point (index.ts) rather than at import time
// (REFACTORING_ROADMAP P0-3); the checks below are unchanged.
export type AuditPoolSettings = Pick<typeof config, 'env' | 'deploymentMode' | 'databaseUrl' | 'auditDatabaseUrl'>;

export function createAuditPool(settings: AuditPoolSettings = config): Pool {
  const isStrictEnv =
    settings.env === 'production' ||
    settings.deploymentMode === 'intranet';

  if (!settings.auditDatabaseUrl) {
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

  const connectionString = settings.auditDatabaseUrl ?? settings.databaseUrl;

  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const auditPool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  auditPool.on('error', (err) => {
    console.error('[audit-db] Unexpected pool error:', err);
  });

  return auditPool;
}

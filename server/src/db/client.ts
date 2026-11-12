import { Pool } from 'pg';
import { logger } from '../logger';

// Main application pool. Created by the process entry points (index.ts, cli/*) rather than at
// import time, so importing modules (e.g. app.ts in tests) never opens a database pool
// (REFACTORING_ROADMAP P0-3).
// The caller passes the URL: index.ts → config.databaseUrl; the CLIs (cli/*) read DATABASE_URL
// themselves so they do not need the server's other required settings (P1-10).
export function createPool(connectionString: string | undefined): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, '[db] unexpected pool error');
  });

  return pool;
}

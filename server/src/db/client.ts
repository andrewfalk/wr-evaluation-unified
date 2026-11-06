import { Pool } from 'pg';

// Main application pool. Created by the process entry points (index.ts, cli/*) rather than at
// import time, so importing modules (e.g. app.ts in tests) never opens a database pool
// (REFACTORING_ROADMAP P0-3).
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
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
    console.error('[db] Unexpected pool error:', err);
  });

  return pool;
}

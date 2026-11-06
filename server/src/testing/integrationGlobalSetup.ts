// Global setup for the real-Postgres integration tests (vitest.integration.config.ts).
// REFACTORING_ROADMAP P0-10 / P0-2.
//
// 1. No TEST_DATABASE_URL: the test files skip themselves (describe.skipIf). That is fine for a
//    quick local run, but when WR_REQUIRE_INTEGRATION=1 (set by `npm run check:full`) a missing
//    database must fail instead of silently skipping.
// 2. Only a dedicated test database is accepted — its name must start with `wr_test`. This setup
//    applies pending migrations, and the stats queue tests start real workers that claim any
//    queued job regardless of fixture or organization (statsRunsQueue.ts). Pointed at the
//    development or production database (`wr_evaluation`), the run could change its schema or
//    process someone else's work, so it is refused before connecting.
// 3. Apply migrations (idempotent), so every run starts from the current schema.
import { Client, Pool } from 'pg';
import { runMigrations } from '../db/migrate';

// The database pg will actually connect to. Read from pg's own parser (a Client that is never
// connected) rather than the URL path: in `socket:/dir?db=name` the path is the socket
// directory and `db` is the database (Codex review of #192), and PGDATABASE fills a missing name.
export function testDatabaseName(url: string): string {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL.');
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new Error(`TEST_DATABASE_URL must be a postgres:// or postgresql:// URL (got "${protocol}").`);
  }
  return new Client({ connectionString: url }).database ?? '';
}

export function assertDedicatedTestDatabase(url: string): void {
  const name = testDatabaseName(url);
  if (!/^wr_test/.test(name)) {
    throw new Error(
      `TEST_DATABASE_URL points at database "${name}". Integration tests run only against a dedicated ` +
      'test database whose name starts with "wr_test" (they apply migrations and start workers that ' +
      'claim any queued job). Use `npm run check:full`, which starts a throwaway one.',
    );
  }
}

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    if (process.env.WR_REQUIRE_INTEGRATION === '1') {
      throw new Error('WR_REQUIRE_INTEGRATION=1 but TEST_DATABASE_URL is not set — integration tests would be skipped.');
    }
    console.warn('[integration] TEST_DATABASE_URL is not set — integration test files will skip. Use `npm run check:full` to run them.');
    return;
  }
  assertDedicatedTestDatabase(url);
  const pool = new Pool({ connectionString: url });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

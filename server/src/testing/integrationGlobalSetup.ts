// Global setup for the real-Postgres integration tests (vitest.integration.config.ts).
// REFACTORING_ROADMAP P0-10 / P0-2.
//
// 1. No TEST_DATABASE_URL: the test files skip themselves (describe.skipIf). That is fine for a
//    quick local run, but when WR_REQUIRE_INTEGRATION=1 (set by `npm run check:full`) a missing
//    database must fail instead of silently skipping.
// 2. Only a dedicated test database is accepted — its name must start with `wr_test`. This setup
//    applies pending migrations, and the stats queue tests start real workers that claim any
//    queued job regardless of fixture or organization (stats/queue/runsQueue.ts). Pointed at the
//    development or production database (`wr_evaluation`), the run could change its schema or
//    process someone else's work, so it is refused before connecting.
// 3. Prepare the database. With the four role URLs (`npm run check:full` sets them — M9) it takes the production
//    path, cli/dbSetup.ts: roles and ownership as the superuser (TEST_ADMIN_DATABASE_URL) → migrations as wr_owner
//    (TEST_OWNER_DATABASE_URL) → grants → verification. The tests then run as wr_app (TEST_DATABASE_URL), audit reads
//    go through wr_audit_reader (TEST_AUDIT_DATABASE_URL), and only what needs more (creating databases, superuser
//    settings) uses the admin URL. With TEST_DATABASE_URL alone (a quick local run) it applies the migrations with that
//    URL as before; the role tests then skip with a warning.
import { Client, Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { runDbSetup } from '../cli/dbSetup';

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

export function assertDedicatedTestDatabase(url: string, variable = 'TEST_DATABASE_URL'): void {
  const name = testDatabaseName(url);
  if (!/^wr_test/.test(name)) {
    throw new Error(
      `${variable} points at database "${name}". Integration tests run only against a dedicated ` +
      'test database whose name starts with "wr_test" (they apply migrations and start workers that ' +
      'claim any queued job). Use `npm run check:full`, which starts a throwaway one.',
    );
  }
}

export interface IntegrationUrls {
  /** wr_app — what the tests and the app under test use */
  app: string;
  /** superuser — creating databases, superuser-only settings; null in single-URL mode */
  admin: string | null;
  owner: string | null;
  audit: string | null;
}

/** Reads the URLs: all four (role-separated) or TEST_DATABASE_URL alone. Anything in between is an error. */
export function readIntegrationUrls(env: NodeJS.ProcessEnv): IntegrationUrls | null {
  const app = env.TEST_DATABASE_URL || null;
  const admin = env.TEST_ADMIN_DATABASE_URL || null;
  const owner = env.TEST_OWNER_DATABASE_URL || null;
  const audit = env.TEST_AUDIT_DATABASE_URL || null;
  if (!app) {
    if (admin || owner || audit) throw new Error('TEST_ADMIN/OWNER/AUDIT_DATABASE_URL are set but TEST_DATABASE_URL (wr_app) is not.');
    return null;
  }
  const extra = [admin, owner, audit].filter(Boolean).length;
  if (extra !== 0 && extra !== 3) {
    throw new Error('Set TEST_ADMIN_DATABASE_URL, TEST_OWNER_DATABASE_URL and TEST_AUDIT_DATABASE_URL together (or none of them).');
  }
  return { app, admin, owner, audit };
}

async function isSuperuser(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ s: boolean }>('SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user');
    return rows[0].s;
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<void> {
  const required = process.env.WR_REQUIRE_INTEGRATION === '1';
  const urls = readIntegrationUrls(process.env);
  if (!urls) {
    if (required) {
      throw new Error('WR_REQUIRE_INTEGRATION=1 but TEST_DATABASE_URL is not set — integration tests would be skipped.');
    }
    console.warn('[integration] TEST_DATABASE_URL is not set — integration test files will skip. Use `npm run check:full` to run them.');
    return;
  }
  assertDedicatedTestDatabase(urls.app);

  if (!urls.admin) {
    // check:full always runs role-separated: a superuser TEST_DATABASE_URL would make every privilege test pass
    // for the wrong reason.
    if (required) {
      throw new Error('WR_REQUIRE_INTEGRATION=1 needs the role-separated URLs (TEST_ADMIN/OWNER/AUDIT_DATABASE_URL) — use `npm run check:full`.');
    }
    const pool = new Pool({ connectionString: urls.app });
    try {
      await runMigrations(pool);
    } finally {
      await pool.end();
    }
    return;
  }

  assertDedicatedTestDatabase(urls.admin, 'TEST_ADMIN_DATABASE_URL');
  assertDedicatedTestDatabase(urls.owner!, 'TEST_OWNER_DATABASE_URL');
  assertDedicatedTestDatabase(urls.audit!, 'TEST_AUDIT_DATABASE_URL');
  await runDbSetup({
    BOOTSTRAP_DATABASE_URL: urls.admin,
    MIGRATION_DATABASE_URL: urls.owner!,
    DATABASE_URL: urls.app,
    AUDIT_DATABASE_URL: urls.audit!,
  }, { waitForMs: 0, log: { info: () => undefined, warn: (m: unknown) => console.warn(m) } });
  if (await isSuperuser(urls.app)) {
    throw new Error('TEST_DATABASE_URL connects as a superuser — the integration tests must run as wr_app.');
  }
}

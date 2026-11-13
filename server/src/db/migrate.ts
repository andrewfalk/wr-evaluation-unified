import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { logger } from '../logger';

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

// Fixed advisory lock key for migration serialization across concurrent processes
const MIGRATION_LOCK_KEY = 7_369_276;

// Migration checksums (REFACTORING_ROADMAP S10 / P1-36). Every applied migration records the
// sha256 of its file; each run compares the files on disk with what was applied:
//   - checksum NULL (applied before checksums existed) → filled with the current file's hash on
//     the first run, in either mode — NULL means "not recorded", not "changed".
//   - different checksum → 'enforce' refuses to run (the server does not start, the CLI exits 1)
//     before any pending migration is applied; 'warn' logs and carries on.
//   - applied file missing from the folder → logged in either mode (e.g. an older image started
//     against a newer database); it is not compared.
// Default is 'enforce'. 7.2.0 set MIGRATION_CHECKSUM_MODE=warn in docker-compose.yml so the first release only
// reported; 7.3.0 removed it, so compose deployments enforce.
export type MigrationChecksumMode = 'warn' | 'enforce';

export function resolveChecksumMode(raw: string | undefined): MigrationChecksumMode {
  const value = raw?.trim();
  if (!value) return 'enforce';
  if (value === 'warn' || value === 'enforce') return value;
  throw new Error(`MIGRATION_CHECKSUM_MODE must be "warn" or "enforce" (got "${raw}").`);
}

// sha256 of the file text with CRLF folded to LF, so a checkout with Windows line endings does
// not count as a changed migration.
export function migrationChecksum(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export class MigrationChecksumError extends Error {
  constructor(readonly filenames: string[]) {
    super(
      `[migrate] Applied migration file(s) changed since they were applied: ${filenames.join(', ')}. ` +
      'Applied migrations must not be edited — restore the original file and add a new migration ' +
      'instead (MIGRATION_CHECKSUM_MODE=enforce).',
    );
    this.name = 'MigrationChecksumError';
  }
}

type MigrationLog = Pick<Console, 'log' | 'warn'>;

// The migration messages ([migrate] Applied: …) as logger lines (S11) — what the server and `npm run migrate` print.
const MIGRATION_LOGGER: MigrationLog = {
  log: (message: string) => logger.info(message),
  warn: (message: string) => logger.warn(message),
};

export interface RunMigrationsOptions {
  // Default: MIGRATION_CHECKSUM_MODE from the environment, else 'enforce'.
  checksumMode?: MigrationChecksumMode;
  // Default: server/migrations. Tests point this at a copy.
  migrationsDir?: string;
  log?: MigrationLog;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Added by the runner rather than a numbered migration: a database at any earlier version, or an
  // empty one, gets the column before the runner reads it (P1-36).
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

// Compares the applied migrations with the files, backfills missing checksums and returns the
// applied filenames. Throws MigrationChecksumError in 'enforce' mode when a file changed.
async function checkAppliedMigrations(
  client: PoolClient,
  dir: string,
  mode: MigrationChecksumMode,
  log: MigrationLog,
): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string; checksum: string | null }>(
    'SELECT filename, checksum FROM schema_migrations ORDER BY filename'
  );
  const changed: string[] = [];
  const missing: string[] = [];
  let backfilled = 0;
  for (const row of rows) {
    const file = path.join(dir, row.filename);
    if (!fs.existsSync(file)) {
      missing.push(row.filename);
      continue;
    }
    const current = migrationChecksum(fs.readFileSync(file, 'utf8'));
    if (row.checksum === null) {
      await client.query(
        'UPDATE schema_migrations SET checksum = $2 WHERE filename = $1 AND checksum IS NULL',
        [row.filename, current]
      );
      backfilled += 1;
    } else if (row.checksum !== current) {
      changed.push(row.filename);
    }
  }
  if (backfilled > 0) {
    log.log(`[migrate] Recorded checksums for ${backfilled} previously applied migration(s).`);
  }
  if (missing.length > 0) {
    log.warn(`[migrate] Applied migration file(s) not found in ${dir}: ${missing.join(', ')}`);
  }
  if (changed.length > 0) {
    if (mode === 'enforce') throw new MigrationChecksumError(changed);
    log.warn(
      `[migrate] Applied migration file(s) changed since they were applied: ${changed.join(', ')} ` +
      '(MIGRATION_CHECKSUM_MODE=warn — continuing).'
    );
  }
  return new Set(rows.map((r) => r.filename));
}

async function applyMigration(client: PoolClient, dir: string, file: string, log: MigrationLog): Promise<void> {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations(filename, checksum) VALUES($1, $2)',
      [file, migrationChecksum(sql)]
    );
    await client.query('COMMIT');
    log.log(`[migrate] Applied: ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function runMigrations(pool: Pool, options: RunMigrationsOptions = {}): Promise<void> {
  // Resolved before connecting: a mistyped mode stops start-up without touching the database.
  const mode = options.checksumMode ?? resolveChecksumMode(process.env.MIGRATION_CHECKSUM_MODE);
  const dir = options.migrationsDir ?? MIGRATIONS_DIR;
  const log = options.log ?? MIGRATION_LOGGER;
  const client = await pool.connect();
  try {
    // Serialize concurrent migration runners (e.g. multi-instance deploys)
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await ensureMigrationsTable(client);

      const applied = await checkAppliedMigrations(client, dir, mode, log);
      const pending = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .filter((f) => !applied.has(f));

      if (pending.length === 0) {
        log.log('[migrate] No pending migrations.');
        return;
      }

      for (const file of pending) {
        await applyMigration(client, dir, file, log);
      }
      log.log(`[migrate] Done. Applied ${pending.length} migration(s).`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// --- Read-only check for a server that does not migrate (M9) ---------------------------------------------------
// With role separation the server connects as wr_app, which cannot run DDL; the one-shot `migrate` service (cli/
// dbSetup.ts) applies the migrations as wr_owner before the app starts. On start-up the server only checks, with a
// single SELECT and no lock, that the database is current. The same file checks as runMigrations (enforce / warn,
// missing files), except that it cannot record a missing checksum.

const RUN_MIGRATE_HINT =
  'Run the database setup — `docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm migrate` ' +
  '(plain `docker compose up -d` runs it first) — and start the server again. The server applies migrations ' +
  'itself only with AUTO_MIGRATE=true (the default outside NODE_ENV=production).';

export class MigrationsPendingError extends Error {
  constructor(readonly filenames: string[]) {
    super(`[migrate] ${filenames.length} migration(s) not applied: ${filenames.join(', ')}. ${RUN_MIGRATE_HINT}`);
    this.name = 'MigrationsPendingError';
  }
}

export async function assertMigrationsApplied(pool: Pool, options: RunMigrationsOptions = {}): Promise<void> {
  // Resolved before connecting, as in runMigrations.
  const mode = options.checksumMode ?? resolveChecksumMode(process.env.MIGRATION_CHECKSUM_MODE);
  const dir = options.migrationsDir ?? MIGRATIONS_DIR;
  const log = options.log ?? MIGRATION_LOGGER;

  let rows: Array<{ filename: string; checksum: string | null }>;
  try {
    rows = (await pool.query<{ filename: string; checksum: string | null }>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename'
    )).rows;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const what =
      code === '42P01' ? 'the table schema_migrations does not exist (the database was never migrated)'
      : code === '42703' ? 'schema_migrations has no checksum column (the database predates 7.2.0)'
      : code === '42501' ? 'the DATABASE_URL role may not read schema_migrations (grants not applied)'
      : null;
    if (!what) throw err;
    const wrapped = new Error(`[migrate] Cannot check the applied migrations: ${what}. ${RUN_MIGRATE_HINT}`);
    (wrapped as { cause?: unknown }).cause = err;
    throw wrapped;
  }

  const changed: string[] = [];
  const missing: string[] = [];
  const unrecorded: string[] = [];
  for (const row of rows) {
    const file = path.join(dir, row.filename);
    if (!fs.existsSync(file)) {
      missing.push(row.filename);
      continue;
    }
    if (row.checksum === null) {
      unrecorded.push(row.filename);
    } else if (row.checksum !== migrationChecksum(fs.readFileSync(file, 'utf8'))) {
      changed.push(row.filename);
    }
  }
  if (unrecorded.length > 0) {
    log.warn(`[migrate] Checksum not recorded for ${unrecorded.length} applied migration(s): ${unrecorded.join(', ')} (the database setup records them).`);
  }
  if (missing.length > 0) {
    log.warn(`[migrate] Applied migration file(s) not found in ${dir}: ${missing.join(', ')}`);
  }
  if (changed.length > 0) {
    if (mode === 'enforce') throw new MigrationChecksumError(changed);
    log.warn(
      `[migrate] Applied migration file(s) changed since they were applied: ${changed.join(', ')} ` +
      '(MIGRATION_CHECKSUM_MODE=warn — continuing).'
    );
  }

  const applied = new Set(rows.map((r) => r.filename));
  const pending = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().filter((f) => !applied.has(f));
  if (pending.length > 0) throw new MigrationsPendingError(pending);
}

// CLI entry point: tsx src/db/migrate.ts — MIGRATION_DATABASE_URL (the owner role, M9) or else DATABASE_URL.
if (require.main === module) {
  const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    logger.fatal('[migrate] MIGRATION_DATABASE_URL or DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString });
  runMigrations(pool)
    .then(() => pool.end())
    .catch((err) => {
      logger.fatal({ err }, '[migrate] fatal');
      process.exit(1);
    });
}

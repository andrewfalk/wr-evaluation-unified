import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

// Fixed advisory lock key for migration serialization across concurrent processes
const MIGRATION_LOCK_KEY = 7_369_276;

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  return new Set(rows.map((r) => r.filename));
}

async function applyMigration(client: PoolClient, file: string): Promise<void> {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations(filename) VALUES($1)',
      [file]
    );
    await client.query('COMMIT');
    console.log(`[migrate] Applied: ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialize concurrent migration runners (e.g. multi-instance deploys)
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await ensureMigrationsTable(client);

      const applied = await getAppliedMigrations(client);
      const pending = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .filter((f) => !applied.has(f));

      if (pending.length === 0) {
        console.log('[migrate] No pending migrations.');
        return;
      }

      for (const file of pending) {
        await applyMigration(client, file);
      }
      console.log(`[migrate] Done. Applied ${pending.length} migration(s).`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// CLI entry point: tsx src/db/migrate.ts
if (require.main === module) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[migrate] DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString });
  runMigrations(pool)
    .then(() => pool.end())
    .catch((err) => {
      console.error('[migrate] Fatal:', err);
      process.exit(1);
    });
}

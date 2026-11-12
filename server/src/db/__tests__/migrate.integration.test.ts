// Migration checksums against a real database (REFACTORING_ROADMAP S10 / P1-36).
//
// Each run of this file creates its own throwaway database next to the test database (so the
// shared test schema is never rewound), brings it to the 0037 state the way the runner before
// P1-36 left production — schema_migrations without a checksum column — and then runs the
// current runner over it. The database is dropped in afterAll.
//
// Runs only with TEST_DATABASE_URL (npm run check:full); skipped otherwise.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client, Pool } from 'pg';
import { runMigrations, migrationChecksum, MigrationChecksumError } from '../migrate';
import { logger } from '../../logger';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const REAL_DIR = path.resolve(__dirname, '../../../migrations');
const PRE_CHECKSUM_LAST = 37; // 0037 — the last migration before 7.2.0

function capture() {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logs,
    warns,
    log: {
      log: (...args: unknown[]) => { logs.push(args.join(' ')); },
      warn: (...args: unknown[]) => { warns.push(args.join(' ')); },
    },
  };
}

function migrationFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

// A writable copy of the real migrations folder, for the tests that edit files.
function copyMigrations(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-p136-migrations-'));
  for (const f of migrationFiles(REAL_DIR)) fs.copyFileSync(path.join(REAL_DIR, f), path.join(dir, f));
  return dir;
}

describe.skipIf(!TEST_DB_URL)('runMigrations — checksums on a real database (integration)', () => {
  const dbName = `wr_test_p136_${process.pid}_${Date.now()}`;
  let admin: Client;
  let pool: Pool;
  const tmpDirs: string[] = [];

  async function checksums(): Promise<Map<string, string | null>> {
    const { rows } = await pool.query<{ filename: string; checksum: string | null }>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename'
    );
    return new Map(rows.map((r) => [r.filename, r.checksum]));
  }

  async function tableExists(name: string): Promise<boolean> {
    const { rows } = await pool.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [name]);
    return rows[0].exists;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(TEST_DB_URL!);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString() });

    // The 0037 state as the old runner left it: its table (no checksum column) and 0001–0037.
    await pool.query(`
      CREATE TABLE schema_migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const f of migrationFiles(REAL_DIR)) {
      if (Number(f.slice(0, 4)) > PRE_CHECKSUM_LAST) break;
      await pool.query(fs.readFileSync(path.join(REAL_DIR, f), 'utf8'));
      await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)', [f]);
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades a 0037-state database in one run: adds the column, backfills, applies the rest with checksums', async () => {
    const before = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'checksum'"
    );
    expect(before.rowCount).toBe(0);

    const out = capture();
    await runMigrations(pool, { checksumMode: 'enforce', log: out.log });

    const files = migrationFiles(REAL_DIR);
    const stored = await checksums();
    expect([...stored.keys()]).toEqual(files);
    for (const f of files) {
      expect(stored.get(f)).toBe(migrationChecksum(fs.readFileSync(path.join(REAL_DIR, f), 'utf8')));
    }
    expect(out.logs).toContain(`[migrate] Recorded checksums for ${PRE_CHECKSUM_LAST} previously applied migration(s).`);
    expect(out.logs).toContain(`[migrate] Applied: ${files[files.length - 1]}`);
    expect(out.warns).toEqual([]);
  });

  it('is a no-op on the next run', async () => {
    const before = await checksums();
    const out = capture();
    await runMigrations(pool, { checksumMode: 'enforce', log: out.log });
    expect(out.logs).toEqual(['[migrate] No pending migrations.']);
    expect(out.warns).toEqual([]);
    expect(await checksums()).toEqual(before);
  });

  it('without an injected log, the messages go to the server logger (S11)', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await runMigrations(pool, { checksumMode: 'enforce' });
      expect(info).toHaveBeenCalledWith('[migrate] No pending migrations.');
    } finally {
      info.mockRestore();
    }
  });

  it('does not count CRLF line endings as a change', async () => {
    const dir = copyMigrations();
    tmpDirs.push(dir);
    for (const f of migrationFiles(dir)) {
      const file = path.join(dir, f);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    const out = capture();
    await runMigrations(pool, { checksumMode: 'enforce', migrationsDir: dir, log: out.log });
    expect(out.warns).toEqual([]);
  });

  it('reports an applied file that is missing without failing, in enforce mode too', async () => {
    const dir = copyMigrations();
    tmpDirs.push(dir);
    const gone = migrationFiles(dir)[6];
    fs.rmSync(path.join(dir, gone));
    const out = capture();
    await runMigrations(pool, { checksumMode: 'enforce', migrationsDir: dir, log: out.log });
    expect(out.warns).toHaveLength(1);
    expect(out.warns[0]).toContain(gone);
  });

  describe('an applied file edited after it was applied', () => {
    let dir: string;
    let edited: string;
    let original: string | null | undefined;

    beforeAll(async () => {
      dir = copyMigrations();
      tmpDirs.push(dir);
      edited = migrationFiles(dir)[4];
      fs.appendFileSync(path.join(dir, edited), '\n-- edited after it was applied\n');
      // A new migration after it: enforce must stop before applying it.
      fs.writeFileSync(path.join(dir, '9999_p136_probe.sql'), 'CREATE TABLE p136_probe (id int);\n');
      original = (await checksums()).get(edited);
    });

    it('enforce: fails before applying anything and keeps the recorded checksum', async () => {
      const out = capture();
      const run = runMigrations(pool, { checksumMode: 'enforce', migrationsDir: dir, log: out.log });
      await expect(run).rejects.toBeInstanceOf(MigrationChecksumError);
      await expect(run).rejects.toMatchObject({ filenames: [edited] });
      expect(await tableExists('p136_probe')).toBe(false);
      const stored = await checksums();
      expect(stored.has('9999_p136_probe.sql')).toBe(false);
      expect(stored.get(edited)).toBe(original);
    });

    it('warn: logs the file, applies the pending migration and keeps the recorded checksum', async () => {
      const out = capture();
      await runMigrations(pool, { checksumMode: 'warn', migrationsDir: dir, log: out.log });
      expect(out.warns).toHaveLength(1);
      expect(out.warns[0]).toContain(edited);
      expect(await tableExists('p136_probe')).toBe(true);
      const stored = await checksums();
      expect(stored.get('9999_p136_probe.sql')).toBe(migrationChecksum('CREATE TABLE p136_probe (id int);\n'));
      expect(stored.get(edited)).toBe(original);
    });

    it('takes the mode from MIGRATION_CHECKSUM_MODE when no option is given', async () => {
      const saved = process.env.MIGRATION_CHECKSUM_MODE;
      try {
        process.env.MIGRATION_CHECKSUM_MODE = 'enforce';
        await expect(runMigrations(pool, { migrationsDir: dir, log: capture().log }))
          .rejects.toBeInstanceOf(MigrationChecksumError);
        process.env.MIGRATION_CHECKSUM_MODE = 'warn';
        await expect(runMigrations(pool, { migrationsDir: dir, log: capture().log })).resolves.toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env.MIGRATION_CHECKSUM_MODE;
        else process.env.MIGRATION_CHECKSUM_MODE = saved;
      }
    });
  });
});

// M9 — database role separation on a real PostgreSQL (REFACTORING_ROADMAP M9; the plan's §4 merge conditions).
//
// Every database here is a throwaway created next to the test database and dropped in afterAll:
//   new     — empty database → runDbSetup (bootstrapRoles → migrations as wr_owner → applyGrants → verify); the
//             privilege tests run against it as wr_app / wr_audit_reader
//   legacy  — migrations as the superuser (every object superuser-owned, as 7.2.0 left production) → bootstrapRoles
//             → applyGrants → verify
//   rolesonly — runDbSetup --roles-only: roles and database owner only, no schema
//
// The roles are cluster-wide; their URLs are the suite's own (`npm run check:full` sets all four:
// TEST_ADMIN_DATABASE_URL superuser, TEST_OWNER_DATABASE_URL, TEST_DATABASE_URL = wr_app, TEST_AUDIT_DATABASE_URL),
// pointed at each throwaway database with the same passwords — so bootstrapping these databases never changes a
// password the rest of the suite uses. A local run with TEST_DATABASE_URL alone skips this file with a warning.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client, Pool } from 'pg';
import { runDbSetup } from '../../cli/dbSetup';
import { bootstrapRoles, type RoleUrls } from '../roles/bootstrapRoles';
import { applyGrants } from '../roles/applyGrants';
import { verifyRoleSeparation } from '../roles/verifyRoleSeparation';
import { assertAuditWritable, assertLeastPrivilege, StartupCheckError } from '../roles/startupChecks';
import { APP_ROLE, MANAGED_ROLES, OWNER_ROLE } from '../roles/policy';
import {
  assertMigrationsApplied, migrationChecksum, MigrationChecksumError, MigrationsPendingError, runMigrations,
} from '../migrate';
import { writeAuditLogStrict } from '../../middleware/audit';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const ROLE_URLS = {
  owner: process.env.TEST_OWNER_DATABASE_URL,
  app: process.env.TEST_DATABASE_URL,
  reader: process.env.TEST_AUDIT_DATABASE_URL,
};
const RUNNABLE = Boolean(ADMIN_URL && ROLE_URLS.owner && ROLE_URLS.app && ROLE_URLS.reader);
if (process.env.TEST_DATABASE_URL && !RUNNABLE) {
  console.warn('[integration] roles.integration.test.ts skipped: needs TEST_ADMIN_DATABASE_URL, TEST_OWNER_DATABASE_URL and TEST_AUDIT_DATABASE_URL (run `npm run check:full`).');
}

const REAL_DIR = path.resolve(__dirname, '../../../migrations');
const PARTITION_SCRIPT = path.resolve(__dirname, '../../../../scripts/audit-partition.sh');
const QUIET = { log: () => undefined, warn: () => undefined, info: () => undefined };

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

// scripts/audit-partition.sh's SQL as the sidecar runs it (as wr_owner), anchored at `month` instead of now() so
// the partitions it creates are ones nothing else uses.
function partitionSql(month: string): string {
  const script = fs.readFileSync(PARTITION_SCRIPT, 'utf8').replace(/\r\n/g, '\n');
  const sql = /<<'ENDSQL'\n([\s\S]*?)\nENDSQL/.exec(script)?.[1] ?? '';
  if (!sql.includes("date_trunc('month', now())")) throw new Error('audit-partition.sh no longer has the expected SQL');
  return sql.replace("date_trunc('month', now())", `date_trunc('month', timestamptz '${month}')`);
}

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? `no code: ${(err as Error).message}`;
  }
}

describe.skipIf(!RUNNABLE)('M9 role separation (integration)', () => {
  const tag = `${process.pid}_${Date.now()}`;
  const dbNew = `wr_test_m9_new_${tag}`;
  const dbLegacy = `wr_test_m9_legacy_${tag}`;
  const dbRolesOnly = `wr_test_m9_roles_${tag}`;
  const dbNoChecksum = `wr_test_m9_nock_${tag}`;
  let admin: Client;
  const pools: Pool[] = [];
  const tmpDirs: string[] = [];

  function roleUrls(db: string): RoleUrls {
    return {
      ownerUrl: withDatabase(ROLE_URLS.owner!, db),
      appUrl: withDatabase(ROLE_URLS.app!, db),
      readerUrl: withDatabase(ROLE_URLS.reader!, db),
    };
  }
  function pool(url: string): Pool {
    const p = new Pool({ connectionString: url, max: 3 });
    pools.push(p);
    return p;
  }
  function setupEnv(db: string) {
    const urls = roleUrls(db);
    return {
      BOOTSTRAP_DATABASE_URL: withDatabase(ADMIN_URL!, db),
      MIGRATION_DATABASE_URL: urls.ownerUrl,
      DATABASE_URL: urls.appUrl,
      AUDIT_DATABASE_URL: urls.readerUrl,
    };
  }

  // new database
  let adminNew: Pool;
  let ownerNew: Pool;
  let appNew: Pool;
  let readerNew: Pool;
  let firstSetup: Awaited<ReturnType<typeof runDbSetup>>;
  // legacy database
  let adminLegacy: Pool;
  let ownerLegacy: Pool;
  let appLegacy: Pool;
  let legacyOwnersBefore: string[];

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const su = await admin.query<{ s: boolean }>('SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user');
    if (!su.rows[0].s) throw new Error('roles.integration needs a superuser admin URL (TEST_ADMIN_DATABASE_URL).');
    for (const db of [dbNew, dbLegacy, dbRolesOnly, dbNoChecksum]) await admin.query(`CREATE DATABASE "${db}"`);

    // new: the path every `docker compose up` takes.
    firstSetup = await runDbSetup(setupEnv(dbNew), { log: QUIET });
    const urls = roleUrls(dbNew);
    adminNew = pool(withDatabase(ADMIN_URL!, dbNew));
    ownerNew = pool(urls.ownerUrl);
    appNew = pool(urls.appUrl);
    readerNew = pool(urls.readerUrl);

    // legacy: 7.2.0 production — everything applied and owned by the bootstrap superuser.
    adminLegacy = pool(withDatabase(ADMIN_URL!, dbLegacy));
    await runMigrations(adminLegacy, { log: QUIET });
    legacyOwnersBefore = (await adminLegacy.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'S')`,
    )).rows.map((r) => r.owner);
    const legacyUrls = roleUrls(dbLegacy);
    await bootstrapRoles(adminLegacy, legacyUrls, { log: QUIET });
    ownerLegacy = pool(legacyUrls.ownerUrl);
    appLegacy = pool(legacyUrls.appUrl);
    await applyGrants(ownerLegacy, { log: QUIET });
  });

  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => undefined);
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    if (admin) {
      for (const db of [dbNew, dbLegacy, dbRolesOnly, dbNoChecksum]) {
        await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
      }
      await admin.end();
    }
  });

  // ---- structure ------------------------------------------------------------------------------------------------

  it('the three roles are plain login roles with no membership', async () => {
    const { rows } = await adminNew.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [MANAGED_ROLES],
    );
    expect(rows).toEqual([...MANAGED_ROLES].sort().map((rolname) => ({
      rolname, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true,
    })));
    const members = await adminNew.query(
      `SELECT 1 FROM pg_auth_members WHERE pg_get_userbyid(roleid) = ANY($1) OR pg_get_userbyid(member) = ANY($1)`,
      [MANAGED_ROLES],
    );
    expect(members.rows).toEqual([]);
  });

  it('new path: an empty database migrated as wr_owner is role-separated — every object owned by wr_owner', async () => {
    expect(await verifyRoleSeparation(adminNew)).toEqual([]);
    const owners = await adminNew.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = 'public'::regnamespace`,
    );
    expect(owners.rows.map((r) => r.owner)).toEqual([OWNER_ROLE]);
    const dbOwner = await adminNew.query<{ o: string }>('SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = current_database()');
    expect(dbOwner.rows[0].o).toBe(OWNER_ROLE);
    expect(firstSetup.grantChanges.length).toBeGreaterThan(0);
  });

  it('legacy path: superuser-owned objects are moved to wr_owner and the database verifies clean', async () => {
    expect(legacyOwnersBefore).not.toContain(OWNER_ROLE);
    expect(await verifyRoleSeparation(adminLegacy)).toEqual([]);
    // The reader's grant from 0004 survived the owner change.
    const reader = pool(roleUrls(dbLegacy).readerUrl);
    expect(await sqlState(reader.query('SELECT count(*) FROM audit_logs'))).toBe('ok');
  });

  it('legacy path: the partition sidecar, as wr_owner, can add a partition, and wr_app cannot touch it', async () => {
    await ownerLegacy.query(partitionSql('2042-05-15'));
    expect(await sqlState(appLegacy.query('SELECT * FROM audit_logs_2042_05'))).toBe('42501');
    expect(await sqlState(appLegacy.query('ALTER TABLE users ADD COLUMN m9_x int'))).toBe('42501');
    expect(await verifyRoleSeparation(ownerLegacy)).toEqual([]);
  });

  it('idempotent: a second bootstrapRoles / applyGrants / runDbSetup changes nothing', async () => {
    expect(await bootstrapRoles(adminNew, roleUrls(dbNew), { log: QUIET })).toEqual([]);
    expect(await applyGrants(ownerNew, { log: QUIET })).toEqual([]);
    expect(await runDbSetup(setupEnv(dbNew), { log: QUIET })).toEqual({ roleChanges: [], grantChanges: [] });
    expect(await bootstrapRoles(adminLegacy, roleUrls(dbLegacy), { log: QUIET })).toEqual([]);
    expect(await applyGrants(ownerLegacy, { log: QUIET })).toEqual([]);
  });

  it('--roles-only: roles and the database owner only — no schema_migrations', async () => {
    await runDbSetup(setupEnv(dbRolesOnly), { rolesOnly: true, log: QUIET });
    const p = pool(withDatabase(ADMIN_URL!, dbRolesOnly));
    const { rows: [r] } = await p.query<{ owner: string; migrations: string | null; tables: number }>(
      `SELECT pg_get_userbyid(datdba) AS owner, to_regclass('public.schema_migrations')::text AS migrations,
              (SELECT count(*)::int FROM pg_class WHERE relnamespace = 'public'::regnamespace) AS tables
         FROM pg_database WHERE datname = current_database()`,
    );
    expect(r).toEqual({ owner: OWNER_ROLE, migrations: null, tables: 0 });
  });

  it('a table wr_owner creates is closed to wr_app until applyGrants runs', async () => {
    await ownerNew.query('CREATE TABLE m9_new_table (id int)');
    try {
      expect(await sqlState(appNew.query('SELECT * FROM m9_new_table'))).toBe('42501');
      expect(await verifyRoleSeparation(ownerNew)).toContainEqual(expect.stringContaining('m9_new_table'));
      expect(await applyGrants(ownerNew, { log: QUIET })).toEqual(['GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public."m9_new_table" TO "wr_app"']);
      expect(await sqlState(appNew.query('INSERT INTO m9_new_table VALUES (1)'))).toBe('ok');
    } finally {
      await ownerNew.query('DROP TABLE m9_new_table');
    }
  });

  it('a column grant on audit_logs (UPDATE (action)) is caught by verify and assertLeastPrivilege, and revoked by applyGrants', async () => {
    await ownerNew.query(`GRANT UPDATE (action), SELECT (action) ON audit_logs TO ${APP_ROLE}`);
    try {
      expect(await sqlState(appNew.query("UPDATE audit_logs SET action = action WHERE action = 'nothing'"))).toBe('ok');
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toMatch(/REVOKE (SELECT|UPDATE) \("action"\) ON TABLE public."audit_logs"/);
      await expect(assertLeastPrivilege(appNew)).rejects.toThrow(/can UPDATE audit_logs/);
      expect(await applyGrants(ownerNew, { log: QUIET })).toEqual([
        'REVOKE SELECT ("action") ON TABLE public."audit_logs" FROM "wr_app"',
        'REVOKE UPDATE ("action") ON TABLE public."audit_logs" FROM "wr_app"',
      ]);
      expect(await sqlState(appNew.query("UPDATE audit_logs SET action = action WHERE action = 'nothing'"))).toBe('42501');
      await expect(assertLeastPrivilege(appNew)).resolves.toBeUndefined();
    } finally {
      await ownerNew.query(`REVOKE ALL (action) ON audit_logs FROM ${APP_ROLE}`);
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  it('a grant made directly on a partition (DELETE ON audit_logs_default) makes assertLeastPrivilege refuse', async () => {
    await ownerNew.query(`GRANT DELETE ON audit_logs_default TO ${APP_ROLE}`);
    try {
      await expect(assertLeastPrivilege(appNew)).rejects.toThrow(/can DELETE from audit_logs \(or a partition\)/);
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toContain('REVOKE DELETE ON TABLE public."audit_logs_default"');
    } finally {
      await applyGrants(ownerNew, { log: QUIET });
    }
    await expect(assertLeastPrivilege(appNew)).resolves.toBeUndefined();
  });

  it('a SECURITY DEFINER routine in public is a violation (it would delete audit rows as wr_owner for its callers)', async () => {
    await ownerNew.query("CREATE FUNCTION public.m9_erase_audit() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'DELETE FROM public.audit_logs WHERE false'");
    try {
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toMatch(/m9_erase_audit\(\) is SECURITY DEFINER/);
    } finally {
      await ownerNew.query('DROP FUNCTION public.m9_erase_audit()');
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  it('another schema — and a SECURITY DEFINER routine in it that wr_app may call — is a violation', async () => {
    await ownerNew.query('CREATE SCHEMA m9_tools');
    try {
      await ownerNew.query(`GRANT USAGE ON SCHEMA m9_tools TO ${APP_ROLE}`);
      await ownerNew.query("CREATE FUNCTION m9_tools.erase() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'DELETE FROM public.audit_logs WHERE false'");
      expect(await sqlState(appNew.query('SELECT m9_tools.erase()'))).toBe('ok'); // the bypass is real
      const violations = (await verifyRoleSeparation(ownerNew)).join('\n');
      expect(violations).toMatch(/schema m9_tools exists/);
      expect(violations).toMatch(/m9_tools\.erase\(\) is SECURITY DEFINER/);
    } finally {
      await ownerNew.query('DROP SCHEMA m9_tools CASCADE');
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  it('a SECURITY DEFINER routine in a system schema (information_schema) is a violation too', async () => {
    await adminNew.query("CREATE FUNCTION information_schema.m9_erase_audit() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'DELETE FROM public.audit_logs WHERE false'");
    try {
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toMatch(/information_schema\.m9_erase_audit\(\) is SECURITY DEFINER/);
    } finally {
      await adminNew.query('DROP FUNCTION information_schema.m9_erase_audit()');
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  it('a foreign key on a leaf two levels below audit_logs (ON DELETE CASCADE) is a violation', async () => {
    await ownerNew.query("CREATE TABLE audit_logs_2100 PARTITION OF audit_logs FOR VALUES FROM ('2100-01-01') TO ('2101-01-01') PARTITION BY RANGE (created_at)");
    await ownerNew.query('CREATE TABLE m9_leaf_ref (action text PRIMARY KEY)');
    try {
      await ownerNew.query("CREATE TABLE audit_logs_2100_01 PARTITION OF audit_logs_2100 FOR VALUES FROM ('2100-01-01') TO ('2100-02-01')");
      await ownerNew.query('ALTER TABLE audit_logs_2100_01 ADD CONSTRAINT m9_leaf_fk FOREIGN KEY (action) REFERENCES m9_leaf_ref ON DELETE CASCADE');
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toMatch(/m9_leaf_fk on audit_logs_2100_01 → m9_leaf_ref touches audit_logs/);
    } finally {
      await ownerNew.query('DROP TABLE audit_logs_2100');
      await ownerNew.query('DROP TABLE m9_leaf_ref');
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  it('a rewrite rule (it runs with the table owner\'s rights) is a violation', async () => {
    await ownerNew.query('CREATE RULE m9_erase_audit AS ON INSERT TO public.organizations DO ALSO DELETE FROM public.audit_logs WHERE false');
    try {
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toMatch(/rule m9_erase_audit on organizations/);
    } finally {
      await ownerNew.query('DROP RULE m9_erase_audit ON public.organizations');
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  it('a foreign key from audit_logs (ON DELETE CASCADE) or to it is a violation', async () => {
    await ownerNew.query('CREATE TABLE m9_action_ref (action text PRIMARY KEY)');
    try {
      await ownerNew.query('INSERT INTO m9_action_ref SELECT DISTINCT action FROM audit_logs');
      await ownerNew.query('ALTER TABLE audit_logs ADD CONSTRAINT m9_audit_action_fk FOREIGN KEY (action) REFERENCES m9_action_ref ON DELETE CASCADE');
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toMatch(/m9_audit_action_fk on audit_logs → m9_action_ref touches audit_logs/);
    } finally {
      await ownerNew.query('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS m9_audit_action_fk');
      await ownerNew.query('DROP TABLE m9_action_ref');
    }
    await ownerNew.query('CREATE TABLE m9_points_at_audit (id bigint, created_at timestamptz, FOREIGN KEY (id, created_at) REFERENCES audit_logs (id, created_at))');
    try {
      expect((await verifyRoleSeparation(ownerNew)).join('\n')).toMatch(/on m9_points_at_audit → audit_logs touches audit_logs/);
    } finally {
      await ownerNew.query('DROP TABLE m9_points_at_audit');
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  // ---- wr_app: refused ----------------------------------------------------------------------------------------------

  it('wr_app cannot read, change or empty audit_logs', async () => {
    for (const sql of [
      "UPDATE audit_logs SET action = 'x'",
      'DELETE FROM audit_logs',
      'TRUNCATE audit_logs',
      'SELECT * FROM audit_logs',
      'COPY (SELECT * FROM audit_logs) TO STDOUT',
    ]) {
      expect([sql, await sqlState(appNew.query(sql))]).toEqual([sql, '42501']);
    }
  });

  it('wr_app has no access to any partition — default, monthly, and one the sidecar SQL just created', async () => {
    await ownerNew.query(partitionSql('2041-03-15'));
    const monthly = (await adminNew.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relispartition AND relname ~ '^audit_logs_[0-9]{4}_[0-9]{2}$'
        AND relname <> 'audit_logs_2041_03' ORDER BY relname LIMIT 1`,
    )).rows[0].relname;
    for (const part of ['audit_logs_default', monthly, 'audit_logs_2041_03']) {
      for (const sql of [
        `SELECT * FROM ${part}`,
        `INSERT INTO ${part} (action, outcome, created_at) VALUES ('x', 'success', now())`,
        `UPDATE ${part} SET action = 'x'`,
        `DELETE FROM ${part}`,
      ]) {
        expect([sql, await sqlState(appNew.query(sql))]).toEqual([sql, '42501']);
      }
    }
    expect(await verifyRoleSeparation(ownerNew)).toEqual([]);
  });

  it('wr_app cannot move the audit id sequence', async () => {
    expect(await sqlState(appNew.query("SELECT setval('audit_logs_id_seq', 1)"))).toBe('42501');
  });

  it('wr_app cannot run DDL in public or switch role', async () => {
    for (const sql of [
      'CREATE TABLE m9_app_table (id int)',
      'ALTER TABLE users ADD COLUMN m9_x int',
      'DROP TABLE users',
      'CREATE TRIGGER m9_t BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'ALTER TABLE audit_logs DISABLE TRIGGER ALL',
      'CREATE SCHEMA m9_app_schema',
      "INSERT INTO schema_migrations (filename) VALUES ('9999_x.sql')",
      "UPDATE schema_migrations SET checksum = 'x'",
      'DELETE FROM schema_migrations',
      `SET ROLE ${OWNER_ROLE}`,
      `SET SESSION AUTHORIZATION ${OWNER_ROLE}`,
    ]) {
      expect([sql, await sqlState(appNew.query(sql))]).toEqual([sql, '42501']);
    }
  });

  it('a temporary audit_logs cannot shadow the real one: refused, and the audit row lands in public.audit_logs', async () => {
    const action = `m9.shadow.${crypto.randomUUID()}`;
    const client = await appNew.connect();
    try {
      expect(await sqlState(client.query('CREATE TEMP TABLE audit_logs (LIKE public.audit_logs)'))).toBe('42501');
      expect(await sqlState(client.query('CREATE TEMP TABLE m9_tmp (id int)'))).toBe('42501');
      await writeAuditLogStrict(client, { action, outcome: 'success' });
    } finally {
      client.release();
    }
    const { rows } = await readerNew.query('SELECT count(*)::int AS n FROM public.audit_logs WHERE action = $1', [action]);
    expect(rows[0].n).toBe(1);
  });

  // ---- wr_app: allowed ----------------------------------------------------------------------------------------------

  it('wr_app writes audit rows (direct INSERT and writeAuditLogStrict) through the parent', async () => {
    const action = `m9.allowed.${crypto.randomUUID()}`;
    expect(await sqlState(appNew.query(`INSERT INTO audit_logs (action, outcome) VALUES ($1, 'success')`, [action]))).toBe('ok');
    expect(await sqlState(appNew.query(
      `INSERT INTO audit_logs (action, outcome, created_at) VALUES ($1, 'success', '2099-01-01')`, [action],
    ))).toBe('ok');
    await writeAuditLogStrict(appNew, { action, outcome: 'failure' });
    const { rows } = await readerNew.query<{ part: string }>(
      'SELECT tableoid::regclass::text AS part FROM audit_logs WHERE action = $1 ORDER BY id', [action],
    );
    expect(rows.map((r) => r.part)).toEqual([expect.stringMatching(/^audit_logs_\d{4}_\d{2}$/), 'audit_logs_default', expect.stringMatching(/^audit_logs_\d{4}_\d{2}$/)]);
  });

  it('wr_app has full DML on ordinary tables, row locks, upserts, and reads schema_migrations', async () => {
    const id = crypto.randomUUID();
    expect(await sqlState(appNew.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, 'm9']))).toBe('ok');
    const client = await appNew.connect();
    try {
      await client.query('BEGIN');
      expect((await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [id])).rowCount).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await sqlState(appNew.query(
      'INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name', [id, 'm9b'],
    ))).toBe('ok');
    expect(await sqlState(appNew.query("UPDATE organizations SET name = 'm9c' WHERE id = $1", [id]))).toBe('ok');
    expect(await sqlState(appNew.query('DELETE FROM organizations WHERE id = $1', [id]))).toBe('ok');
    expect(await sqlState(appNew.query('SELECT count(*) FROM schema_migrations'))).toBe('ok');
  });

  // ---- wr_audit_reader ----------------------------------------------------------------------------------------------

  it('wr_audit_reader reads audit_logs (no partition rights needed) and nothing else', async () => {
    expect(await sqlState(readerNew.query('SELECT count(*) FROM audit_logs'))).toBe('ok');
    expect(await sqlState(readerNew.query("INSERT INTO audit_logs (action, outcome) VALUES ('x', 'success')"))).toBe('42501');
    expect(await sqlState(readerNew.query('SELECT * FROM users'))).toBe('42501');
    expect(await sqlState(readerNew.query('SELECT * FROM audit_logs_default'))).toBe('42501');
  });

  // ---- start-up checks ----------------------------------------------------------------------------------------------

  function migrationsCopy(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-m9-migrations-'));
    tmpDirs.push(dir);
    for (const f of fs.readdirSync(REAL_DIR).filter((x) => x.endsWith('.sql'))) fs.copyFileSync(path.join(REAL_DIR, f), path.join(dir, f));
    return dir;
  }

  it('assertMigrationsApplied: passes as wr_app on a current database; a pending file refuses start-up', async () => {
    await assertMigrationsApplied(appNew, { log: QUIET });
    const dir = migrationsCopy();
    fs.writeFileSync(path.join(dir, '9999_m9_pending.sql'), 'SELECT 1;\n');
    const err = await assertMigrationsApplied(appNew, { migrationsDir: dir, log: QUIET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationsPendingError);
    expect((err as MigrationsPendingError).filenames).toEqual(['9999_m9_pending.sql']);
    expect((err as Error).message).toContain('run --rm migrate');
  });

  it('assertMigrationsApplied: a changed applied file fails in enforce and warns in warn', async () => {
    const dir = migrationsCopy();
    fs.appendFileSync(path.join(dir, '0002_devices.sql'), '\n-- edited\n');
    const enforce = await assertMigrationsApplied(appNew, { migrationsDir: dir, checksumMode: 'enforce', log: QUIET }).catch((e: unknown) => e);
    expect(enforce).toBeInstanceOf(MigrationChecksumError);
    const warns: string[] = [];
    await assertMigrationsApplied(appNew, { migrationsDir: dir, checksumMode: 'warn', log: { log: () => undefined, warn: (m: string) => { warns.push(m); } } });
    expect(warns.join('\n')).toContain('0002_devices.sql');
    expect(migrationChecksum('a\r\nb')).toBe(migrationChecksum('a\nb'));
  });

  it('assertMigrationsApplied: no table, no checksum column, no read permission → the "run migrate" guidance', async () => {
    const appRolesOnly = pool(roleUrls(dbRolesOnly).appUrl);
    await expect(assertMigrationsApplied(appRolesOnly, { log: QUIET })).rejects.toThrow(/schema_migrations does not exist.*run --rm migrate/s);

    const noChecksum = pool(withDatabase(ADMIN_URL!, dbNoChecksum));
    await noChecksum.query('CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await expect(assertMigrationsApplied(noChecksum, { log: QUIET })).rejects.toThrow(/no checksum column.*run --rm migrate/s);

    await ownerNew.query(`REVOKE SELECT ON schema_migrations FROM ${APP_ROLE}`);
    try {
      await expect(assertMigrationsApplied(appNew, { log: QUIET })).rejects.toThrow(/may not read schema_migrations.*run --rm migrate/s);
    } finally {
      await applyGrants(ownerNew, { log: QUIET });
    }
  });

  it('assertLeastPrivilege: refuses a superuser and the owner, accepts wr_app', async () => {
    await expect(assertLeastPrivilege(adminNew)).rejects.toThrow(StartupCheckError);
    await expect(assertLeastPrivilege(adminNew)).rejects.toThrow(/is a superuser/);
    await expect(assertLeastPrivilege(ownerNew)).rejects.toThrow(/owns audit_logs/);
    await expect(assertLeastPrivilege(appNew)).resolves.toBeUndefined();
  });

  it('assertAuditWritable: refuses a role without INSERT on audit_logs or USAGE on its sequence', async () => {
    await expect(assertAuditWritable(appLegacy)).resolves.toBeUndefined();
    await expect(assertAuditWritable(adminLegacy)).resolves.toBeUndefined();
    await ownerLegacy.query(`REVOKE INSERT ON audit_logs FROM ${APP_ROLE}`);
    try {
      await expect(assertAuditWritable(appLegacy)).rejects.toThrow(/INSERT on audit_logs/);
    } finally {
      await applyGrants(ownerLegacy, { log: QUIET });
    }
    await ownerLegacy.query(`REVOKE USAGE ON SEQUENCE audit_logs_id_seq FROM ${APP_ROLE}`);
    try {
      await expect(assertAuditWritable(appLegacy)).rejects.toThrow(/USAGE on audit_logs_id_seq/);
    } finally {
      await applyGrants(ownerLegacy, { log: QUIET });
    }
    expect(await verifyRoleSeparation(ownerLegacy)).toEqual([]);
  });
});

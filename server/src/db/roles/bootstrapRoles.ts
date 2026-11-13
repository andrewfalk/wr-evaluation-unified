// M9 — prepares the roles and the ownership of a database, as the bootstrap superuser (BOOTSTRAP_DATABASE_URL).
// Run by cli/dbSetup.ts on every `docker compose up` before the migrations, and by the integration tests.
// Idempotent, and on a database that is already right it writes nothing:
//   1. wr_owner / wr_app / wr_audit_reader exist as plain login roles (no superuser, CREATEDB, CREATEROLE,
//      REPLICATION, BYPASSRLS) and are members of no role and have no members.
//   2. Each role's password is the one in its service URL: the URL is tried first and the password is set only
//      when that login fails with 28P01 — so the reader password no longer has to be changed by hand.
//   3. wr_owner owns the database; schema public stays owned by pg_database_owner (owning it directly would make
//      pg_dump emit the schema and change what a --clean restore does); PUBLIC loses CREATE on public and
//      TEMPORARY on the database (a temporary table comes first in search_path, so a temporary `audit_logs` on a
//      pooled connection would take that connection's audit rows); wr_app and the reader get CONNECT and USAGE.
//   4. Every object in public that is not part of an extension is given to wr_owner, object by object (REASSIGN
//      OWNED cannot be used: the bootstrap superuser owns system objects), in one transaction with a lock timeout.
import { Client, type Pool, type PoolClient } from 'pg';
import { logger } from '../../logger';
import { APP_ROLE, MANAGED_ROLES, OWNER_ROLE, READER_ROLE, quoteIdent, type ManagedRole } from './policy';

export interface RoleUrls {
  /** wr_owner — MIGRATION_DATABASE_URL */
  ownerUrl: string;
  /** wr_app — DATABASE_URL */
  appUrl: string;
  /** wr_audit_reader — AUDIT_DATABASE_URL */
  readerUrl: string;
}

export interface BootstrapRolesOptions {
  log?: Pick<typeof logger, 'info'>;
  /** Lock timeout for the ownership transfer (default 10s). */
  lockTimeout?: string;
}

export class OwnershipLockTimeoutError extends Error {
  constructor(cause: unknown) {
    super(
      '[db-roles] Could not lock the tables to change their owner within the lock timeout — another session is ' +
      'using them. Stop every server that uses this database (app, partition, backup, and any other server or ' +
      'worker pointed at it), then run the setup again.',
    );
    this.name = 'OwnershipLockTimeoutError';
    (this as { cause?: unknown }).cause = cause;
  }
}

interface Target {
  role: ManagedRole;
  variable: string;
  url: string;
  password: string;
}

// The URL as pg itself reads it (a Client that is never connected): the same parser and defaults the service uses.
function parseTarget(role: ManagedRole, variable: string, url: string, database: string): Target {
  let parsed: Client;
  try {
    parsed = new Client({ connectionString: url });
  } catch {
    throw new Error(`[db-roles] ${variable} is not a valid connection URL.`);
  }
  if (parsed.user !== role) {
    throw new Error(`[db-roles] ${variable} must connect as ${role} (it names "${parsed.user ?? ''}").`);
  }
  if (parsed.database !== database) {
    throw new Error(`[db-roles] ${variable} points at database "${parsed.database ?? ''}", not "${database}" (the bootstrap connection's).`);
  }
  const password = typeof parsed.password === 'string' ? parsed.password : '';
  if (!password) throw new Error(`[db-roles] ${variable} has no password.`);
  return { role, variable, url, password };
}

type ConnectOutcome = 'ok' | 'bad-password';

// Logging in tells whether the password is right. 42501 (no CONNECT) means the password was accepted.
async function tryLogin(target: Target): Promise<ConnectOutcome> {
  const client = new Client({ connectionString: target.url, connectionTimeoutMillis: 10_000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return 'ok';
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '28P01') return 'bad-password';
    if (code === '42501') return 'ok';
    throw new Error(`[db-roles] Could not log in with ${target.variable} (${code ?? (err as Error).message}).`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// CREATE / ALTER ROLE … PASSWORD: the statement is built on the server (format %I / %L) and kept out of the
// server log for this transaction.
async function setPassword(client: PoolClient, role: ManagedRole, password: string, create: boolean): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL log_statement = 'none'");
    await client.query("SET LOCAL log_min_error_statement = 'panic'");
    await client.query('SET LOCAL log_min_duration_statement = -1');
    const template = create
      ? 'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L'
      : 'ALTER ROLE %I PASSWORD %L';
    const { rows } = await client.query<{ sql: string }>('SELECT format($1, $2::text, $3::text) AS sql', [template, role, password]);
    await client.query(rows[0].sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Returns a description of each change it made (passwords never included); empty when nothing was needed. */
export async function bootstrapRoles(adminPool: Pool, urls: RoleUrls, options: BootstrapRolesOptions = {}): Promise<string[]> {
  const log = options.log ?? logger;
  const changes: string[] = [];
  const done = async (client: PoolClient, statement: string, description = statement): Promise<void> => {
    await client.query(statement);
    changes.push(description);
    log.info(`[db-roles] ${description}`);
  };

  const client = await adminPool.connect();
  try {
    const { rows: [me] } = await client.query<{ superuser: boolean; db: string }>(
      'SELECT rolsuper AS superuser, current_database() AS db FROM pg_roles WHERE rolname = current_user',
    );
    if (!me?.superuser) throw new Error('[db-roles] BOOTSTRAP_DATABASE_URL must connect as a superuser (the bootstrap user wr_user).');
    const db = me.db;
    const targets = [
      parseTarget(OWNER_ROLE, 'MIGRATION_DATABASE_URL', urls.ownerUrl, db),
      parseTarget(APP_ROLE, 'DATABASE_URL', urls.appUrl, db),
      parseTarget(READER_ROLE, 'AUDIT_DATABASE_URL', urls.readerUrl, db),
    ];

    // 1. roles and their attributes
    const created = new Set<ManagedRole>();
    for (const t of targets) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT (NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
                 AND rolcanlogin) AS ok
           FROM pg_roles WHERE rolname = $1`,
        [t.role],
      );
      if (rows.length === 0) {
        await setPassword(client, t.role, t.password, true);
        created.add(t.role);
        changes.push(`CREATE ROLE ${t.role}`);
        log.info(`[db-roles] CREATE ROLE ${t.role}`);
      } else if (!rows[0].ok) {
        await done(client, `ALTER ROLE ${quoteIdent(t.role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      }
    }
    const members = await client.query<{ role: string; member: string }>(
      `SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member FROM pg_auth_members
        WHERE pg_get_userbyid(roleid) = ANY($1) OR pg_get_userbyid(member) = ANY($1)`,
      [MANAGED_ROLES],
    );
    if (members.rows.length > 0) {
      throw new Error(
        `[db-roles] ${MANAGED_ROLES.join(', ')} must not be members of a role or have members: ` +
        members.rows.map((m) => `${m.member} → ${m.role}`).join(', ') + ' (REVOKE them, then run the setup again).',
      );
    }

    // 2. passwords
    for (const t of targets) {
      if (created.has(t.role)) continue;
      if (await tryLogin(t) === 'bad-password') {
        await setPassword(client, t.role, t.password, false);
        changes.push(`ALTER ROLE ${t.role} PASSWORD (from ${t.variable})`);
        log.info(`[db-roles] ALTER ROLE ${t.role} PASSWORD (from ${t.variable})`);
      }
    }

    // 3. database and schema public
    const dbIdent = quoteIdent(db);
    const { rows: [state] } = await client.query<{
      dbOwner: string; schemaOwner: string | null; publicSchemaCreate: boolean; publicTemp: boolean;
    }>(
      `SELECT pg_get_userbyid(d.datdba) AS "dbOwner",
              (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS "schemaOwner",
              EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                       WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS "publicSchemaCreate",
              EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'TEMPORARY') AS "publicTemp"
         FROM pg_database d WHERE d.datname = current_database()`,
    );
    if (state.schemaOwner === null) throw new Error('[db-roles] Schema public does not exist in this database.');
    if (state.dbOwner !== OWNER_ROLE) await done(client, `ALTER DATABASE ${dbIdent} OWNER TO ${OWNER_ROLE}`);
    if (state.schemaOwner !== 'pg_database_owner') await done(client, 'ALTER SCHEMA public OWNER TO pg_database_owner');
    if (state.publicSchemaCreate) await done(client, 'REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    if (state.publicTemp) await done(client, `REVOKE TEMPORARY ON DATABASE ${dbIdent} FROM PUBLIC`);
    for (const role of [APP_ROLE, READER_ROLE]) {
      const { rows: [acl] } = await client.query<{ dbPrivs: string[]; schemaPrivs: string[] }>(
        `SELECT ARRAY(SELECT a.privilege_type FROM pg_database d, aclexplode(d.datacl) a
                       WHERE d.datname = current_database() AND a.grantee = to_regrole($1)) AS "dbPrivs",
                ARRAY(SELECT a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a
                       WHERE n.nspname = 'public' AND a.grantee = to_regrole($1)) AS "schemaPrivs"`,
        [role],
      );
      const extraDb = acl.dbPrivs.filter((p) => p !== 'CONNECT').sort();
      if (extraDb.length > 0) await done(client, `REVOKE ${extraDb.join(', ')} ON DATABASE ${dbIdent} FROM ${role}`);
      if (!acl.dbPrivs.includes('CONNECT')) await done(client, `GRANT CONNECT ON DATABASE ${dbIdent} TO ${role}`);
      const extraSchema = acl.schemaPrivs.filter((p) => p !== 'USAGE').sort();
      if (extraSchema.length > 0) await done(client, `REVOKE ${extraSchema.join(', ')} ON SCHEMA public FROM ${role}`);
      if (!acl.schemaPrivs.includes('USAGE')) await done(client, `GRANT USAGE ON SCHEMA public TO ${role}`);
    }

    // 4. ownership of the objects in public
    await transferOwnership(client, options.lockTimeout ?? '10s', changes, log);
    return changes;
  } finally {
    client.release();
  }
}

const NOT_EXTENSION = (catalog: string, alias: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`;

async function transferOwnership(
  client: PoolClient,
  lockTimeout: string,
  changes: string[],
  log: Pick<typeof logger, 'info'>,
): Promise<void> {
  const owner = quoteIdent(OWNER_ROLE);
  const pending: string[] = [];
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout.replace(/'/g, "''")}'`);
    const run = async (statement: string) => {
      await client.query(statement);
      pending.push(statement);
    };
    // Tables first — each partition separately (ALTER TABLE on a parent does not recurse) — which also moves
    // their indexes and the sequences bound to their columns (a bound sequence cannot be moved on its own).
    const tables = await client.query<{ ident: string; relkind: string }>(
      `SELECT format('public.%I', c.relname) AS ident, c.relkind::text AS relkind FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
          AND pg_get_userbyid(c.relowner) <> $1 AND ${NOT_EXTENSION('pg_class', 'c')}
        ORDER BY c.relkind IN ('v', 'm'), c.relname`,
      [OWNER_ROLE],
    );
    for (const t of tables.rows) {
      const kind = t.relkind === 'v' ? 'VIEW' : t.relkind === 'm' ? 'MATERIALIZED VIEW' : t.relkind === 'f' ? 'FOREIGN TABLE' : 'TABLE';
      await run(`ALTER ${kind} ${t.ident} OWNER TO ${owner}`);
    }
    // Sequences not bound to a column.
    const sequences = await client.query<{ ident: string }>(
      `SELECT format('public.%I', c.relname) AS ident FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
          AND pg_get_userbyid(c.relowner) <> $1 AND ${NOT_EXTENSION('pg_class', 'c')}
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                           AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i'))
        ORDER BY c.relname`,
      [OWNER_ROLE],
    );
    for (const s of sequences.rows) await run(`ALTER SEQUENCE ${s.ident} OWNER TO ${owner}`);
    // Functions, procedures and aggregates.
    const routines = await client.query<{ ident: string }>(
      `SELECT p.oid::regprocedure::text AS ident FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND pg_get_userbyid(p.proowner) <> $1 AND ${NOT_EXTENSION('pg_proc', 'p')}
        ORDER BY 1`,
      [OWNER_ROLE],
    );
    for (const r of routines.rows) await run(`ALTER ROUTINE ${r.ident} OWNER TO ${owner}`);
    // Stand-alone types: enums, domains, ranges and composite types (not table row types or array types, which
    // follow their table or element type).
    const types = await client.query<{ ident: string; typtype: string }>(
      `SELECT format('public.%I', t.typname) AS ident, t.typtype::text AS typtype FROM pg_type t
        WHERE t.typnamespace = 'public'::regnamespace AND pg_get_userbyid(t.typowner) <> $1 AND ${NOT_EXTENSION('pg_type', 't')}
          AND (t.typtype IN ('e', 'd', 'r')
               OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
        ORDER BY 1`,
      [OWNER_ROLE],
    );
    for (const t of types.rows) await run(`ALTER ${t.typtype === 'd' ? 'DOMAIN' : 'TYPE'} ${t.ident} OWNER TO ${owner}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string }).code === '55P03') throw new OwnershipLockTimeoutError(err);
    throw err;
  }
  for (const statement of pending) {
    changes.push(statement);
    log.info(`[db-roles] ${statement}`);
  }
}

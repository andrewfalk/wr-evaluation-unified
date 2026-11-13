// M9 — the database setup the one-shot `migrate` compose service runs on every `docker compose up`, before the app:
//   wait for PostgreSQL → take the setup lock → prepare roles and ownership (bootstrapRoles, when
//   BOOTSTRAP_DATABASE_URL is set) → apply pending migrations as wr_owner → bring the grants to the policy
//   (applyGrants) → verify the role separation (exit 1 on any violation) → exit 0.
// `--roles-only` stops after the roles: before restoring an old dump into an empty cluster, the roles must exist
// but the schema must not (a full migration would leave tables the dump does not drop).
//
// Reads process.env directly and never loads the server config (the service has none of the server's settings).
//   BOOTSTRAP_DATABASE_URL  superuser (wr_user) — optional; without it the roles are taken as already prepared
//   MIGRATION_DATABASE_URL  wr_owner — required
//   DATABASE_URL            wr_app — required with BOOTSTRAP_DATABASE_URL (its password is set from here)
//   AUDIT_DATABASE_URL      wr_audit_reader — required with BOOTSTRAP_DATABASE_URL
//   MIGRATION_CHECKSUM_MODE as for the server
import { Client, Pool } from 'pg';
import { logger } from '../logger';
import { runMigrations } from '../db/migrate';
import { bootstrapRoles } from '../db/roles/bootstrapRoles';
import { applyGrants } from '../db/roles/applyGrants';
import { verifyRoleSeparation } from '../db/roles/verifyRoleSeparation';

// Not the migration runner's MIGRATION_LOCK_KEY (7_369_276): runMigrations takes that one itself on another
// connection while this one is held.
export const DB_SETUP_LOCK_KEY = 7_369_277;

// Errors worth waiting out: the server is not up yet (first initdb does not listen on TCP; the container's DNS
// name may not resolve yet) or is starting. A wrong password (28P01) fails at once — there is no restart to retry.
const RETRYABLE = new Set(['ECONNREFUSED', '57P03', 'ENOTFOUND', 'EAI_AGAIN']);

export interface DbSetupEnv {
  BOOTSTRAP_DATABASE_URL?: string;
  MIGRATION_DATABASE_URL?: string;
  DATABASE_URL?: string;
  AUDIT_DATABASE_URL?: string;
}

export interface DbSetupOptions {
  rolesOnly?: boolean;
  /** How long to wait for PostgreSQL to accept connections (default 60 s). */
  waitForMs?: number;
  /** Migrations folder (tests). */
  migrationsDir?: string;
  log?: Pick<typeof logger, 'info' | 'warn'>;
}

export interface DbSetupResult {
  roleChanges: string[];
  grantChanges: string[];
}

export class RoleSeparationError extends Error {
  constructor(readonly violations: string[]) {
    super(`[db-setup] The database is not role-separated: ${violations.join('; ')}`);
    this.name = 'RoleSeparationError';
  }
}

function required(env: DbSetupEnv, key: keyof DbSetupEnv, why: string): string {
  const value = env[key];
  if (!value) throw new Error(`[db-setup] ${key} is required ${why}.`);
  return value;
}

/** Connects with `url` until PostgreSQL answers, and returns the connected client. */
export async function connectWhenReady(url: string, label: string, waitForMs: number, log: Pick<typeof logger, 'info'>): Promise<Client> {
  const deadline = Date.now() + waitForMs;
  for (let attempt = 1; ; attempt += 1) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    client.on('error', () => undefined);
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => undefined);
      const code = (err as { code?: string }).code ?? '';
      if (!RETRYABLE.has(code) || Date.now() >= deadline) {
        throw new Error(`[db-setup] Could not connect with ${label} (${code || (err as Error).message}).`);
      }
      if (attempt === 1) log.info(`[db-setup] Waiting for PostgreSQL (${code})…`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

export async function runDbSetup(env: DbSetupEnv, options: DbSetupOptions = {}): Promise<DbSetupResult> {
  const log = options.log ?? logger;
  const bootstrapUrl = env.BOOTSTRAP_DATABASE_URL || undefined;
  if (options.rolesOnly && !bootstrapUrl) throw new Error('[db-setup] --roles-only needs BOOTSTRAP_DATABASE_URL.');
  const ownerUrl = required(env, 'MIGRATION_DATABASE_URL', '(the owner role wr_owner)');
  const roleUrls = bootstrapUrl
    ? {
      ownerUrl,
      appUrl: required(env, 'DATABASE_URL', 'with BOOTSTRAP_DATABASE_URL (the app role wr_app)'),
      readerUrl: required(env, 'AUDIT_DATABASE_URL', 'with BOOTSTRAP_DATABASE_URL (the audit reader role)'),
    }
    : null;

  const lockUrl = bootstrapUrl ?? ownerUrl;
  const lockClient = await connectWhenReady(lockUrl, bootstrapUrl ? 'BOOTSTRAP_DATABASE_URL' : 'MIGRATION_DATABASE_URL', options.waitForMs ?? 60_000, log);
  const pools: Pool[] = [];
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [DB_SETUP_LOCK_KEY]);
    const result: DbSetupResult = { roleChanges: [], grantChanges: [] };

    if (bootstrapUrl && roleUrls) {
      const adminPool = new Pool({ connectionString: bootstrapUrl, max: 1 });
      pools.push(adminPool);
      result.roleChanges = await bootstrapRoles(adminPool, roleUrls, { log });
    }
    if (options.rolesOnly) {
      log.info(`[db-setup] Roles ready (${result.roleChanges.length} change(s)); --roles-only: no migrations, no grants.`);
      return result;
    }

    const ownerPool = new Pool({ connectionString: ownerUrl, max: 2 });
    pools.push(ownerPool);
    await runMigrations(ownerPool, { migrationsDir: options.migrationsDir });
    result.grantChanges = await applyGrants(ownerPool, { log });
    const violations = await verifyRoleSeparation(ownerPool);
    if (violations.length > 0) throw new RoleSeparationError(violations);
    log.info(
      `[db-setup] Done — roles: ${result.roleChanges.length} change(s), grants: ${result.grantChanges.length} change(s); ` +
      'role separation verified.',
    );
    return result;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [DB_SETUP_LOCK_KEY]).catch(() => undefined);
    await lockClient.end().catch(() => undefined);
    for (const pool of pools) await pool.end().catch(() => undefined);
  }
}

// node dist/cli/dbSetup.js [--roles-only]
if (require.main === module) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--roles-only');
  if (unknown.length > 0) {
    logger.fatal(`[db-setup] Unknown argument(s): ${unknown.join(' ')} (usage: dbSetup [--roles-only])`);
    process.exit(2);
  }
  runDbSetup(process.env, { rolesOnly: args.includes('--roles-only') })
    .then(() => process.exit(0))
    .catch((err) => {
      if (err instanceof RoleSeparationError) {
        for (const v of err.violations) logger.error(`[db-setup] violation: ${v}`);
      }
      logger.fatal({ err }, '[db-setup] failed');
      process.exit(1);
    });
}

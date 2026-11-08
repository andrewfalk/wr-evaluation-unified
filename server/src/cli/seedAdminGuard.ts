// Production guard for the admin seed CLI (cli/seedAdmin.ts, SEC-B L12). The seed is meant for an empty
// database; run again in production it would quietly add another administrator with a known initial
// password. With NODE_ENV=production it now refuses when any admin account exists, unless --force.
// Kept apart from the entry point so it can be tested without a process or a database.

export const SEED_ADMIN_USAGE = 'usage: seedAdmin [--force]';

export function parseSeedAdminArgs(argv: readonly string[]): { force: boolean } | { error: string } {
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else return { error: `unknown argument: ${arg}\n${SEED_ADMIN_USAGE}` };
  }
  return { force };
}

interface Queryable {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

/** The refusal message, or null when seeding may go ahead. Disabled admins count too. */
export async function seedAdminRefusal(
  db: Queryable,
  options: { nodeEnv: string | undefined; force: boolean },
): Promise<string | null> {
  if (options.nodeEnv !== 'production' || options.force) return null;
  const { rows } = await db.query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`);
  if (rows.length === 0) return null;
  return 'An admin account already exists — refusing to seed another one in production (NODE_ENV=production). '
    + 'Create further accounts in the admin console, or pass --force to seed anyway.';
}

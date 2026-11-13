// M9 — brings the ACL of every object in schema public to the policy (db/roles/policy.ts). Runs after each
// migration run as wr_owner (cli/dbSetup.ts), in one transaction, and issues only the difference: a second run
// issues no statement. A relation not owned by wr_owner, or of a kind without a policy, fails the whole run —
// nothing is skipped silently.
import type { Pool } from 'pg';
import { logger } from '../../logger';
import { planGrants } from './policy';

export class GrantPolicyError extends Error {
  constructor(readonly problems: string[]) {
    super(`[db-roles] Cannot apply the grant policy: ${problems.join('; ')}`);
    this.name = 'GrantPolicyError';
  }
}

export interface ApplyGrantsOptions {
  log?: Pick<typeof logger, 'info'>;
}

/** Returns the GRANT / REVOKE statements it executed (empty when the ACL already matched). */
export async function applyGrants(ownerPool: Pool, options: ApplyGrantsOptions = {}): Promise<string[]> {
  const log = options.log ?? logger;
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10s'");
      const plan = await planGrants(client);
      if (plan.problems.length > 0) throw new GrantPolicyError(plan.problems);
      for (const statement of plan.statements) {
        await client.query(statement);
        log.info(`[db-roles] ${statement}`);
      }
      await client.query('COMMIT');
      return plan.statements;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

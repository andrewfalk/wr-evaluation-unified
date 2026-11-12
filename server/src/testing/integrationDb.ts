// Real-PostgreSQL helpers for the patient write integration tests (S7). Each test file creates its own
// organization and users, and gives its pools an `application_name`, so that
//   - cleanup removes only that file's rows, and
//   - waitForLockWait() sees only that file's sessions waiting on a lock — not a worker or another
//     connection that happens to wait at the same time (the polling it replaces looked at the whole
//     database: routes/__tests__/workspaces.integration.test.ts).
//
// Only used with TEST_DATABASE_URL (a dedicated wr_test* database — testing/integrationGlobalSetup.ts).
import crypto from 'crypto';
import { Pool } from 'pg';
import { generateAccessToken } from '../auth/tokens';
import { generateToken, hashToken } from '../auth/tokenHash';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** The CSRF token every integration user's access token carries (send it as X-CSRF-Token). */
export const INTEGRATION_CSRF_TOKEN = 'wr-integration-csrf';

/** A pool whose connections report `applicationName` in pg_stat_activity. */
export function integrationPool(applicationName: string, options: { max?: number } = {}): Pool {
  if (!TEST_DATABASE_URL) throw new Error('integrationPool() needs TEST_DATABASE_URL');
  return new Pool({ connectionString: TEST_DATABASE_URL, application_name: applicationName, max: options.max ?? 10 });
}

export type IntegrationRole = 'doctor' | 'nurse' | 'admin';

export interface IntegrationUser {
  id: string;
  name: string;
  role: IntegrationRole;
  sessionId: string;
  /** Bearer access token for this user's session. */
  token: string;
}

export interface IntegrationOrg {
  orgId: string;
  /** A user in this organization with a live session. */
  makeUser(role: IntegrationRole, name: string): Promise<IntegrationUser>;
  /** `Authorization` and `X-CSRF-Token` headers for supertest `.set(...)`. */
  headers(user: IntegrationUser): Record<string, string>;
  /** Removes the organization's patients, persons, locks, workspaces and autosaves (between tests). */
  resetData(): Promise<void>;
  /** resetData() plus the users, their sessions and the organization (afterAll). */
  destroy(): Promise<void>;
}

export async function createIntegrationOrg(pool: Pool, label: string): Promise<IntegrationOrg> {
  const orgId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    [`__itest_${label}_${crypto.randomUUID()}__`],
  )).rows[0].id;
  const csrfHash = hashToken(INTEGRATION_CSRF_TOKEN);

  async function makeUser(role: IntegrationRole, name: string): Promise<IntegrationUser> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1, 'x', $2, $3, $4) RETURNING id`,
      [`__itest_${label}_${role}_${crypto.randomUUID()}__`, name, role, orgId],
    )).rows[0].id;
    const sessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, family_id)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', $5)`,
      [sessionId, id, hashToken(generateToken()), csrfHash, crypto.randomUUID()],
    );
    const token = generateAccessToken({
      sub: id, sessionId, orgId, role, name, mustChangePassword: false, csrfHash,
    }).token;
    return { id, name, role, sessionId, token };
  }

  async function resetData(): Promise<void> {
    // patient_locks and video_analysis_{jobs,clips} go with patient_records (ON DELETE CASCADE);
    // patient_persons are RESTRICT-referenced by patient_records, so they go after them.
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM workspaces WHERE organization_id = $1`, [orgId]);
    await pool.query(
      `DELETE FROM autosaves WHERE organization_id = $1
          OR user_id IN (SELECT id FROM users WHERE organization_id = $1)`,
      [orgId],
    );
  }

  async function destroy(): Promise<void> {
    await resetData();
    // sessions and idempotency_keys go with the users (ON DELETE CASCADE).
    await pool.query(`DELETE FROM users WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  }

  return {
    orgId,
    makeUser,
    headers: (user) => ({ Authorization: `Bearer ${user.token}`, 'X-CSRF-Token': INTEGRATION_CSRF_TOKEN }),
    resetData,
    destroy,
  };
}

/**
 * Waits until at least `count` sessions named `applicationName` wait on a lock (pg_stat_activity
 * wait_event_type = 'Lock'). Polls; throws after `timeoutMs`. Use it to make "request B is now blocked
 * behind the test's open transaction" deterministic instead of sleeping.
 *
 * Pass an `observer` pool other than the application's: if the application's pool is exhausted by the
 * waiting sessions, a query on it waits for a connection and the timeout is never checked.
 */
export async function waitForLockWait(
  observer: Pool,
  applicationName: string,
  options: { count?: number; timeoutMs?: number } = {},
): Promise<void> {
  const count = options.count ?? 1;
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  for (;;) {
    const { rows } = await observer.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1
          AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      [applicationName],
    );
    if (rows[0].n >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`waitForLockWait: ${rows[0].n}/${count} "${applicationName}" sessions waiting on a lock after ${options.timeoutMs ?? 5000}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

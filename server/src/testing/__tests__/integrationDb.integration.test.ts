// The S7 integration harness (testing/integrationDb.ts) and withDecidedTransaction against real
// PostgreSQL: per-file organizations clean up after themselves, lock waits are seen only for the named
// application, and the decided transaction really commits or rolls back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { withDecidedTransaction } from '../../db/withWriteTransaction';
import { createIntegrationOrg, integrationPool, waitForLockWait, TEST_DATABASE_URL, type IntegrationOrg } from '../integrationDb';

const APP = 'wr-itest-integration-db';

describe.skipIf(!TEST_DATABASE_URL)('integration harness + withDecidedTransaction (real PostgreSQL, S7-0)', () => {
  let pool: Pool;
  let org: IntegrationOrg;

  beforeAll(async () => {
    pool = integrationPool(APP);
    org = await createIntegrationOrg(pool, 'harness');
  });

  afterAll(async () => {
    if (!pool) return;
    await org?.destroy();
    await pool.end();
  });

  const personCount = async (name: string) => (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM patient_persons WHERE organization_id = $1 AND name = $2`, [org.orgId, name],
  )).rows[0].n;

  const insertPerson = (db: Pool | PoolClient, name: string) =>
    db.query(`INSERT INTO patient_persons (organization_id, name) VALUES ($1, $2)`, [org.orgId, name]);

  it('commit: true keeps the writes', async () => {
    const value = await withDecidedTransaction(pool, async (client) => {
      await insertPerson(client, 'committed');
      return { commit: true, value: 'ok' };
    });
    expect(value).toBe('ok');
    expect(await personCount('committed')).toBe(1);
  });

  it('commit: false rolls the writes back and still returns the value', async () => {
    const value = await withDecidedTransaction(pool, async (client) => {
      await insertPerson(client, 'rolled-back');
      return { commit: false, value: { kind: 'conflict' } };
    });
    expect(value).toEqual({ kind: 'conflict' });
    expect(await personCount('rolled-back')).toBe(0);
  });

  it('a thrown error rolls back and is rethrown; the connection goes back to the pool usable', async () => {
    await expect(withDecidedTransaction(pool, async (client) => {
      await insertPerson(client, 'thrown');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await personCount('thrown')).toBe(0);
    // A connection left in an aborted transaction would fail the next statement.
    for (let i = 0; i < 3; i += 1) await withDecidedTransaction(pool, async (c) => ({ commit: true, value: (await c.query('SELECT 1')).rowCount }));
  });

  it('a failing statement (SQL error) aborts the transaction and rolls back earlier writes', async () => {
    await expect(withDecidedTransaction(pool, async (client) => {
      await insertPerson(client, 'before-error');
      await client.query('SELECT * FROM no_such_table');
      return { commit: true, value: null };
    })).rejects.toMatchObject({ code: '42P01' });
    expect(await personCount('before-error')).toBe(0);
  });

  it('waitForLockWait sees a session of this application blocked on a row lock — and not other applications', async () => {
    const person = (await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1, 'lock-target') RETURNING id`, [org.orgId],
    )).rows[0].id;
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM patient_persons WHERE id = $1 FOR UPDATE`, [person]);

      const waiter = withDecidedTransaction(pool, async (client) => {
        await client.query(`SELECT 1 FROM patient_persons WHERE id = $1 FOR UPDATE`, [person]);
        return { commit: true, value: 'got it' };
      });
      await waitForLockWait(pool, APP);
      await expect(waitForLockWait(pool, `${APP}-other`, { timeoutMs: 200 })).rejects.toThrow(/0\/1/);

      await holder.query('COMMIT');
      expect(await waiter).toBe('got it');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  it('resetData removes the organization\'s patient rows', async () => {
    await insertPerson(pool, 'to-reset');
    await org.resetData();
    expect((await pool.query(`SELECT 1 FROM patient_persons WHERE organization_id = $1`, [org.orgId])).rowCount).toBe(0);
  });

  it('makeUser creates a user with a live session in the organization', async () => {
    const user = await org.makeUser('doctor', '하네스 의사');
    const { rows } = await pool.query<{ organization_id: string; role: string }>(
      `SELECT u.organization_id, u.role FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.id = $1`, [user.sessionId],
    );
    expect(rows).toEqual([{ organization_id: org.orgId, role: 'doctor' }]);
    expect(org.headers(user)).toEqual({ Authorization: `Bearer ${user.token}`, 'X-CSRF-Token': expect.any(String) });
  });
});

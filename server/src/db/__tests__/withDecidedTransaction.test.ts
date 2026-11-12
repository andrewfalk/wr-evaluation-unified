// withDecidedTransaction (S7-0): the callback chooses COMMIT or ROLLBACK. Its statement contract — one
// connect(), only the literals BEGIN / COMMIT / ROLLBACK — is what the order-based patient route tests
// rely on while S7 moves the write paths onto it.
import { describe, expect, it } from 'vitest';
import { createFakePool, pgError } from '../../testing/fakePool';
import { withDecidedTransaction } from '../withWriteTransaction';

function txStatements(fake: ReturnType<typeof createFakePool>): string[] {
  return fake.calls.filter((c) => c.via === 'client').map((c) => c.sql);
}

describe('withDecidedTransaction', () => {
  it('commit: true → BEGIN, the callback, COMMIT; returns the value', async () => {
    const fake = createFakePool({ handlers: [{ name: 'work', match: /^SELECT 1/, reply: { rows: [{ x: 1 }] } }] });
    const value = await withDecidedTransaction(fake.pool, async (client) => {
      await client.query('SELECT 1');
      return { commit: true, value: 'done' };
    });
    expect(value).toBe('done');
    expect(txStatements(fake)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(fake.connected).toBe(1);
    fake.assertAllReleased();
  });

  it('commit: false → ROLLBACK (not COMMIT); still returns the value', async () => {
    const fake = createFakePool();
    const value = await withDecidedTransaction(fake.pool, async () => ({ commit: false, value: { kind: 'not_found' } }));
    expect(value).toEqual({ kind: 'not_found' });
    expect(txStatements(fake)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['rollback']);
    fake.assertAllReleased();
  });

  it('a thrown error → ROLLBACK, release, rethrow', async () => {
    const fake = createFakePool();
    const boom = new Error('boom');
    await expect(withDecidedTransaction(fake.pool, async () => { throw boom; })).rejects.toBe(boom);
    expect(txStatements(fake)).toEqual(['BEGIN', 'ROLLBACK']);
    fake.assertAllReleased();
  });

  it('a failing COMMIT is rolled back and its error rethrown', async () => {
    const fake = createFakePool({ handlers: [{ name: 'commit', match: /^COMMIT$/, reply: pgError('40001') }] });
    await expect(withDecidedTransaction(fake.pool, async () => ({ commit: true, value: 1 }))).rejects.toMatchObject({ code: '40001' });
    expect(txStatements(fake)).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    fake.assertAllReleased();
  });

  it('a failing ROLLBACK after an error does not hide the original error', async () => {
    const fake = createFakePool({ handlers: [{ name: 'rollback', match: /^ROLLBACK$/, reply: new Error('connection lost') }] });
    const boom = new Error('boom');
    await expect(withDecidedTransaction(fake.pool, async () => { throw boom; })).rejects.toBe(boom);
    fake.assertAllReleased();
  });
});

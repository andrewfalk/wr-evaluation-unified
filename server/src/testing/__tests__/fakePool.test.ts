import { describe, it, expect } from 'vitest';
import { createFakePool, authSessionHandler, pgError, sequenceHandler, sqlPreview } from '../fakePool';

describe('createFakePool — SQL routing', () => {
  it('routes by SQL text, so the order of queries does not matter', async () => {
    const fake = createFakePool({
      handlers: [
        { name: 'users', match: /FROM users/, reply: { rows: [{ id: 'u1' }] } },
        { name: 'orgs',  match: /FROM organizations/, reply: { rows: [{ id: 'o1' }] } },
      ],
    });

    const orgs  = await fake.pool.query('SELECT * FROM organizations');
    const users = await fake.pool.query('SELECT * FROM users WHERE id = $1', ['u1']);

    expect(orgs.rows).toEqual([{ id: 'o1' }]);
    expect(users.rows).toEqual([{ id: 'u1' }]);
    expect(users.rowCount).toBe(1);
    expect(fake.calls.map(c => c.handler)).toEqual(['orgs', 'users']);
    expect(fake.callsTo('users')[0]!.params).toEqual(['u1']);
  });

  it('rejects unmatched SQL instead of answering with an empty result, and records it', async () => {
    const fake = createFakePool({ handlers: [{ name: 'users', match: /FROM users/, reply: { rows: [] } }] });

    await expect(fake.pool.query('DELETE FROM patient_records WHERE id = $1', ['p1']))
      .rejects.toThrow(/no handler matched pool query: DELETE FROM patient_records/);
    expect(fake.unmatched).toHaveLength(1);
    expect(() => fake.assertNoUnmatched()).toThrow(/1 unmatched query:\n {2}- \[pool\] DELETE FROM patient_records/);
  });

  it('first matching handler wins; a params predicate narrows the match', async () => {
    const fake = createFakePool({
      handlers: [
        { name: 'admin',  match: /FROM users/, params: p => p[0] === 'admin', reply: { rows: [{ role: 'admin' }] } },
        { name: 'others', match: /FROM users/, reply: { rows: [{ role: 'doctor' }] } },
      ],
    });

    expect((await fake.pool.query('SELECT * FROM users WHERE id = $1', ['admin'])).rows[0]).toEqual({ role: 'admin' });
    expect((await fake.pool.query('SELECT * FROM users WHERE id = $1', ['x'])).rows[0]).toEqual({ role: 'doctor' });
  });

  it('a handler with times stops answering once used up and falls through to the next one', async () => {
    const fake = createFakePool({
      handlers: [
        { name: 'first',    match: /FROM jobs/, times: 1, reply: { rows: [{ n: 1 }] } },
        { name: 'fallback', match: /FROM jobs/, reply: { rows: [{ n: 2 }] } },
      ],
    });

    expect((await fake.pool.query('SELECT * FROM jobs')).rows).toEqual([{ n: 1 }]);
    expect((await fake.pool.query('SELECT * FROM jobs')).rows).toEqual([{ n: 2 }]);
  });

  it('names used-up handlers in the unmatched error', async () => {
    const fake = createFakePool({ handlers: [{ name: 'once', match: /FROM jobs/, times: 1, reply: { rows: [] } }] });
    await fake.pool.query('SELECT * FROM jobs');
    await expect(fake.pool.query('SELECT * FROM jobs')).rejects.toThrow(/already used up their times: once/);
  });

  it('supports reply functions, Error replies (pg error code) and explicit rowCount', async () => {
    const fake = createFakePool({
      handlers: [
        { name: 'echo',   match: /SELECT \$1/, reply: (_sql, params) => ({ rows: [{ v: params[0] }] }) },
        { name: 'dup',    match: /INSERT INTO presets/, reply: pgError('23505') },
        { name: 'update', match: /UPDATE presets/, reply: { rows: [], rowCount: 3 } },
      ],
    });

    expect((await fake.pool.query('SELECT $1', [42])).rows).toEqual([{ v: 42 }]);
    await expect(fake.pool.query('INSERT INTO presets VALUES ($1)', [1])).rejects.toMatchObject({ code: '23505' });
    expect((await fake.pool.query('UPDATE presets SET x = 1')).rowCount).toBe(3);
  });

  it('accepts the { text, values } query config form', async () => {
    const fake = createFakePool({ handlers: [{ name: 'users', match: /FROM users/, reply: { rows: [] } }] });
    await fake.pool.query({ text: 'SELECT * FROM users WHERE id = $1', values: ['u1'] });
    expect(fake.calls[0]!.params).toEqual(['u1']);
  });

  it('a global regex is re-tested from the start every time', async () => {
    const fake = createFakePool({ handlers: [{ name: 'g', match: /FROM users/g, reply: { rows: [] } }] });
    await fake.pool.query('SELECT * FROM users');
    await expect(fake.pool.query('SELECT * FROM users')).resolves.toBeDefined();
  });
});

describe('createFakePool — clients and transactions', () => {
  it('pool.query and client.query share the same handlers and are told apart in calls', async () => {
    const fake = createFakePool({ handlers: [{ name: 'users', match: /FROM users/, reply: { rows: [{ id: 'u1' }] } }] });

    await fake.pool.query('SELECT * FROM users');
    const client = await fake.pool.connect();
    await client.query('SELECT * FROM users');
    client.release();

    expect(fake.calls.map(c => [c.via, c.clientId])).toEqual([['pool', undefined], ['client', 1]]);
  });

  it('records BEGIN → COMMIT and BEGIN → ROLLBACK per client without needing handlers', async () => {
    const fake = createFakePool({ handlers: [{ name: 'insert', match: /INSERT INTO t/, reply: { rows: [] } }] });

    const a = await fake.pool.connect();
    await a.query('BEGIN');
    await a.query('INSERT INTO t VALUES (1)');
    await a.query('SAVEPOINT sp1');
    await a.query('ROLLBACK TO SAVEPOINT sp1');
    await a.query('COMMIT');
    a.release();

    const b = await fake.pool.connect();
    await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await b.query('ROLLBACK');
    b.release();

    expect(fake.transactions).toEqual([
      { clientId: 1, statements: ['BEGIN', 'SAVEPOINT', 'ROLLBACK TO', 'COMMIT'], outcome: 'commit' },
      { clientId: 2, statements: ['BEGIN', 'ROLLBACK'], outcome: 'rollback' },
    ]);
    expect(fake.callsTo('transaction-control')).toHaveLength(6);
  });

  it('a handler can override transaction control; a failed COMMIT keeps the transaction open for the cleanup ROLLBACK', async () => {
    const fake = createFakePool({ handlers: [{ name: 'commit-fails', match: /^COMMIT/, reply: pgError('40001') }] });
    const client = await fake.pool.connect();
    await client.query('BEGIN');
    await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '40001' });
    expect(fake.transactions[0]!.outcome).toBe('open');
    await client.query('ROLLBACK');
    client.release();
    expect(fake.transactions).toEqual([
      { clientId: 1, statements: ['BEGIN', 'COMMIT (failed)', 'ROLLBACK'], outcome: 'rollback' },
    ]);
    expect(fake.callsTo('commit-fails')).toHaveLength(1);
  });

  it('a failed BEGIN (reply function that throws) opens no transaction', async () => {
    const fake = createFakePool({
      handlers: [{ name: 'begin-fails', match: /^BEGIN/, reply: () => { throw pgError('57P01'); } }],
    });
    const client = await fake.pool.connect();
    await expect(client.query('BEGIN')).rejects.toMatchObject({ code: '57P01' });
    client.release();
    expect(fake.transactions).toEqual([]);
  });

  it('records transaction control written with a trailing semicolon', async () => {
    const fake = createFakePool();
    const a = await fake.pool.connect();
    await a.query('BEGIN;');
    await a.query('COMMIT;');
    a.release();
    const b = await fake.pool.connect();
    await b.query('begin;');
    await b.query('rollback;');
    b.release();
    expect(fake.transactions).toEqual([
      { clientId: 1, statements: ['BEGIN', 'COMMIT'], outcome: 'commit' },
      { clientId: 2, statements: ['BEGIN', 'ROLLBACK'], outcome: 'rollback' },
    ]);
  });

  it('rejects transaction control sent through pool.query', async () => {
    const fake = createFakePool();
    await expect(fake.pool.query('BEGIN')).rejects.toThrow(/sent through pool\.query/);
    expect(fake.unmatched).toHaveLength(1);
  });

  it('detects leaked clients, double release and use after release', async () => {
    const fake = createFakePool({ handlers: [{ name: 'any', match: () => true, reply: { rows: [] } }] });
    const a = await fake.pool.connect();
    const b = await fake.pool.connect();
    a.release();

    expect(fake.connected).toBe(2);
    expect(fake.released).toBe(1);
    expect(() => fake.assertAllReleased()).toThrow(/1 client\(s\) not released: #2/);
    expect(() => a.release()).toThrow(/release\(\) called twice/);
    await expect(a.query('SELECT 1')).rejects.toThrow(/used after release/);

    b.release();
    expect(() => fake.assertAllReleased()).not.toThrow();
  });
});

describe('sequenceHandler (S3 / P1-11 compatibility shim)', () => {
  it('answers in call order regardless of SQL, then stops — the next query is unmatched, not an empty result', async () => {
    const fake = createFakePool({ handlers: [sequenceHandler([{ rows: [{ n: 1 }] }, { rowCount: 3 }, pgError('23505')])] });
    expect((await fake.pool.query('SELECT a')).rows).toEqual([{ n: 1 }]);
    expect((await fake.pool.query('UPDATE b')).rowCount).toBe(3);
    await expect(fake.pool.query('INSERT c')).rejects.toMatchObject({ code: '23505' });
    await expect(fake.pool.query('SELECT d')).rejects.toThrow(/no handler matched pool query: SELECT d \(matching handler\(s\) already used up their times: sequence\)/);
    expect(fake.unmatched).toHaveLength(1);
    expect(fake.callsTo('sequence')).toHaveLength(3);
  });

  it('consumes transaction control too by default, like a mockResolvedValueOnce queue on client.query', async () => {
    const fake = createFakePool({ handlers: [sequenceHandler([{ rows: [] }, { rows: [{ id: 's1' }] }, { rows: [] }], { via: 'client' })] });
    const client = await fake.pool.connect();
    await client.query('BEGIN');
    expect((await client.query('SELECT id FROM sessions')).rows).toEqual([{ id: 's1' }]);
    await client.query('COMMIT');
    client.release();
    expect(fake.transactions).toEqual([{ clientId: 1, statements: ['BEGIN', 'COMMIT'], outcome: 'commit' }]);
    fake.assertAllReleased();
  });

  it('once used up, transaction control is rejected too (not the default empty reply)', async () => {
    const fake = createFakePool({ handlers: [sequenceHandler([{ rows: [] }], { via: 'client' })] });
    const client = await fake.pool.connect();
    await client.query('BEGIN');
    await expect(client.query('COMMIT')).rejects.toThrow(/no handler matched client query: COMMIT .*already used up their times: sequence/);
    client.release();
    expect(fake.unmatched.map(c => c.sql)).toEqual(['COMMIT']);
    expect(() => fake.assertNoUnmatched()).toThrow(/1 unmatched query/);
    // An ordinary handler with times keeps the default for transaction control.
    const plain = createFakePool({ handlers: [{ name: 'once', match: () => true, times: 1, reply: { rows: [] } }] });
    const c2 = await plain.pool.connect();
    await c2.query('BEGIN');
    await expect(c2.query('COMMIT')).resolves.toMatchObject({ rows: [] });
    c2.release();
    plain.assertNoUnmatched();
  });

  it('separate pool and client queues with via', async () => {
    const fake = createFakePool({
      handlers: [
        sequenceHandler([{ rows: [{ q: 'pool-1' }] }], { name: 'pool-seq', via: 'pool' }),
        sequenceHandler([{ rows: [{ q: 'client-1' }] }], { name: 'client-seq', via: 'client' }),
      ],
    });
    const client = await fake.pool.connect();
    expect((await client.query('SELECT 1')).rows).toEqual([{ q: 'client-1' }]);
    expect((await fake.pool.query('SELECT 1')).rows).toEqual([{ q: 'pool-1' }]);
    client.release();
    expect(fake.calls.map(c => `${c.via}:${c.handler}`)).toEqual(['client:client-seq', 'pool:pool-seq']);
  });

  it('an optional match narrows which queries the sequence answers', async () => {
    const fake = createFakePool({
      handlers: [
        authSessionHandler(),
        sequenceHandler([{ rows: [{ a: 1 }] }, { rows: [{ a: 2 }] }], { match: /FROM presets/ }),
      ],
    });
    await fake.pool.query('SELECT s.revoked_at, u.disabled_at FROM sessions s JOIN users u ON u.id = s.user_id');
    expect((await fake.pool.query('SELECT * FROM presets')).rows).toEqual([{ a: 1 }]);
    expect((await fake.pool.query('SELECT * FROM presets')).rows).toEqual([{ a: 2 }]);
    fake.assertNoUnmatched();
  });
});

describe('via filter', () => {
  it("a handler with via: 'pool' does not answer client queries", async () => {
    const fake = createFakePool({ handlers: [{ name: 'pool-only', match: /SELECT/, via: 'pool', reply: { rows: [] } }] });
    const client = await fake.pool.connect();
    await expect(client.query('SELECT 1')).rejects.toThrow(/no handler matched client query/);
    client.release();
    await expect(fake.pool.query('SELECT 1')).resolves.toMatchObject({ rows: [] });
  });
});

describe('authSessionHandler', () => {
  it('answers the auth middleware session query with a live, enabled user by default', async () => {
    const fake = createFakePool({ handlers: [authSessionHandler()] });
    const sql = `SELECT u.disabled_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = $1`;
    expect((await fake.pool.query(sql, ['s', 'u'])).rows).toEqual([{ disabled_at: null }]);
  });

  it('can model a revoked session or a disabled user', async () => {
    const sql = 'SELECT u.disabled_at FROM sessions s JOIN users u ON u.id = s.user_id';
    const revoked = createFakePool({ handlers: [authSessionHandler({ revoked: true })] });
    const disabled = createFakePool({ handlers: [authSessionHandler({ disabledAt: '2026-01-01T00:00:00Z' })] });
    expect((await revoked.pool.query(sql)).rows).toEqual([]);
    expect((await disabled.pool.query(sql)).rows).toEqual([{ disabled_at: '2026-01-01T00:00:00Z' }]);
  });
});

describe('sqlPreview', () => {
  it('collapses whitespace and truncates long SQL', () => {
    expect(sqlPreview('SELECT *\n   FROM  users')).toBe('SELECT * FROM users');
    expect(sqlPreview(`SELECT ${'x'.repeat(300)}`)).toMatch(/…$/);
  });
});

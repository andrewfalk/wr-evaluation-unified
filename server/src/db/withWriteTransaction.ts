import type { Pool, PoolClient } from 'pg';

// PR1 §4 — stats/routes/analyzeHandler.ts에서 이관(PR4-B1). admission/finishRun/취소 핸들러가
// 전부 "감사와 상태전이를 같은 트랜잭션으로 묶는다"는 같은 원칙을 쓰므로 공용 헬퍼로
// 뽑는다 — 로직 복제가 아니라 단일 진실원.
export async function withWriteTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** What `withDecidedTransaction`'s callback returns: whether to commit, and the value to hand back. */
export interface TransactionDecision<T> {
  commit: boolean;
  value: T;
}

/**
 * Like `withWriteTransaction`, but the callback decides between COMMIT and ROLLBACK (S7). The patient
 * write paths end most outcomes — 404, 409, 423, … — with a ROLLBACK and an ordinary result rather than
 * an error; committing those would keep side effects such as a newly created person.
 *
 * Statement contract (the order-based route tests depend on it): one `pool.connect()`, and only the
 * literal statements 'BEGIN', 'COMMIT' and 'ROLLBACK' — no SET LOCAL, SAVEPOINT or isolation level.
 * A thrown error rolls back (a failed ROLLBACK is ignored) and is rethrown.
 */
export async function withDecidedTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<TransactionDecision<T>>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const decision = await fn(client);
    if (decision.commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return decision.value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

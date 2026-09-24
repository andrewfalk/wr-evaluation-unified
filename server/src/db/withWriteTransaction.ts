import type { Pool, PoolClient } from 'pg';

// PR1 §4 — statsAnalyzeHandler.ts에서 이관(PR4-B1). admission/finishRun/취소 핸들러가
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

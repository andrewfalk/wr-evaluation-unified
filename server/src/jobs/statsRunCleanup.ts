import type { Pool } from 'pg';

// PR1 §8 — stats_runs 저장공간 정리. 정확성(TTL 캐시 유효성)에는 불필요하다 — 만료된
// cacheable 행의 교체는 이미 요청 처리 시점(statsAnalyzeHandler.ts의 DELETE-then-INSERT)이
// 올바르게 처리한다. 이 job은 순수 저장공간 회수용이라 늦게 돌거나 잠깐 꺼져 있어도 idempotency
// 캐시의 TTL 준수 자체는 깨지지 않는다. status와 무관하게(요청단위 억제 행·failed 행 포함)
// 만료된 모든 행을 지운다.
export async function runStatsRunCleanup(pool: Pool): Promise<{ deleted: number }> {
  const result = await pool.query(`DELETE FROM stats_runs WHERE expires_at < now()`);
  return { deleted: result.rowCount ?? 0 };
}

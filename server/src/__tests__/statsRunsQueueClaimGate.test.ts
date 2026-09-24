// 코드리뷰(2026-09-24) — claimTick이 claim 전에 isEngineSlotAvailable()을 확인하지
// 않으면, §C-1(limited_row 진단 재계산)처럼 큐 밖에서 같은 전역 엔진 세마포어를
// 점유하는 호출이 있는 동안 매 claimIntervalMs(기본 500ms)마다 "claim(running)→
// BUSY→requeueOrFinish(다시 queued)"가 반복돼, 정상적으로 대기 중인 작업이
// maxRequeueCount(기본 20)를 몇 초~수십 초 안에 소진하고 대기예산(10분)이 한참
// 남았는데도 PROCESS_ERROR로 잘못 종결된다. 이 테스트는 pool.query를 스파이로
// 감싼 가짜 pool + fake timer로, 슬롯이 비어있지 않은 동안은 claim SQL 자체가
// 전혀 발사되지 않고, 슬롯이 열리면 즉시 재개되는지 확인한다(실제 DB·엔진 불필요 —
// claimTick의 게이트 로직 자체가 검증 대상).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

const isEngineSlotAvailable = vi.hoisted(() => vi.fn(() => true));
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, isEngineSlotAvailable: () => isEngineSlotAvailable() };
});

import { createStatsRunsQueueWorker } from '../statsRunsQueue';
import config from '../config';

function isClaimSql(sql: unknown): boolean {
  return typeof sql === 'string' && sql.includes("SET status='running'");
}

describe('createStatsRunsQueueWorker — claimTick의 엔진 슬롯 게이트', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isEngineSlotAvailable.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('슬롯이 비어있지 않으면 claim SQL 자체를 시도하지 않는다(BUSY→재큐잉 소진 방지)', async () => {
    isEngineSlotAvailable.mockReturnValue(false);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    const worker = createStatsRunsQueueWorker(pool);
    try {
      // claimIntervalMs(기본 500ms) 동안 여러 tick이 지나도 — sweepIntervalMs(기본
      // 2000ms)보다 짧게 잡아 sweep 호출과 섞이지 않게 한다.
      const elapsed = config.stats.async.claimIntervalMs * 3;
      expect(elapsed).toBeLessThan(config.stats.async.sweepIntervalMs);
      await vi.advanceTimersByTimeAsync(elapsed);

      expect(isEngineSlotAvailable).toHaveBeenCalled();
      expect(query.mock.calls.some((c) => isClaimSql(c[0]))).toBe(false);
    } finally {
      worker.stop();
    }
  });

  it('슬롯이 열리면 다음 tick부터 즉시 claim SQL을 재개한다', async () => {
    isEngineSlotAvailable.mockReturnValue(false);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    const worker = createStatsRunsQueueWorker(pool);
    try {
      await vi.advanceTimersByTimeAsync(config.stats.async.claimIntervalMs);
      expect(query.mock.calls.some((c) => isClaimSql(c[0]))).toBe(false);

      isEngineSlotAvailable.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(config.stats.async.claimIntervalMs);
      expect(query.mock.calls.some((c) => isClaimSql(c[0]))).toBe(true);
    } finally {
      worker.stop();
    }
  });
});

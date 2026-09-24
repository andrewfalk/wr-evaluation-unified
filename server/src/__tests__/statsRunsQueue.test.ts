// PR4-B1 §5(버전 드리프트) — hasVersionDrifted는 DB 없이도 검증 가능한 순수 함수다
// (statsExecutionDigest.computeExecutionDigest 재계산 + 문자열 비교뿐). statsRunsQueue.ts의
// 나머지(finishRun/requeueOrFinish/claimNextQueuedRun/sweep*/requestCancel)는 실제 Postgres
// 잠금·트랜잭션 직렬화가 검증의 핵심이라 statsRunsQueue.integration.test.ts에서 다룬다.
import { describe, it, expect } from 'vitest';
import { hasVersionDrifted } from '../statsRunsQueue';
import { computeExecutionDigest } from '../statsExecutionDigest';
import type { StatsRunRow } from '../statsRunRow';

function rowWith(executionDigest: string): StatsRunRow {
  return {
    organization_id: 'org-1',
    requested_by: 'user-1',
    recipe_digest: 'recipe-1',
    source_digest: 'source-1',
    execution_digest: executionDigest,
  } as StatsRunRow;
}

describe('hasVersionDrifted', () => {
  it('저장된 execution_digest가 현재 코드로 재계산한 값과 일치하면 false', () => {
    const executionDigest = computeExecutionDigest({
      organizationId: 'org-1', requestedBy: 'user-1', recipeDigest: 'recipe-1', sourceDigest: 'source-1',
    });
    expect(hasVersionDrifted(rowWith(executionDigest))).toBe(false);
  });

  it('저장된 execution_digest가 재계산 값과 다르면(버전 상수 변경 시뮬레이션) true', () => {
    expect(hasVersionDrifted(rowWith('stale-digest-from-old-code'))).toBe(true);
  });

  it('requested_by가 NULL(사용자 삭제됨)이어도 재계산 시 빈 문자열로 취급해 일관되게 비교한다', () => {
    const executionDigest = computeExecutionDigest({
      organizationId: 'org-1', requestedBy: '', recipeDigest: 'recipe-1', sourceDigest: 'source-1',
    });
    const row = { ...rowWith(executionDigest), requested_by: null } as StatsRunRow;
    expect(hasVersionDrifted(row)).toBe(false);
  });
});

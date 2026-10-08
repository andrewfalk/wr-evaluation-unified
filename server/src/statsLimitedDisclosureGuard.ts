// 제한데이터 권한자 기술통계 해제(statsDescriptiveUnrestricted.ts)의 자원 보호 장치 두 가지.
//  - 사용자당 동시 1건 잠금: 같은 사용자가 엔진을 연달아 두드리는 것을 막는다.
//  - 짧은 프로세스 메모리 memo: 같은 (executionDigest, userId)의 해제 결과를 잠깐만 재사용한다.
// 둘 다 프로세스 메모리에만 있고 DB에 저장하지 않는다. 권한 검사는 memo 조회 "전에" 호출부가
// 매번 하므로, 권한이 회수되면 memo에 남은 값도 다음 응답부터 쓰이지 않는다.
import type { AnalyzeResult } from '@wr/contracts';
import { LIMITED_DESCRIPTIVE_RECOMPUTE } from './statsPolicy';

const inFlightUsers = new Set<string>();

/** 이미 이 사용자의 해제 계산이 진행 중이면 false. true를 받으면 반드시 release를 finally에서 호출한다. */
export function tryAcquireUserLock(userId: string): boolean {
  if (inFlightUsers.has(userId)) return false;
  inFlightUsers.add(userId);
  return true;
}

export function releaseUserLock(userId: string): void {
  inFlightUsers.delete(userId);
}

interface MemoEntry { result: AnalyzeResult; expiresAt: number }
const memo = new Map<string, MemoEntry>();

function memoKey(executionDigest: string, userId: string): string {
  return `${executionDigest}\u0000${userId}`;
}

export function getMemoizedUnrestricted(executionDigest: string, userId: string, now = Date.now()): AnalyzeResult | null {
  const key = memoKey(executionDigest, userId);
  const entry = memo.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    memo.delete(key);
    return null;
  }
  return entry.result;
}

export function memoizeUnrestricted(executionDigest: string, userId: string, result: AnalyzeResult, now = Date.now()): void {
  const key = memoKey(executionDigest, userId);
  memo.delete(key); // 갱신 시 삽입 순서를 맨 뒤로 옮긴다.
  memo.set(key, { result, expiresAt: now + LIMITED_DESCRIPTIVE_RECOMPUTE.memoTtlMs });
  // 가장 오래된(삽입 순서 앞쪽) 항목부터 제거하되 방금 넣은 것은 지키지 않을 이유가 없으므로 그대로 둔다.
  while (memo.size > LIMITED_DESCRIPTIVE_RECOMPUTE.memoMaxEntries) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    memo.delete(oldest);
  }
}

/** 테스트 전용 — 프로세스 전역 상태를 비운다. */
export function __resetLimitedDisclosureGuardForTests(): void {
  inFlightUsers.clear();
  memo.clear();
}

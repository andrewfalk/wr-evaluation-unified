// 커밋 배리어(REFACTORING_ROADMAP Phase 2 P2-39b) — "방금 예약한 상태 갱신이 커밋된 뒤"를 기다린다.
//
// `next()`는 tick을 하나 올려 예약하고, 그 tick 이상이 반영된 커밋의 effect에서 풀리는 promise를 돌려준다. 같은 동기 구간에서
// 예약한 상태 갱신(예: setPatients(전이))은 tick과 한 배치로 같은 커밋에 들어가므로, 풀린 시점에는 그 전이가 이미 적용돼 있다.
// 대기마다 자기 tick을 기록하고 **렌더된 tick 이하인 대기만** 푼다 — 이전 커밋의 effect가 아직 커밋되지 않은 다음 예약까지
// 풀면 그 전이의 결과(receipt)를 읽기 전에 판정하게 된다(#323 Codex 2회차). usePatientSync의 outcomeTick과 같은 방식.
// 언마운트되면 남은 대기를 모두 푼다(무한 대기 방지 — 호출부는 결과가 없을 수 있음을 처리한다).
import { useCallback, useEffect, useRef, useState } from 'react';

interface Waiter {
  tick: number;
  resolve: () => void;
}

/** 렌더된 tick까지의 대기와 나머지로 나눈다(순수 — 테스트용으로 내보냄). */
export function splitReadyWaiters<T extends { tick: number }>(waiters: T[], committedTick: number): { ready: T[]; rest: T[] } {
  const ready: T[] = [];
  const rest: T[] = [];
  for (const w of waiters) (w.tick <= committedTick ? ready : rest).push(w);
  return { ready, rest };
}

export function useCommitBarrier(): () => Promise<void> {
  const [tick, setTick] = useState(0);
  const counterRef = useRef(0);
  const waitersRef = useRef<Waiter[]>([]);
  // 언마운트 상태 — 언마운트 뒤의 next()는 다시 풀어 줄 effect가 없으므로 즉시 푼다(#323 Codex 권고). 초기값은 false라
  // 첫 effect 전(초기 마운트 중) 호출은 정상 대기한다(#324 Codex 권고). StrictMode 개발 모드의 가짜 언마운트 뒤 재마운트에서
  // 다시 false로 돌리도록 setup에서도 세운다(cleanup에서만 바꾸는 ref 금지).
  const unmountedRef = useRef(false);

  useEffect(() => {
    const { ready, rest } = splitReadyWaiters(waitersRef.current, tick);
    waitersRef.current = rest;
    ready.forEach(w => w.resolve());
  }, [tick]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      // 언마운트(또는 StrictMode 개발 모드의 가짜 언마운트) — 남은 대기를 푼다.
      unmountedRef.current = true;
      const all = waitersRef.current;
      waitersRef.current = [];
      all.forEach(w => w.resolve());
    };
  }, []);

  return useCallback(() => {
    if (unmountedRef.current) return Promise.resolve();
    counterRef.current += 1;
    const myTick = counterRef.current;
    const committed = new Promise<void>(resolve => { waitersRef.current.push({ tick: myTick, resolve }); });
    setTick(myTick);
    return committed;
  }, []);
}

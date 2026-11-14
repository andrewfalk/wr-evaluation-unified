// @vitest-environment jsdom
//
// useCommitBarrier(REFACTORING_ROADMAP Phase 2 P2-39b) — 대기마다 자기 tick을 기록하고, 렌더된 tick 이하인 대기만 푼다
// (#323 Codex 2회차: 이전 커밋의 effect가 아직 커밋되지 않은 다음 예약까지 풀면 그 전이의 결과를 읽기 전에 판정한다). StrictMode.
import { afterEach, describe, expect, it } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { splitReadyWaiters, useCommitBarrier } from '../useCommitBarrier';

afterEach(cleanup);

describe('splitReadyWaiters', () => {
  it('렌더된 tick 이하만 푼다 — 그보다 큰 tick(아직 커밋 안 된 예약)은 남긴다', () => {
    const waiters = [{ tick: 1 }, { tick: 2 }, { tick: 3 }];
    expect(splitReadyWaiters(waiters, 1)).toEqual({ ready: [{ tick: 1 }], rest: [{ tick: 2 }, { tick: 3 }] });
    expect(splitReadyWaiters(waiters, 3).rest).toEqual([]);
    expect(splitReadyWaiters(waiters, 0).ready).toEqual([]);
  });
});

function renderBarrier() {
  return renderHook(() => {
    const next = useCommitBarrier();
    const [value, setValue] = useState(0);
    return { next, value, setValue };
  }, { wrapper: StrictMode });
}

describe('useCommitBarrier', () => {
  it('같은 동기 구간에서 예약한 상태 갱신이 커밋된 뒤에 풀린다', async () => {
    const { result } = renderBarrier();
    let seen;
    await act(async () => {
      result.current.setValue(7);
      result.current.next().then(() => { seen = result.current.value; });
    });
    expect(seen).toBe(7);
  });

  it('한 배치의 여러 예약은 모두 풀린다(순서대로)', async () => {
    const { result } = renderBarrier();
    const order = [];
    await act(async () => {
      result.current.next().then(() => order.push(1));
      result.current.next().then(() => order.push(2));
    });
    expect(order).toEqual([1, 2]);
  });

  it('언마운트하면 남은 대기를 푼다(무한 대기 방지)', async () => {
    const { result, unmount } = renderBarrier();
    let resolved = false;
    // 커밋 전에 언마운트되도록 act 밖에서 예약하고 바로 언마운트한다.
    const p = result.current.next().then(() => { resolved = true; });
    unmount();
    await p;
    expect(resolved).toBe(true);
  });

  it('언마운트 뒤에 예약한 대기도 바로 풀린다(#323 Codex 권고 — 언마운트 후 도착한 응답)', async () => {
    const { result, unmount } = renderBarrier();
    const next = result.current.next;
    unmount();
    let resolved = false;
    await next().then(() => { resolved = true; });
    expect(resolved).toBe(true);
  });
});

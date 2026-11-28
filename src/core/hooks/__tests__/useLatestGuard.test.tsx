// @vitest-environment jsdom
//
// 순번 가드 useLatestGuard(P2-83b) — 마지막 불러오기만 true, 언마운트 뒤 false, StrictMode의 effect 재실행 뒤에도 true.
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useLatestGuard } from '../useLatestGuard';

afterEach(cleanup);

describe('useLatestGuard', () => {
  it('새 불러오기를 시작하면 앞 불러오기는 더는 마지막이 아니다', () => {
    const { result } = renderHook(() => useLatestGuard());
    const first = result.current();
    expect(first()).toBe(true);
    const second = result.current();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('다시 그려도 같은 함수이고 순번은 이어진다', () => {
    const { result, rerender } = renderHook(() => useLatestGuard());
    const begin = result.current;
    const first = begin();
    rerender();
    expect(result.current).toBe(begin);
    expect(first()).toBe(true);
    result.current();
    expect(first()).toBe(false);
  });

  it('언마운트 뒤에는 마지막 불러오기도 false', () => {
    const { result, unmount } = renderHook(() => useLatestGuard());
    const isLatest = result.current();
    unmount();
    expect(isLatest()).toBe(false);
  });

  it('StrictMode(effect setup → cleanup → setup)에서도 마운트된 채로 true', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result, unmount } = renderHook(() => useLatestGuard(), { wrapper });
    const isLatest = result.current();
    expect(isLatest()).toBe(true);
    unmount();
    expect(isLatest()).toBe(false);
  });
});

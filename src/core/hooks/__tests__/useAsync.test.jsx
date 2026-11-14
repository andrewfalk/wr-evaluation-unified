// @vitest-environment jsdom
// useAsync(REFACTORING_ROADMAP Phase 2 P2-19) — StrictMode 렌더로(cleanup에서만 값을 세우는 ref 함정 검사).
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAsync } from '../useAsync';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const render = () => renderHook(() => useAsync(), { wrapper: StrictMode });

describe('useAsync', () => {
  it('idle → pending → success, StrictMode 마운트 뒤에도 결과가 반영된다', async () => {
    const { result } = render();
    expect(result.current).toMatchObject({ status: 'idle', data: undefined, error: undefined });
    const d = deferred();
    let p;
    act(() => { p = result.current.run(() => d.promise); });
    expect(result.current.status).toBe('pending');
    await act(async () => { d.resolve({ a: 1 }); await p; });
    expect(result.current).toMatchObject({ status: 'success', data: { a: 1 } });
  });

  it('실패: status error + error, 마지막 data는 유지, run은 거부하지 않고 undefined', async () => {
    const { result } = render();
    await act(async () => { await result.current.run(async () => 'first'); });
    let out = 'unset';
    const boom = new Error('boom');
    await act(async () => { out = await result.current.run(async () => { throw boom; }); });
    expect(out).toBeUndefined();
    expect(result.current).toMatchObject({ status: 'error', data: 'first', error: boom });
  });

  it('늦게 도착한 앞선 응답은 버린다(나중 run이 이긴다)', async () => {
    const { result } = render();
    const slow = deferred();
    const fast = deferred();
    act(() => { result.current.run(() => slow.promise); });
    act(() => { result.current.run(() => fast.promise); });
    await act(async () => { fast.resolve('fast'); await fast.promise; });
    await act(async () => { slow.resolve('slow'); await slow.promise; });
    expect(result.current.data).toBe('fast');
  });

  it('cancel 뒤 결과는 반영하지 않고 상태는 그대로, reset은 idle로', async () => {
    const { result } = render();
    await act(async () => { await result.current.run(async () => 'kept'); });
    const d = deferred();
    act(() => { result.current.run(() => d.promise); });
    act(() => { result.current.cancel(); });
    await act(async () => { d.resolve('late'); await d.promise; });
    expect(result.current.data).toBe('kept');
    act(() => { result.current.reset(); });
    expect(result.current).toMatchObject({ status: 'idle', data: undefined });
  });

  it('언마운트 뒤 응답은 상태를 바꾸지 않는다(경고·오류 없음)', async () => {
    const { result, unmount } = render();
    const d = deferred();
    let p;
    act(() => { p = result.current.run(() => d.promise); });
    unmount();
    d.resolve('after');
    await expect(p).resolves.toBe('after');
  });

  it('run·cancel·reset은 렌더 사이에 같은 함수(의존성 배열에 넣어도 effect가 다시 돌지 않음)', async () => {
    const { result, rerender } = render();
    const first = result.current;
    rerender();
    await waitFor(() => expect(result.current.run).toBe(first.run));
    expect(result.current.cancel).toBe(first.cancel);
    expect(result.current.reset).toBe(first.reset);
  });
});

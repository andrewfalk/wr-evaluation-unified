// @vitest-environment jsdom
//
// 로그인 직전 로컬 작업 보존(계정 전환 수정 AS-4) — 주인 없는 로컬 목록만, 불리는 시점의 최신 목록을 쓰고, 저장을 기다리는 사이
// 목록이 바뀌면(예: 자동저장 복원이 끝남) 최종 목록까지 저장한 뒤에 돌아간다. StrictMode.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('../../core/utils/storage', () => ({ saveAutoSave: vi.fn(async () => {}) }));

import { saveAutoSave } from '../../core/utils/storage';
import { useLocalWorkBeforeLogin } from '../useLocalWorkBeforeLogin';

function render(initial) {
  return renderHook(({ patients, owner }) => useLocalWorkBeforeLogin({ patients, getWorkspaceOwner: () => owner }), {
    initialProps: initial, wrapper: StrictMode,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('useLocalWorkBeforeLogin', () => {
  it('주인 없는 로컬 목록을 쓴다 / 주인이 있거나 비어 있으면 쓰지 않는다', async () => {
    const local = ['로컬'];
    const a = render({ patients: local, owner: null });
    await act(async () => { await a.result.current(); });
    expect(saveAutoSave).toHaveBeenCalledWith(local);

    vi.clearAllMocks();
    const b = render({ patients: ['다른 계정'], owner: 'srv|a|org' });
    await act(async () => { await b.result.current(); });
    const c = render({ patients: [], owner: null });
    await act(async () => { await c.result.current(); });
    expect(saveAutoSave).not.toHaveBeenCalled();
  });

  it('불리는 시점의 최신 목록을 쓴다(제출 당시 클로저가 아니다)', async () => {
    const view = render({ patients: [], owner: null });
    const fn = view.result.current;
    view.rerender({ patients: ['복원된 목록'], owner: null });
    await act(async () => { await fn(); });
    expect(saveAutoSave).toHaveBeenCalledWith(['복원된 목록']);
  });

  it('저장을 기다리는 사이 목록이 바뀌면 최종 목록까지 저장한 뒤 돌아간다', async () => {
    const first = deferred();
    saveAutoSave.mockImplementationOnce(() => first.promise);
    const L = ['처음 목록'];
    const S = ['복원된 목록'];
    const view = render({ patients: L, owner: null });
    let done = false;
    let pending;
    act(() => { pending = view.result.current().then(() => { done = true; }); });
    await vi.waitFor(() => expect(saveAutoSave).toHaveBeenCalledTimes(1)); // L의 저장이 시작됨
    view.rerender({ patients: S, owner: null });
    await act(async () => { first.resolve(); await Promise.resolve(); });
    await act(async () => { await pending; });
    expect(done).toBe(true);
    expect(saveAutoSave.mock.calls.map(([list]) => list)).toEqual([L, S]);
  });

  it('저장에 실패하면 던진다(로그인 화면이 알리고 로그인하지 않는다)', async () => {
    saveAutoSave.mockRejectedValueOnce(new Error('quota'));
    const view = render({ patients: ['로컬'], owner: null });
    await expect(view.result.current()).rejects.toThrow('quota');
  });
});

describe('useLocalWorkBeforeLogin — 진행 중인 자동저장 복원과 직렬화', () => {
  it('복원이 끝날 때까지 기다린 뒤 그때의 최신 목록을 쓴다', async () => {
    let finishRestore;
    const restore = new Promise((r) => { finishRestore = r; });
    const view = renderHook(({ patients }) => useLocalWorkBeforeLogin({
      patients, getWorkspaceOwner: () => null, waitForPendingRestore: () => restore,
    }), { initialProps: { patients: ['처음 목록'] }, wrapper: StrictMode });
    let pending;
    act(() => { pending = view.result.current(); });
    await act(async () => { await Promise.resolve(); });
    expect(saveAutoSave).not.toHaveBeenCalled(); // 복원이 끝나기 전에는 쓰지 않는다
    view.rerender({ patients: ['복원된 목록'] });
    await act(async () => { finishRestore(); await pending; });
    expect(saveAutoSave.mock.calls.map(([list]) => list)).toEqual([['복원된 목록']]);
  });

  it('상한 직전 회차에서 안정되면 성공으로 돌아간다(마지막 저장 뒤에도 다시 확인)', async () => {
    const view = render({ patients: ['v0'], owner: null });
    const saves = [];
    saveAutoSave.mockImplementation(() => { const d = deferred(); saves.push(d); return d.promise; });
    let done = false;
    let pending;
    act(() => { pending = view.result.current().then(() => { done = true; }); });
    for (let i = 1; i <= 4; i += 1) { // 처음 네 번은 저장하는 사이 목록이 바뀜
      await vi.waitFor(() => expect(saves).toHaveLength(i));
      view.rerender({ patients: [`v${i}`], owner: null });
      await act(async () => { saves[i - 1].resolve(); });
    }
    await vi.waitFor(() => expect(saves).toHaveLength(5));
    await act(async () => { saves[4].resolve(); await pending; });
    expect(done).toBe(true);
    expect(saveAutoSave).toHaveBeenCalledTimes(5);
  });
});

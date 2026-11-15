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

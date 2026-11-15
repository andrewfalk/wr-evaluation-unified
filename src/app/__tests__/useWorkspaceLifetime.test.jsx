// @vitest-environment jsdom
//
// 화면 수명 도우미(계정 전환 수정 AS-4) — 언마운트되면 isAlive()가 false, 감싼 알림·확인창은 띄우지 않는다. StrictMode의
// 시험 언마운트 뒤 다시 마운트되면 살아 있는 것으로 돌아온다.
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useWorkspaceLifetime } from '../useWorkspaceLifetime';

afterEach(cleanup);

describe('useWorkspaceLifetime', () => {
  it('마운트 중에는 살아 있고(StrictMode 재마운트 포함) 언마운트되면 죽는다', () => {
    const { result, unmount } = renderHook(() => useWorkspaceLifetime(), { wrapper: StrictMode });
    expect(result.current.isAlive()).toBe(true);
    const { isAlive } = result.current;
    unmount();
    expect(isAlive()).toBe(false);
  });

  it('감싼 알림·확인창: 살아 있을 때만 띄우고, 묻는 동안 내려가면 false', async () => {
    const alert = vi.fn(async () => {});
    let answer;
    const confirm = vi.fn(() => new Promise((r) => { answer = r; }));
    const { result, unmount } = renderHook(() => useWorkspaceLifetime(), { wrapper: StrictMode });
    const alertAlive = result.current.guardAlert(alert);
    const confirmAlive = result.current.guardConfirm(confirm);

    await alertAlive('a');
    expect(alert).toHaveBeenCalledWith('a');

    const pending = confirmAlive('q');
    unmount();
    answer(true);
    await expect(pending).resolves.toBe(false);

    await alertAlive('b');
    await expect(confirmAlive('q2')).resolves.toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
// PR2 §4 (v7) — refetchConfig()가 초기적재 상태(loading/error, App 전역 부팅 게이트가 읽는 값)와
// 완전히 분리되어 있는지, A→B→A 왕복·모드만 바뀌는 전환·타임아웃·연결 전환 시 정리를 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const requestJson = vi.fn();
vi.mock('../../services/httpClient', () => ({ requestJson: (...a) => requestJson(...a) }));

import { useServerConfig } from '../useServerConfig.js';

function abortableNeverResolving() {
  // requestJson(path, options) — signal은 두 번째 인자(options)에 있다.
  return (_path, { signal } = {}) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('초기적재', () => {
  it('intranet이면 마운트 시 1회 fetch해서 serverConfig를 채운다', async () => {
    requestJson.mockResolvedValueOnce({ statsWorkbenchAvailable: true });
    const { result } = renderHook(() => useServerConfig({ session: { mode: 'intranet', apiBaseUrl: 'https://a' }, settings: {} }));
    await waitFor(() => expect(result.current.configLoading).toBe(false));
    expect(result.current.serverConfig).toEqual({ statsWorkbenchAvailable: true });
  });
});

describe('refetchConfig — 초기적재 상태와 분리', () => {
  async function mountReady(initialConfig = { statsWorkbenchAvailable: false }) {
    requestJson.mockResolvedValueOnce(initialConfig);
    const utils = renderHook(
      (props) => useServerConfig(props),
      { initialProps: { session: { mode: 'intranet', apiBaseUrl: 'https://a' }, settings: {} } },
    );
    await waitFor(() => expect(utils.result.current.configLoading).toBe(false));
    return utils;
  }

  it('재조회는 configLoading/configError(App 부팅 게이트가 읽는 값)를 전혀 건드리지 않는다', async () => {
    const { result } = await mountReady();
    requestJson.mockResolvedValueOnce({ statsWorkbenchAvailable: true });
    await act(async () => { await result.current.refetchConfig(); });
    expect(result.current.serverConfig).toEqual({ statsWorkbenchAvailable: true });
    expect(result.current.configLoading).toBe(false); // 재조회 중에도 절대 true가 되지 않음
    expect(result.current.configError).toBeNull();
  });

  it('재조회 실패는 refreshError에만 반영되고 configError는 그대로 null이다', async () => {
    const { result } = await mountReady();
    requestJson.mockRejectedValueOnce(new Error('network down'));
    await act(async () => { await result.current.refetchConfig(); });
    expect(result.current.refreshError).toBe('network down');
    expect(result.current.configError).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });

  it('진행 중 재조회를 중복 호출하면 이전 요청을 abort하고 최신 요청만 반영된다', async () => {
    const { result } = await mountReady();
    requestJson.mockImplementationOnce(abortableNeverResolving()); // 첫 재조회 — 응답 안 옴(취소될 것)
    requestJson.mockResolvedValueOnce({ statsWorkbenchAvailable: true }); // 두 번째 재조회 — 이게 반영돼야 함
    let firstCall;
    act(() => { firstCall = result.current.refetchConfig(); });
    await act(async () => { await result.current.refetchConfig(); }); // 중복 호출 — 첫 요청 abort
    await firstCall; // abort로 조용히 반환됨(에러 안 던짐)
    expect(result.current.serverConfig).toEqual({ statsWorkbenchAvailable: true });
    expect(result.current.refreshError).toBeNull();
  });

  it('8초 타임아웃은 일반 취소와 달리 refreshError로 표시된다', async () => {
    // waitFor(testing-library)는 실제 타이머로 폴링하므로, 마운트+초기적재 대기까지 끝난
    // 뒤에야 fake timer로 전환한다(그 전에 켜면 waitFor 자체가 멈춘다).
    const { result } = await mountReady();
    vi.useFakeTimers();
    requestJson.mockImplementationOnce(abortableNeverResolving());
    let pending;
    act(() => { pending = result.current.refetchConfig(); });
    await act(async () => { vi.advanceTimersByTime(8000); await pending; });
    expect(result.current.refreshError).toMatch(/시간 초과/);
    expect(result.current.refreshing).toBe(false);
    vi.useRealTimers();
  });

  it('A→B→A 왕복 — 처음 A 요청의 늦은 응답이 두 번째 A 요청 자리를 차지하지 않는다', async () => {
    const { result, rerender } = await mountReady();

    let resolveFirstA;
    requestJson.mockImplementationOnce(() => new Promise((resolve) => { resolveFirstA = resolve; }));
    let firstA;
    act(() => { firstA = result.current.refetchConfig(); });

    // A → B: 연결이 바뀌면 진행 중이던 재조회가 정리된다(§4 수정).
    requestJson.mockResolvedValueOnce({ statsWorkbenchAvailable: false, label: 'B-initial-load' });
    await act(async () => {
      rerender({ session: { mode: 'intranet', apiBaseUrl: 'https://b' }, settings: {} });
      await Promise.resolve();
    });
    expect(result.current.refreshing).toBe(false); // 연결전환 effect가 즉시 정리

    // B → A: 다시 A로. 이 시점에 두 번째 A 재조회를 시작.
    requestJson.mockResolvedValueOnce({ statsWorkbenchAvailable: false, label: 'A-initial-load-2' });
    await act(async () => {
      rerender({ session: { mode: 'intranet', apiBaseUrl: 'https://a' }, settings: {} });
      await Promise.resolve();
    });
    requestJson.mockResolvedValueOnce({ statsWorkbenchAvailable: true, label: 'second-A-refetch' });
    await act(async () => { await result.current.refetchConfig(); });

    // 이제서야 도착한 첫 번째 A 요청의 응답 — 세대가 이미 지나갔으므로 반영되면 안 된다.
    await act(async () => { resolveFirstA({ statsWorkbenchAvailable: false, label: 'stale-first-A' }); await firstA; });

    expect(result.current.serverConfig.label).toBe('second-A-refetch');
  });

  it('주소는 같고 모드만(intranet↔local) 바뀌면 그 사이 도착한 재조회 응답이 반영되지 않는다', async () => {
    const { result, rerender } = await mountReady();

    let resolveIntranetRefetch;
    requestJson.mockImplementationOnce(() => new Promise((resolve) => { resolveIntranetRefetch = resolve; }));
    let pending;
    act(() => { pending = result.current.refetchConfig(); });

    // 주소는 그대로(useAppSettings.js의 switchToLocalMode()처럼 apiBaseUrl은 안 지움), 모드만 local로.
    await act(async () => {
      rerender({ session: { mode: 'local', apiBaseUrl: 'https://a' }, settings: { integrationMode: 'local' } });
      await Promise.resolve();
    });
    expect(result.current.serverConfig).toBeNull(); // local 전환 시 초기적재 effect가 config를 비움

    await act(async () => { resolveIntranetRefetch({ statsWorkbenchAvailable: true }); await pending; });
    expect(result.current.serverConfig).toBeNull(); // 늦게 도착한 intranet 응답이 되살리면 안 된다
  });
});

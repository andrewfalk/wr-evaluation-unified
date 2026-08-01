// @vitest-environment jsdom
//
// revokeServerSession()이 3초 백스톱으로 포기한 뒤 resetToLocalSession()이 실행돼도,
// 그 뒤늦게 성공한 refresh가 setSession()을 호출해 로그아웃한 세션을 되살리면 안 된다.
// useAuthSync가 onRefresh 시작 시점의 authEpoch을 캡처해뒀다가, 결과를 적용하기 직전에
// 재확인(그 사이 resetToLocalSession()이 실행돼 epoch이 바뀌었으면 스킵)하는지 검증한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useAuthSync } from '../useAuthSync.js';

vi.mock('../../services/httpClient', () => ({
  configureHttpClient: vi.fn(),
}));

vi.mock('../../utils/csrfCookie', () => ({
  getCsrfToken: vi.fn(() => 'csrf-token'),
}));

import { configureHttpClient } from '../../services/httpClient';

function makeIntranetSession() {
  return { mode: 'intranet', apiBaseUrl: 'https://srv', accessToken: 'old-tok', user: { id: 'u1' } };
}

function getConfiguredOnRefresh() {
  return vi.mocked(configureHttpClient).mock.calls.at(-1)[0].onRefresh;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useAuthSync — stale refresh after logout', () => {
  it('does not call setSession when the epoch moved on (resetToLocalSession ran) before the refresh resolved', async () => {
    let deferredResolve;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { deferredResolve = resolve; })));

    const setSession = vi.fn();
    const resetToLocalSession = vi.fn();
    let epoch = 0;
    const getAuthEpoch = () => epoch;

    renderHook(() => useAuthSync({
      session: makeIntranetSession(), setSession, resetToLocalSession, getAuthEpoch,
    }));

    const onRefresh = getConfiguredOnRefresh();
    const refreshPromise = onRefresh({ baseUrl: 'https://srv' });

    // Simulates AuthContext.resetToLocalSession() firing after the caller (e.g.
    // revokeServerSession's Promise.race backstop) gave up waiting.
    epoch += 1;

    deferredResolve({
      ok: true,
      json: async () => ({ accessToken: 'new-tok', accessExpiresAt: new Date().toISOString(), user: { id: 'u1' } }),
    });
    await refreshPromise;

    expect(setSession).not.toHaveBeenCalled();
  });

  it('still applies the refresh normally when no reset happened in the meantime', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ accessToken: 'new-tok', accessExpiresAt: new Date().toISOString(), user: { id: 'u1' } }),
    })));

    const setSession = vi.fn();
    const resetToLocalSession = vi.fn();
    const getAuthEpoch = () => 0;

    renderHook(() => useAuthSync({
      session: makeIntranetSession(), setSession, resetToLocalSession, getAuthEpoch,
    }));

    const onRefresh = getConfiguredOnRefresh();
    await onRefresh({ baseUrl: 'https://srv' });

    expect(setSession).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new-tok' }));
  });
});

// The onRefresh-triggered path above is one tab's own refresh. A REFRESH_SUCCESS
// it broadcasts (authChannel.js postRefreshSuccess) is still received by the
// standalone cross-tab listener below in *other* tabs — including a tab that
// already went local (processed an earlier LOGOUT broadcast, or its own logout
// timed out). That listener needs its own guard; the epoch capture above doesn't
// cover it since it isn't tied to a specific request.
describe('useAuthSync — cross-tab REFRESH_SUCCESS broadcast', () => {
  function postRefreshSuccess(overrides = {}) {
    const ch = new BroadcastChannel('wr-auth');
    ch.postMessage({
      type: 'REFRESH_SUCCESS',
      accessToken: 'broadcast-tok',
      accessExpiresAt: new Date().toISOString(),
      user: { id: 'u1' },
      ...overrides,
    });
    ch.close();
  }

  async function flushBroadcast() {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // The real BroadcastChannel('wr-auth') is process-wide (authChannel.js is
  // unmocked here), and other test files (e.g. authRevokeIntegration.test.jsx)
  // exercise the same channel for real. So these assertions target a token
  // unique to this test run rather than relying on exact call counts, which
  // would be flaky under full-suite concurrency.
  function anyCallProducedToken(mockFn, token) {
    return mockFn.mock.calls.some(([updater]) => {
      if (typeof updater !== 'function') return false;
      return updater(makeIntranetSession()).accessToken === token;
    });
  }

  it('ignores a REFRESH_SUCCESS broadcast while this tab is already local', async () => {
    const setSession = vi.fn();
    const resetToLocalSession = vi.fn();
    const token = `ignored-${Math.random().toString(36).slice(2)}`;

    renderHook(({ session }) => useAuthSync({
      session, setSession, resetToLocalSession, getAuthEpoch: () => 0,
    }), { initialProps: { session: { mode: 'local' } } });

    postRefreshSuccess({ accessToken: token });
    await flushBroadcast();

    expect(anyCallProducedToken(setSession, token)).toBe(false);
  });

  it('applies a REFRESH_SUCCESS broadcast normally while this tab is still intranet', async () => {
    const setSession = vi.fn();
    const resetToLocalSession = vi.fn();
    const token = `applied-${Math.random().toString(36).slice(2)}`;

    renderHook(() => useAuthSync({
      session: makeIntranetSession(), setSession, resetToLocalSession, getAuthEpoch: () => 0,
    }));

    postRefreshSuccess({ accessToken: token });
    await flushBroadcast();

    expect(anyCallProducedToken(setSession, token)).toBe(true);
  });
});

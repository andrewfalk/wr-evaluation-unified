// @vitest-environment jsdom
//
// /api/auth/logout authenticates via the refresh cookie, not the Bearer access
// token (server/src/routes/auth.ts), so revokeServerSession() passes
// `_retry: true` to skip httpClient's 401-refresh-and-retry interceptor
// entirely — logout never needs, and must never trigger, a token refresh.
//
// This used to matter a lot: a refresh triggered by a 401 on /logout could
// finish late (after revokeServerSession's Promise.race backstop already gave
// up), and its result — applied via setSession or broadcast to other tabs —
// could resurrect the session logout was trying to kill, or even clobber a
// session created by a subsequent re-login. Skipping refresh removes the
// whole race instead of trying to out-guard it.
//
// Uses the real AuthContext + httpClient + useAuthSync wiring (mirrors
// App.jsx) with only `fetch` mocked, so this is a genuine end-to-end check
// that logout doesn't touch the refresh machinery at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext.jsx';
import { useAuthSync } from '../../hooks/useAuthSync.js';

function Harness({ captureRef }) {
  const auth = useAuth();
  useAuthSync({
    session: auth.session,
    setSession: auth.setSession,
    resetToLocalSession: auth.resetToLocalSession,
    getAuthEpoch: auth.getAuthEpoch,
  });
  captureRef.current = auth;
  return null;
}

function renderHarness() {
  const authRef = { current: null };
  render(<AuthProvider><Harness captureRef={authRef} /></AuthProvider>);
  return authRef;
}

describe('logout() never triggers a token refresh', () => {
  let fetchMock;

  beforeEach(() => {
    document.cookie = 'wr_csrf=csrf-token';
  });

  afterEach(() => {
    cleanup();
    document.cookie = 'wr_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not call /api/auth/refresh or /api/auth/csrf even if /api/auth/logout somehow returns 401', async () => {
    fetchMock = vi.fn((url) => {
      const u = String(url);
      if (u.endsWith('/api/auth/logout')) {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({ code: 'TOKEN_INVALID' }) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const authRef = renderHarness();
    act(() => {
      authRef.current.login(
        { user: { id: 'u1' }, accessToken: 'old-tok', accessExpiresAt: new Date().toISOString() },
        'https://srv'
      );
    });

    await act(async () => {
      await authRef.current.logout();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // just the one /logout attempt — no refresh, no retry
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/auth/logout');
    expect(authRef.current.session.mode).toBe('local');
  });

  it('resets to local immediately on a normal 200 response, with no refresh involved', async () => {
    fetchMock = vi.fn((url) => {
      const u = String(url);
      if (u.endsWith('/api/auth/logout')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const authRef = renderHarness();
    act(() => {
      authRef.current.login(
        { user: { id: 'u1' }, accessToken: 'old-tok', accessExpiresAt: new Date().toISOString() },
        'https://srv'
      );
    });

    await act(async () => {
      await authRef.current.logout();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authRef.current.session.mode).toBe('local');
  });
});

// @vitest-environment jsdom
//
// revokeServerSession()은 _retry: true로 /api/auth/logout을 호출해 httpClient의
// 401-refresh 인터셉터를 아예 타지 않는다(서버가 refresh 쿠키만으로 revoke하므로
// 액세스 토큰 refresh가 필요 없음 — server/src/routes/auth.ts 참고). 여기서는
// 그 플래그가 실제로 전달되는지, 그리고 로컬 상태 리셋보다 서버 폐기를 먼저
// 시도하는 순서(잔여 방어선)가 유지되는지 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext.jsx';

vi.mock('../../services/httpClient', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../../services/httpClient';

function renderAuth() {
  return renderHook(() => useAuth(), { wrapper: AuthProvider });
}

function loginAsIntranet(result) {
  act(() => {
    result.current.login(
      { user: { id: 'u1' }, accessToken: 'tok', accessExpiresAt: new Date().toISOString() },
      'https://srv'
    );
  });
}

beforeEach(() => {
  vi.mocked(requestJson).mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.electron;
});

describe('logout()', () => {
  it('revokes the server session before clearing local state', async () => {
    const { result } = renderAuth();
    loginAsIntranet(result);
    expect(result.current.session.mode).toBe('intranet');

    let sessionModeAtCallTime = null;
    requestJson.mockImplementation(async () => {
      sessionModeAtCallTime = result.current.session.mode;
      return {};
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(sessionModeAtCallTime).toBe('intranet'); // server call happened before the reset
    expect(result.current.session.mode).toBe('local');
    expect(requestJson).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', _retry: true }));
  });

  it('does not call the server for an already-local session', async () => {
    const { result } = renderAuth();
    expect(result.current.session.mode).toBe('local');

    await act(async () => {
      await result.current.logout();
    });

    expect(requestJson).not.toHaveBeenCalled();
  });

  it('does not hang forever if the request never settles (e.g. stuck behind a pending refresh)', async () => {
    vi.useFakeTimers();
    try {
      requestJson.mockImplementation(() => new Promise(() => {})); // never resolves/rejects
      const { result } = renderAuth();
      loginAsIntranet(result);

      let settled = false;
      await act(async () => {
        const logoutPromise = result.current.logout().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(3500); // REVOKE_TIMEOUT_MS(2500) + race buffer(500)
        await logoutPromise;
      });

      expect(settled).toBe(true);
      expect(result.current.session.mode).toBe('local');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Electron quit handshake', () => {
  function setupElectronMocks() {
    let quitCallback = null;
    const notifyQuitLogoutDone = vi.fn();
    window.electron = {
      onQuitRequested: vi.fn((cb) => {
        quitCallback = cb;
        return () => { quitCallback = null; };
      }),
      notifyQuitLogoutDone,
    };
    return { trigger: () => quitCallback(), notifyQuitLogoutDone };
  }

  it('revokes the server session, notifies completion, and never resets local state', async () => {
    const { trigger, notifyQuitLogoutDone } = setupElectronMocks();
    requestJson.mockResolvedValue({});

    const { result } = renderAuth();
    loginAsIntranet(result);

    await act(async () => {
      await trigger();
    });

    expect(requestJson).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', _retry: true }));
    expect(notifyQuitLogoutDone).toHaveBeenCalledTimes(1);
    expect(result.current.session.mode).toBe('intranet'); // quit path must not call resetToLocalSession()
  });

  it('still notifies completion when the server call fails', async () => {
    const { trigger, notifyQuitLogoutDone } = setupElectronMocks();
    requestJson.mockRejectedValue(new Error('network down'));

    const { result } = renderAuth();
    loginAsIntranet(result);

    await act(async () => {
      await trigger();
    });

    expect(notifyQuitLogoutDone).toHaveBeenCalledTimes(1);
  });
});

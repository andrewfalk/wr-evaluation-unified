// @vitest-environment jsdom
//
// 다른 탭의 토큰 갱신 알림(REFRESH_SUCCESS)은 **지금** 인트라넷 세션인 탭에만 반영한다(REFACTORING_ROADMAP Phase 2 P2-46b).
// 판정은 AuthContext의 getSession()(세션이 바뀌는 그 동기 구간에 갱신)으로 한다 — 이 훅의 sessionRef는 커밋 뒤 effect에서야
// 따라오므로, 로컬 세션으로 바뀐 직후·다음 커밋 전에는 아직 이전(인트라넷) 세션을 가리킨다.
// 실제 AuthProvider + useAuthSync(WorkspaceBoundary와 같은 배선)를 StrictMode로 렌더하고, 탭 간 채널의 수신 함수만 잡아 직접 부른다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../auth/AuthContext';
import { useAuthSync } from '../useAuthSync.js';

// 다른 테스트 파일(다른 worker)의 BroadcastChannel('wr-auth') 메시지가 닿지 않게(G9와 같은 이유) — 정적 import보다 먼저.
await vi.hoisted(async () => (await import('../../../testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

const listeners = vi.hoisted(() => []);
vi.mock('../../auth/authChannel', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    onAuthBroadcast: (handler) => {
      listeners.push(handler);
      return () => { const i = listeners.indexOf(handler); if (i >= 0) listeners.splice(i, 1); };
    },
  };
});

const SESSION_KEY = 'wrEvalUnifiedAuthSession';
const INTRANET = {
  version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: 'https://srv.test', accessToken: 'tok-a',
  refreshedAt: '2026-11-13T00:00:00.000Z', user: { id: 'u-a', role: 'doctor', organizationId: 'org-1', authProvider: 'intranet' },
};
const REFRESH = {
  type: 'REFRESH_SUCCESS', accessToken: 'tok-other', accessExpiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: 'u-a', role: 'doctor', organizationId: 'org-1' },
};

afterEach(() => {
  cleanup();
  listeners.length = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
});

function useBoundaryAuth() {
  const auth = useAuth();
  const { session, setSession, resetToLocalSession, getAuthEpoch, getSession } = auth;
  useAuthSync({ session, setSession, resetToLocalSession, getAuthEpoch, getSession });
  return auth;
}

function renderAuth() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(INTRANET));
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // 저장된 세션 확인 요청은 끝나지 않게(이 테스트와 무관)
  return renderHook(() => useBoundaryAuth(), {
    wrapper: ({ children }) => <StrictMode><AuthProvider>{children}</AuthProvider></StrictMode>,
  });
}

const deliver = (msg) => { for (const l of [...listeners]) l(msg); };

describe('useAuthSync — 다른 탭의 토큰 갱신 알림(P2-46b)', () => {
  it('로컬 세션으로 바뀐 직후(다음 커밋 전) 도착한 갱신 알림은 반영하지 않는다', () => {
    const { result } = renderAuth();
    expect(result.current.session.mode).toBe('intranet');
    act(() => {
      result.current.resetToLocalSession();
      deliver(REFRESH);
    });
    const { session } = result.current;
    expect(session.mode).toBe('local');
    expect(session.accessToken ?? null).toBeNull();
    expect(session.user?.id).not.toBe('u-a');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY) || '{}').accessToken ?? null).toBeNull();
  });

  it('인트라넷 세션이면 갱신 알림을 반영한다', () => {
    const { result } = renderAuth();
    act(() => { deliver(REFRESH); });
    expect(result.current.session.mode).toBe('intranet');
    expect(result.current.session.accessToken).toBe('tok-other');
  });
});

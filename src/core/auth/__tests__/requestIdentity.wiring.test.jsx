// @vitest-environment jsdom
//
// 요청 신원 고정(계정 전환 수정 AS-1) — 실제 AuthProvider + useAuthSync + httpClient 배선.
// 계정이 바뀐 직후(렌더·effect가 아직 돌기 전)에 끝난 이전 계정의 인증 갱신도 이전 계정 요청을 다시 보내지 않는다.
// 현재 세션 getter가 AuthContext의 동기 ref를 읽어야 한다(useAuthSync의 effect로 갱신되는 ref는 늦다).
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// 'wr-auth' 채널이 다른 테스트 파일과 섞이지 않도록 authChannel을 불러오기 전에 가짜 채널을 설치한다.
await vi.hoisted(async () => (await import('../../../testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

vi.mock('../../utils/csrfCookie', () => ({
  getCsrfToken: vi.fn(() => 'csrf-token'),
}));

import { AuthProvider, useAuth } from '../AuthContext.jsx';
import { useAuthSync } from '../../hooks/useAuthSync.js';
import { configureHttpClient, requestJson } from '../../services/httpClient';

const SERVER = 'https://srv';
const userOf = (id) => ({ id, organizationId: 'org-1' });
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function useHarness() {
  const auth = useAuth();
  useAuthSync({
    session: auth.session, setSession: auth.setSession, resetToLocalSession: auth.resetToLocalSession,
    getAuthEpoch: auth.getAuthEpoch, getSession: auth.getSession,
  });
  return auth;
}

afterEach(() => {
  cleanup();
  configureHttpClient({ onRefresh: null, onLogout: null, getCurrentSession: null });
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('요청 신원 고정 — 실제 배선', () => {
  it('A 요청의 갱신을 기다리는 사이 B로 바뀌고(effect 전) 갱신이 A로 끝나도 A 요청을 다시 보내지 않는다', async () => {
    let resolveRefresh;
    const fetchMock = vi.fn((url) => {
      if (String(url).endsWith('/api/auth/refresh')) return new Promise((r) => { resolveRefresh = r; });
      return Promise.resolve(jsonRes(401, { code: 'UNAUTHORIZED' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useHarness(), {
      wrapper: ({ children }) => <StrictMode><AuthProvider>{children}</AuthProvider></StrictMode>,
    });
    act(() => {
      result.current.login({ user: userOf('a'), accessToken: 'tok-a', accessExpiresAt: '2099-01-01T00:00:00.000Z' }, SERVER);
    });
    const sessionA = result.current.session;

    let outcome;
    await act(async () => {
      const pending = requestJson('/api/patients', { baseUrl: SERVER, method: 'POST', body: { name: '환자' }, session: sessionA })
        .then(() => 'sent', (err) => err);
      await vi.waitFor(() => expect(resolveRefresh).toBeTypeOf('function'));
      // 같은 동기 구간: A → 로컬 → B. act가 끝나기 전이라 렌더·effect는 아직 돌지 않았다.
      result.current.resetToLocalSession();
      result.current.login({ user: userOf('b'), accessToken: 'tok-b', accessExpiresAt: '2099-01-01T00:00:00.000Z' }, SERVER);
      resolveRefresh(jsonRes(200, { accessToken: 'tok-a2', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: userOf('a') }));
      outcome = await pending;
    });

    expect(outcome).toMatchObject({ status: 401 });
    const patientCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/patients'));
    expect(patientCalls).toHaveLength(1);
    expect(result.current.session.user.id).toBe('b');
  });

  it('초기화 없이 B로 바뀐 뒤 A의 갱신이 끝나도 B 세션을 덮어쓰지 않고 A 요청을 다시 보내지 않는다', async () => {
    let resolveRefresh;
    const fetchMock = vi.fn((url) => {
      if (String(url).endsWith('/api/auth/refresh')) return new Promise((r) => { resolveRefresh = r; });
      return Promise.resolve(jsonRes(401, { code: 'UNAUTHORIZED' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useHarness(), {
      wrapper: ({ children }) => <StrictMode><AuthProvider>{children}</AuthProvider></StrictMode>,
    });
    act(() => {
      result.current.login({ user: userOf('a'), accessToken: 'tok-a', accessExpiresAt: '2099-01-01T00:00:00.000Z' }, SERVER);
    });
    const sessionA = result.current.session;

    let outcome;
    await act(async () => {
      const pending = requestJson('/api/patients', { baseUrl: SERVER, method: 'POST', body: { name: '환자' }, session: sessionA })
        .then(() => 'sent', (err) => err);
      await vi.waitFor(() => expect(resolveRefresh).toBeTypeOf('function'));
      result.current.login({ user: userOf('b'), accessToken: 'tok-b', accessExpiresAt: '2099-01-01T00:00:00.000Z' }, SERVER);
      resolveRefresh(jsonRes(200, { accessToken: 'tok-a2', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: userOf('a') }));
      outcome = await pending;
    });

    expect(outcome).toMatchObject({ status: 401 });
    const patientCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/patients'));
    expect(patientCalls).toHaveLength(1);
    expect(result.current.session.user.id).toBe('b');
    expect(result.current.session.accessToken).toBe('tok-b');
  });
});

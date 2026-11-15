// @vitest-environment jsdom
//
// 요청 신원 고정(계정 전환 수정 AS-1) — useAuthSync가 현재 세션 getter를 요청 클라이언트에 꽂고,
// 실제 httpClient + useAuthSync에서 인증 갱신이 다른 계정을 돌려주면 같은 본문을 다시 보내지 않는다.
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

// 'wr-auth' 채널이 다른 테스트 파일(다른 worker)의 로그인·로그아웃 방송과 섞이지 않도록 authChannel을 불러오기 전에 가짜 채널을 설치한다.
await vi.hoisted(async () => (await import('../../../testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());
import { useAuthSync } from '../useAuthSync.js';
import { configureHttpClient, requestJson } from '../../services/httpClient';

vi.mock('../../utils/csrfCookie', () => ({
  getCsrfToken: vi.fn(() => 'csrf-token'),
}));

const sessionOf = (userId, accessToken = `tok-${userId}`) => ({
  mode: 'intranet', apiBaseUrl: 'https://srv', accessToken, user: { id: userId, organizationId: 'org-1' },
});

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

afterEach(() => {
  cleanup();
  configureHttpClient({ onRefresh: null, onLogout: null, getCurrentSession: null });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAuthSync(initialSession) {
  const setSession = vi.fn();
  const resetToLocalSession = vi.fn();
  const view = renderHook(({ session }) => useAuthSync({
    session, setSession, resetToLocalSession, getAuthEpoch: () => 0,
  }), { initialProps: { session: initialSession }, wrapper: StrictMode });
  return { ...view, setSession, resetToLocalSession };
}

describe('useAuthSync — 요청 신원 고정 배선', () => {
  it('갱신 응답이 다른 계정이면 환자 본문을 다시 보내지 않는다(401)', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        return jsonRes(200, { accessToken: 'tok-b', accessExpiresAt: new Date().toISOString(), user: { id: 'b', organizationId: 'org-1' } });
      }
      return jsonRes(401, { code: 'UNAUTHORIZED' });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAuthSync(sessionOf('a'));

    await expect(requestJson('/api/patients/p1', {
      baseUrl: 'https://srv', method: 'PATCH', body: { name: '환자' }, session: sessionOf('a'),
    })).rejects.toMatchObject({ status: 401 });

    const patientCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/patients'));
    expect(patientCalls).toHaveLength(1);
    expect(patientCalls[0][1].headers.Authorization).toBe('Bearer tok-a');
  });

  it('화면 세션이 다른 계정으로 바뀐 뒤 도착한 이전 계정 요청의 401은 갱신하지 않는다', async () => {
    const fetchMock = vi.fn(async () => jsonRes(401, { code: 'UNAUTHORIZED' }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender, resetToLocalSession } = renderAuthSync(sessionOf('a'));
    rerender({ session: sessionOf('b') });

    await expect(requestJson('/api/patients', {
      baseUrl: 'https://srv', method: 'POST', body: { name: '환자' }, session: sessionOf('a'),
    })).rejects.toMatchObject({ status: 401 });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/auth/'))).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resetToLocalSession).not.toHaveBeenCalled();
  });

  it('같은 계정이면 지금처럼 새 토큰으로 다시 보낸다', async () => {
    let patientCalls = 0;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        return jsonRes(200, { accessToken: 'tok-a2', accessExpiresAt: new Date().toISOString(), user: { id: 'a', organizationId: 'org-1' } });
      }
      patientCalls += 1;
      return patientCalls === 1 ? jsonRes(401, { code: 'UNAUTHORIZED' }) : jsonRes(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAuthSync(sessionOf('a'));

    await expect(requestJson('/api/patients/p1', {
      baseUrl: 'https://srv', method: 'PATCH', body: {}, session: sessionOf('a'),
    })).resolves.toEqual({ ok: true });
    const last = fetchMock.mock.calls.at(-1);
    expect(last[1].headers.Authorization).toBe('Bearer tok-a2');
  });
});

describe('useAuthSync — 갱신을 기다리는 사이 서버가 바뀌면 결과를 적용하지 않는다', () => {
  const onServer = (base) => ({ ...sessionOf('a'), apiBaseUrl: base });

  function holdRefresh() {
    let release;
    const fetchMock = vi.fn((url) => {
      if (String(url).endsWith('/api/auth/refresh')) {
        return new Promise((resolve) => {
          release = () => resolve(jsonRes(200, { accessToken: 'tok-a2', accessExpiresAt: new Date().toISOString(), user: { id: 'a', organizationId: 'org-1' } }));
        });
      }
      return Promise.resolve(jsonRes(401, { code: 'UNAUTHORIZED' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, release: () => release() };
  }

  it('같은 사용자·조직이라도 s1에서 시작한 갱신 결과를 s2 세션에 적용하지 않는다', async () => {
    const { fetchMock, release } = holdRefresh();
    const { rerender, setSession } = renderAuthSync(onServer('https://s1'));
    const pending = requestJson('/api/patients', { baseUrl: 'https://s1', method: 'POST', body: {}, session: onServer('https://s1') })
      .catch((error) => error);
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/auth/refresh'))).toBe(true));
    rerender({ session: onServer('https://s2') });
    release();
    await pending;
    expect(setSession).not.toHaveBeenCalled();
  });

  it('서버가 그대로면 갱신 결과를 적용한다', async () => {
    const { fetchMock, release } = holdRefresh();
    const { setSession } = renderAuthSync(onServer('https://s1'));
    const pending = requestJson('/api/patients', { baseUrl: 'https://s1', method: 'POST', body: {}, session: onServer('https://s1') })
      .catch((error) => error);
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/auth/refresh'))).toBe(true));
    release();
    await pending;
    expect(setSession).toHaveBeenCalled();
  });
});

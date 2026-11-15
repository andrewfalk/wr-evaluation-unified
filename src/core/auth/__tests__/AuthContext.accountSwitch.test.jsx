// @vitest-environment jsdom
//
// 계정 전환 수정 AS-3 — 작업 공간 주인·세대, 인증 문맥 세대(늦은 로그인·로그아웃 가드와 요청 취소), 로그인 없이 신원이
// 바뀌는 갱신 거부, 탭 간 로그인 방송. AuthProvider + useAuthSync를 함께 렌더한다(StrictMode).
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

// 'wr-auth' 채널이 다른 테스트 파일과 섞이지 않도록 authChannel을 불러오기 전에 가짜 채널을 설치한다.
await vi.hoisted(async () => (await import('../../../testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

vi.mock('../../services/httpClient', () => ({
  requestJson: vi.fn(),
  configureHttpClient: vi.fn(),
}));
vi.mock('../../api/authApi', () => ({
  verifyStoredSession: vi.fn(),
  renewCsrf: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

import { AuthProvider, useAuth } from '../AuthContext.jsx';
import { useAuthSync } from '../../hooks/useAuthSync.js';
import { useAppSettings } from '../../hooks/useAppSettings.js';
import { saveStoredSession } from '../session';
import { requestJson } from '../../services/httpClient';
import { verifyStoredSession } from '../../api/authApi';
import { getLockToken, setLockToken } from '../../services/lockTokenStore';
import { getIntegrationStatus, markRemoteIntegrationStatus } from '../../services/integrationStatus';
import { AUTH_PROTOCOL, STORAGE_KEYS } from '../../storage/keys';

const SERVER = 'https://srv';
const SETTINGS_KEY = STORAGE_KEYS.settings;
const userOf = (id) => ({ id, organizationId: 'org-1', name: `이름-${id}`, role: 'doctor' });
const responseOf = (id) => ({ user: userOf(id), accessToken: `tok-${id}`, accessExpiresAt: new Date(Date.now() + 60_000).toISOString() });

function wrapper({ children }) {
  return <StrictMode><AuthProvider>{children}</AuthProvider></StrictMode>;
}

function useHarness() {
  const auth = useAuth();
  useAuthSync({
    session: auth.session, setSession: auth.setSession, resetToLocalSession: auth.resetToLocalSession, getAuthEpoch: auth.getAuthEpoch,
  });
  return auth;
}

function renderAuth() {
  return renderHook(() => useHarness(), { wrapper });
}

function loginAs(result, id, attempt = result.current.beginLoginAttempt?.()) {
  let applied;
  act(() => { applied = result.current.login(responseOf(id), SERVER, attempt); });
  return applied;
}

// 다른 탭 역할의 채널 — 보낸 방송을 이 탭(AuthProvider의 authChannel)이 받는다.
function otherTab() {
  const ch = new BroadcastChannel(AUTH_PROTOCOL.channelName);
  const received = [];
  ch.addEventListener('message', (e) => received.push(e.data));
  return { post: (msg) => ch.postMessage(msg), received, close: () => ch.close() };
}

async function flushBroadcast() {
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(requestJson).mockReset();
  vi.mocked(verifyStoredSession).mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe('R3 — 작업 공간 주인·세대(Provider)', () => {
  it('A 로그인 → 강제 리셋 → 같은 A 재로그인은 세대 유지, B 로그인은 +1', () => {
    const { result } = renderAuth();
    expect(result.current.workspaceEpoch).toBe(0);
    loginAs(result, 'a');
    expect(result.current.workspaceEpoch).toBe(1); // 로컬 화면에서 로그인 → 새로 시작(J2)
    act(() => { result.current.resetToLocalSession(); }); // 강제 로그아웃
    expect(result.current.workspaceEpoch).toBe(1);
    expect(result.current.getWorkspaceOwner()).toBe(`${SERVER}|a|org-1`);
    loginAs(result, 'a');
    expect(result.current.workspaceEpoch).toBe(1); // 만료 뒤 같은 사용자 → 이어 감
    act(() => { result.current.resetToLocalSession(); });
    loginAs(result, 'b');
    expect(result.current.workspaceEpoch).toBe(2);
    expect(result.current.getWorkspaceOwner()).toBe(`${SERVER}|b|org-1`);
  });

  it('logout()은 +1·주인 없음, 주인 없을 때 discardWorkspace()는 그대로', async () => {
    requestJson.mockResolvedValue({});
    const { result } = renderAuth();
    loginAs(result, 'a');
    await act(async () => { await result.current.logout(); });
    expect(result.current.session.mode).toBe('local');
    expect(result.current.workspaceEpoch).toBe(2);
    expect(result.current.getWorkspaceOwner()).toBeNull();
    act(() => { result.current.discardWorkspace(); });
    expect(result.current.workspaceEpoch).toBe(2);
  });

  it('주인이 있을 때 discardWorkspace()는 +1·주인 없음', () => {
    const { result } = renderAuth();
    loginAs(result, 'a');
    act(() => { result.current.resetToLocalSession(); });
    act(() => { result.current.discardWorkspace(); });
    expect(result.current.workspaceEpoch).toBe(2);
    expect(result.current.getWorkspaceOwner()).toBeNull();
  });

  it('부팅 검증은 주인만 정한다(세대 그대로)', async () => {
    saveStoredSession({ mode: 'intranet', apiBaseUrl: SERVER, user: userOf('a'), refreshedAt: '2026-11-15T00:00:00.000Z' });
    verifyStoredSession.mockResolvedValue({ ok: true, status: 200, data: { accessToken: 'tok-a', user: userOf('a') } });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(result.current.workspaceEpoch).toBe(0);
    expect(result.current.getWorkspaceOwner()).toBe(`${SERVER}|a|org-1`);
  });

  it('세대가 오르면 락 토큰과 연동 상태의 이전 계정 정보를 비운다', () => {
    const { result } = renderAuth();
    loginAs(result, 'a');
    setLockToken('p1', 'lease-1');
    markRemoteIntegrationStatus({ session: result.current.session, settings: { integrationMode: 'intranet', apiBaseUrl: SERVER } });
    expect(getIntegrationStatus().sessionInfo.userId).toBe('a');
    act(() => { result.current.resetToLocalSession(); });
    loginAs(result, 'b');
    expect(getLockToken('p1')).toBeNull();
    expect(getIntegrationStatus().sessionInfo.userId).toBeNull();
  });
});

describe('R4 — 로그인 없이 신원이 바뀌는 갱신은 받아들이지 않는다', () => {
  it('다른 user의 REFRESH_SUCCESS 방송 → 로컬 세션(로그인 화면), 세대·주인 유지', async () => {
    const { result } = renderAuth();
    loginAs(result, 'a');
    const tab = otherTab();
    tab.post({ type: 'REFRESH_SUCCESS', accessToken: 'tok-b', accessExpiresAt: new Date().toISOString(), user: userOf('b') });
    await flushBroadcast();
    tab.close();
    expect(result.current.session.mode).toBe('local');
    expect(result.current.workspaceEpoch).toBe(1);
    expect(result.current.getWorkspaceOwner()).toBe(`${SERVER}|a|org-1`);
  });

  it('같은 user의 REFRESH_SUCCESS 방송은 지금처럼 토큰만 바꾼다', async () => {
    const { result } = renderAuth();
    loginAs(result, 'a');
    const tab = otherTab();
    tab.post({ type: 'REFRESH_SUCCESS', accessToken: 'tok-a2', accessExpiresAt: new Date().toISOString(), user: userOf('a') });
    await flushBroadcast();
    tab.close();
    expect(result.current.session.mode).toBe('intranet');
    expect(result.current.session.accessToken).toBe('tok-a2');
  });

  it('setSession으로 다른 신원의 인트라넷 세션을 넣으면 로컬 세션이 된다', () => {
    const { result } = renderAuth();
    loginAs(result, 'a');
    act(() => { result.current.setSession(prev => ({ ...prev, user: userOf('b') })); });
    expect(result.current.session.mode).toBe('local');
    expect(result.current.workspaceEpoch).toBe(1);
  });
});

describe('R14·R21 — 늦게 끝난 로그아웃은 새 계정에 영향을 주지 않는다', () => {
  it('A의 logout()이 revoke를 기다리는 동안 강제 리셋 → B 로그인 → 뒤늦은 완료: B 세션 유지, 세대 변화 없음, LOGOUT 방송 없음', async () => {
    const revoke = deferred();
    let revokeSignal;
    requestJson.mockImplementation((path, opts) => { revokeSignal = opts.signal; return revoke.promise; });
    const { result } = renderAuth();
    loginAs(result, 'a');
    const tab = otherTab();

    let logoutDone;
    act(() => { logoutDone = result.current.logout(); });
    act(() => { result.current.resetToLocalSession(); }); // 다른 경로의 강제 로그아웃
    loginAs(result, 'b');
    const epochAfterB = result.current.workspaceEpoch;
    expect(revokeSignal.aborted).toBe(true); // 문맥이 바뀌면 revoke 요청을 즉시 취소

    await act(async () => { revoke.resolve({}); await logoutDone; });
    await flushBroadcast();
    tab.close();

    expect(result.current.session.mode).toBe('intranet');
    expect(result.current.session.user.id).toBe('b');
    expect(result.current.workspaceEpoch).toBe(epochAfterB);
    expect(tab.received.filter(m => m?.type === 'LOGOUT')).toHaveLength(0);
  });

  it('revoke가 대기 시간을 넘기면 요청을 취소한다', async () => {
    vi.useFakeTimers();
    let revokeSignal;
    requestJson.mockImplementation((path, opts) => { revokeSignal = opts.signal; return new Promise(() => {}); });
    const { result } = renderAuth();
    loginAs(result, 'a');
    await act(async () => {
      const done = result.current.logout();
      await vi.advanceTimersByTimeAsync(2600);
      await done;
    });
    expect(revokeSignal.aborted).toBe(true);
    expect(result.current.session.mode).toBe('local');
  });
});

describe('R15 — 다른 탭의 로그인 방송', () => {
  it('다른 신원의 LOGIN 방송 → 로컬 세션, 주인·세대 유지', async () => {
    const { result } = renderAuth();
    loginAs(result, 'a');
    const tab = otherTab();
    tab.post({ type: 'LOGIN', server: SERVER, identity: 'b|org-1' });
    await flushBroadcast();
    tab.close();
    expect(result.current.session.mode).toBe('local');
    expect(result.current.getWorkspaceOwner()).toBe(`${SERVER}|a|org-1`);
    expect(result.current.workspaceEpoch).toBe(1);
  });

  it('같은 신원의 LOGIN 방송·로컬 세션에서 받은 방송은 무시한다', async () => {
    const { result } = renderAuth();
    const tab = otherTab();
    tab.post({ type: 'LOGIN', server: SERVER, identity: 'b|org-1' });
    await flushBroadcast();
    expect(result.current.session.mode).toBe('local');
    expect(result.current.workspaceEpoch).toBe(0);
    loginAs(result, 'a');
    tab.post({ type: 'LOGIN', server: SERVER, identity: 'a|org-1' });
    await flushBroadcast();
    tab.close();
    expect(result.current.session.mode).toBe('intranet');
  });

  it('login()은 신원 키만 담은 LOGIN 방송을 보낸다(토큰·이름 없음)', async () => {
    const tab = otherTab();
    const { result } = renderAuth();
    loginAs(result, 'a');
    await flushBroadcast();
    tab.close();
    expect(tab.received.filter(m => m?.type === 'LOGIN')).toEqual([{ type: 'LOGIN', server: SERVER, identity: 'a|org-1' }]);
  });

  it('다른 서버의 LOGIN 방송·서버 정보가 없는 방송은 무시한다(쿠키가 따로)', async () => {
    const { result } = renderAuth();
    loginAs(result, 'a');
    const tab = otherTab();
    tab.post({ type: 'LOGIN', server: 'https://other', identity: 'b|org-1' });
    tab.post({ type: 'LOGIN', identity: 'b|org-1' });
    await flushBroadcast();
    tab.close();
    expect(result.current.session.mode).toBe('intranet');
    expect(result.current.session.user.id).toBe('a');
  });
});

describe('R17 — 늦게 도착한 로그인 응답은 적용되지 않는다', () => {
  it('A 시도 시작 → 그사이 B 로그인 → 뒤늦은 login(A 응답, 옛 시도): 적용 안 됨, 세대 변화 없음, logout 요청 0회, 옛 시도 취소', () => {
    const { result } = renderAuth();
    const attemptA = result.current.beginLoginAttempt();
    const attemptB = result.current.beginLoginAttempt();
    expect(loginAs(result, 'b', attemptB)).toBeTruthy();
    const epochAfterB = result.current.workspaceEpoch;
    expect(attemptA.signal.aborted).toBe(true);
    expect(loginAs(result, 'a', attemptA)).toBe(false);
    expect(result.current.session.user.id).toBe('b');
    expect(result.current.workspaceEpoch).toBe(epochAfterB);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('A 시도 중 강제 리셋(로컬 세션) → 뒤늦은 응답은 적용되지 않는다', () => {
    const { result } = renderAuth();
    const attemptA = result.current.beginLoginAttempt();
    act(() => { result.current.resetToLocalSession(); });
    expect(loginAs(result, 'a', attemptA)).toBe(false);
    expect(result.current.session.mode).toBe('local');
    expect(result.current.workspaceEpoch).toBe(0);
  });
});

describe('R20 — 모드·서버 주소 변경은 진행 중인 로그인 시도를 무효로 한다(주인 없어도)', () => {
  function useSettingsHarness() {
    const auth = useHarness();
    const app = useAppSettings({
      session: auth.session, setSession: auth.setSession, resetToLocalSession: auth.resetToLocalSession,
      invalidateAuthContext: auth.invalidateAuthContext,
    });
    return { auth, app };
  }

  it.each([
    ['로컬 모드로', { integrationMode: 'local' }],
    ['서버 주소 변경', { apiBaseUrl: 'https://other' }],
  ])('%s → 시도 취소, 응답이 와도 로그인되지 않음', (_name, change) => {
    const { result } = renderHook(() => useSettingsHarness(), { wrapper });
    act(() => { result.current.app.handleSaveSettings({ ...result.current.app.settings, integrationMode: 'intranet', apiBaseUrl: SERVER }); });
    const attempt = result.current.auth.beginLoginAttempt();
    act(() => { result.current.app.handleSaveSettings({ ...result.current.app.settings, ...change }); });
    expect(attempt.signal.aborted).toBe(true);
    let applied;
    act(() => { applied = result.current.auth.login(responseOf('a'), SERVER, attempt); });
    expect(applied).toBe(false);
    expect(result.current.auth.session.mode).toBe('local');
  });

  it('Electron의 비동기 설정 로드가 서버 주소를 바꾸면, 그 전에 시작한 시도도 무효가 된다', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: 'https://old' }));
    let resolveSettings;
    window.electron = { fsLoadAllPatients: async () => [], fsLoadSettings: () => new Promise((r) => { resolveSettings = r; }) };
    try {
      const { result } = renderHook(() => useSettingsHarness(), { wrapper });
      const attempt = result.current.auth.beginLoginAttempt();
      await act(async () => { resolveSettings({ integrationMode: 'intranet', apiBaseUrl: 'https://new' }); });
      expect(attempt.signal.aborted).toBe(true);
      let applied;
      act(() => { applied = result.current.auth.login(responseOf('a'), 'https://old', attempt); });
      expect(applied).toBe(false);
      expect(result.current.auth.session.mode).toBe('local');
    } finally {
      delete window.electron;
    }
  });

  it('비동기 설정 로드가 모드·서버 주소를 바꾸지 않으면 시도는 그대로', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: 'https://old' }));
    let resolveSettings;
    window.electron = { fsLoadAllPatients: async () => [], fsLoadSettings: () => new Promise((r) => { resolveSettings = r; }) };
    try {
      const { result } = renderHook(() => useSettingsHarness(), { wrapper });
      const attempt = result.current.auth.beginLoginAttempt();
      await act(async () => { resolveSettings({ integrationMode: 'intranet', apiBaseUrl: 'https://old/', theme: 'dark' }); });
      expect(attempt.signal.aborted).toBe(false);
    } finally {
      delete window.electron;
    }
  });

  it('모드·서버 주소와 무관한 설정 변경은 시도를 무효로 하지 않는다', () => {
    const { result } = renderHook(() => useSettingsHarness(), { wrapper });
    const attempt = result.current.auth.beginLoginAttempt();
    act(() => { result.current.app.handleSaveSettings({ ...result.current.app.settings, theme: 'dark' }); });
    expect(attempt.signal.aborted).toBe(false);
  });
});

describe('R22 — 부팅 검증이 다른 신원을 돌려주면 받아들이지 않는다', () => {
  it('저장된 세션 A, 검증 응답 B → 로컬 세션(로그인 화면)', async () => {
    saveStoredSession({ mode: 'intranet', apiBaseUrl: SERVER, user: userOf('a'), refreshedAt: '2026-11-15T00:00:00.000Z' });
    verifyStoredSession.mockResolvedValue({ ok: true, status: 200, data: { accessToken: 'tok-b', user: userOf('b') } });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.sessionVerified).toBe(true));
    expect(result.current.session.mode).toBe('local');
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.getWorkspaceOwner()).toBeNull();
  });
});

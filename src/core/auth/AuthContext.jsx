// @ts-nocheck
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearStoredSession,
  createLocalSession,
  loadStoredSession,
  normalizeSession,
  saveStoredSession,
} from './session';
import { authServerKeyOf, broadcastLogin, broadcastLogout } from './authChannel';
import { INITIAL_WORKSPACE, nextWorkspace, workspaceOwnerOf } from './workspaceOwner';
import { requestJson } from '../services/httpClient';
import { clearAllLockTokens } from '../services/lockTokenStore';
import { resetIntegrationStatus } from '../services/integrationStatus';
import { verifyStoredSession } from '../api/authApi';
import { getLifecycleBridge } from '../../platform/bridge';

import { hasIntranetSession, intranetIdentityOf, resolveApiBaseUrl } from '../../platform/dataMode';
const AuthContext = createContext(null);

const REVOKE_TIMEOUT_MS = 2500;

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(() => loadStoredSession());
  // Boot-time flag: false for persisted intranet sessions until /api/auth/csrf confirms
  // the refresh cookie is still valid. True immediately for local/non-intranet sessions.
  const [sessionVerified, setSessionVerified] = useState(
    () => !hasIntranetSession(loadStoredSession())
  );
  // Ref that shadows session state so callbacks don't close over stale values.
  const sessionRef = useRef(session);
  // 인증 문맥 세대(contextGen) — 로그인 적용, 로그아웃 완료, 로컬 세션으로 되돌림(강제 로그아웃·방송·신원 거부 포함),
  // discardWorkspace(), 설정의 모드·서버 주소 변경마다 1씩 오른다. useAuthSync의 refresh, 로그인 시도, 로그아웃 완료가
  // 시작할 때 이 값을 잡아 두고 끝날 때 같을 때만 적용한다(getAuthEpoch로 읽는다 — 예전 이름 그대로).
  const authEpochRef = useRef(0);
  // 세대가 오르면 취소할 요청(로그인 시도·로그아웃 revoke). 취소된 요청의 응답은 브라우저가 처리하지 않는다.
  const pendingControllersRef = useRef(new Set());
  // 작업 공간 주인·세대 — App은 workspace.epoch를 key로 다시 띄워진다(src/app/WorkspaceBoundary).
  const [workspace, setWorkspaceState] = useState(INITIAL_WORKSPACE);
  const workspaceRef = useRef(INITIAL_WORKSPACE);

  const bumpAuthContext = useCallback(() => {
    authEpochRef.current += 1;
    const pending = [...pendingControllersRef.current];
    pendingControllersRef.current.clear();
    for (const controller of pending) controller.abort();
  }, []);

  // 주인·세대 전이(nextWorkspace) 적용. 세대가 오르면 같은 이벤트 안에서 모듈 수준의 계정 상태도 비운다.
  const applyWorkspace = useCallback((event) => {
    const prev = workspaceRef.current;
    const next = nextWorkspace(prev, event);
    if (next === prev) return prev;
    if (next.epoch !== prev.epoch) {
      clearAllLockTokens();
      resetIntegrationStatus();
    }
    workspaceRef.current = next;
    setWorkspaceState(next);
    return next;
  }, []);

  const resetToLocalSession = useCallback(() => {
    // Invalidate any refresh / login attempt / logout that was already in flight when this reset was
    // triggered — without this, a refresh that finally succeeds after we've
    // reset (e.g. past revokeServerSession's timeout backstop) would call
    // setSession() with a fresh accessToken/user and silently resurrect an
    // intranet session right after the user logged out.
    bumpAuthContext();
    clearStoredSession();
    // Idempotent when already local: reuse the existing session object instead of
    // minting a new one. createLocalSession() returns a fresh object with a fresh
    // refreshedAt on every call, so replacing an equivalent local session still
    // changes its identity, and anything keyed on the session object re-runs.
    // That turns a single auth failure into an unbounded request loop: a probe
    // 401s → httpClient auto-refreshes → the refresh fails → onLogout lands here
    // → a new session object re-triggers the probe → repeat as fast as the network
    // allows. Reusing the object makes setSessionState a no-op (Object.is bailout),
    // so the cycle terminates after one pass.
    const current = sessionRef.current;
    const cleanLocal = createLocalSession();
    // Reuse only a canonical, unauthenticated local identity. A malformed or
    // partially refreshed local session can contain a server token/user while
    // still declaring mode='local'; reset must scrub that state, not preserve it.
    const canReuseCurrent = (
      current?.mode === 'local'
      && !current?.accessToken
      && !current?.accessExpiresAt
      && current?.user?.authProvider === cleanLocal.user.authProvider
      && current?.user?.id === cleanLocal.user.id
      && current?.user?.organizationId === cleanLocal.user.organizationId
    );
    const fallback = canReuseCurrent ? current : cleanLocal;
    saveStoredSession(fallback);
    sessionRef.current = fallback;
    setSessionState(fallback);
    // Local sessions need no server verification — mark as verified immediately
    // so sessionVerified=false is reserved exclusively for "intranet boot check in-flight".
    setSessionVerified(true);
    return fallback;
  }, [bumpAuthContext]);

  // Verify a persisted intranet session on mount. Uses verifyStoredSession (requestEnvelope — no 401-refresh
  // interceptor) because the interceptor is not wired yet at this point (useAuthSync wires it).
  // On failure, falls back to local session rather than leaving a stale intranet session.
  useEffect(() => {
    const snap = sessionRef.current;
    if (!hasIntranetSession(snap)) return;
    // Identity key: uniquely identifies the session at request time so the response
    // handler can detect if login/logout changed the session while the request was in flight.
    const snapIdentity = `${snap.mode}|${snap.apiBaseUrl || ''}|${snap.user?.id || ''}|${snap.refreshedAt || ''}`;
    const sameAsSnap = () => {
      const current = sessionRef.current;
      return `${current.mode}|${current.apiBaseUrl || ''}|${current.user?.id || ''}|${current.refreshedAt || ''}` === snapIdentity;
    };
    const baseUrl = resolveApiBaseUrl({ session: snap });
    verifyStoredSession(baseUrl)
      .then(r => {
        // Skip if the session changed while the request was in flight (e.g. login/logout).
        if (!sameAsSnap()) return;

        // 저장된 세션과 다른 신원을 돌려주면 받아들이지 않는다 — 쿠키만 다른 계정 것이 된 경우(버려진 로그인 응답)
        // 새로고침으로 그 계정이 열리지 않게 한다.
        const data = r.ok ? r.data : null;
        const identityChanged = !!data?.user
          && intranetIdentityOf({ mode: 'intranet', user: { ...snap.user, ...data.user } }) !== intranetIdentityOf(snap);
        if (!r.ok || identityChanged) {
          resetToLocalSession();
          return;
        }
        // Apply access token if the server returns one (forward-compatible: no-op if absent).
        // r.data is null when the body is not JSON (csrf-only response with no body).
        const next = normalizeSession({
          ...sessionRef.current,
          ...(data?.accessToken ? {
            accessToken: data.accessToken,
            accessExpiresAt: data.accessExpiresAt,
          } : {}),
          ...(data?.user ? {
            user: { ...sessionRef.current?.user, ...data.user },
          } : {}),
          refreshedAt: new Date().toISOString(),
        });
        saveStoredSession(next); // strips accessToken before writing localStorage
        sessionRef.current = next;
        setSessionState(next);
        setSessionVerified(true);
        // 메모리는 비어 있다 — 주인만 정한다(세대 그대로).
        applyWorkspace({ type: 'bootVerified', owner: workspaceOwnerOf(next) });
      })
      .catch(() => {
        // Same guard: don't reset a session that changed after the request started.
        if (!sameAsSnap()) return;
        resetToLocalSession();
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only, uses ref snapshot

  // Normalize and persist outside the state updater so the return value is stable.
  // 로그인 없이 신원(user.id·조직)이 바뀌는 갱신은 받아들이지 않는다(J1) — 그 탭을 로컬 세션으로 되돌린다(로그인 화면).
  // 원래 계정으로 다시 로그인하면 작업이 이어진다(주인 유지).
  const setSession = useCallback((nextSession) => {
    const current = sessionRef.current;
    const resolved = typeof nextSession === 'function'
      ? nextSession(current)
      : nextSession;
    const before = intranetIdentityOf(current);
    const after = intranetIdentityOf(resolved);
    if (before !== null && after !== null && before !== after) {
      return resetToLocalSession();
    }
    const normalized = saveStoredSession(resolved);
    sessionRef.current = normalized;
    setSessionState(normalized);
    return normalized;
  }, [resetToLocalSession]);

  const getAuthEpoch = useCallback(() => authEpochRef.current, []);
  // 지금 세션 — setSession·login·resetToLocalSession이 같은 동기 구간에서 갱신하는 ref를 읽는다(렌더·effect를 기다리지 않음).
  // 요청 신원 고정(apiClient)이 계정이 바뀐 직후에도 새 계정을 보게 한다.
  const getSession = useCallback(() => sessionRef.current, []);
  const getWorkspaceOwner = useCallback(() => workspaceRef.current.owner, []);

  // 진행 중인 로그인 시도·로그아웃을 무효로 한다(설정의 모드·서버 주소 변경 — 주인 유무와 무관).
  const invalidateAuthContext = useCallback(() => { bumpAuthContext(); }, [bumpAuthContext]);

  // 주인이 있는데 로컬 문맥이 됨(로컬 전환·서버 주소 변경) → 화면을 새로 시작한다. 주인이 없으면(로컬 작업) 그대로.
  const discardWorkspace = useCallback(() => {
    bumpAuthContext();
    applyWorkspace({ type: 'discard' });
  }, [applyWorkspace, bumpAuthContext]);

  // 로그인 시도: 제출할 때 받아 그 signal로 요청을 보내고, login(응답, apiBaseUrl, 시도)로 넘긴다.
  // 세대가 오르면 signal이 취소된다 — 아직 도착하지 않은 응답은 버려지고 쿠키도 바뀌지 않는다.
  const beginLoginAttempt = useCallback(() => {
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    return Object.freeze({ gen: authEpochRef.current, signal: controller.signal });
  }, []);

  // Called after a successful server login. serverResponse = { user, accessToken, accessExpiresAt }.
  // attempt(beginLoginAttempt)를 주면 그 시도 이후 인증 문맥이 바뀌지 않았을 때만 적용한다. 적용하지 않으면 false.
  // 버려진 응답의 서버 세션은 따로 폐기하지 않는다 — /api/auth/logout은 요청 시점 쿠키의 주인을 폐기하므로
  // 엉뚱한 계정을 끊을 수 있다. 주인 없는 서버 세션은 만료로 정리된다.
  const login = useCallback((serverResponse, apiBaseUrl = '', attempt) => {
    if (attempt) {
      // 시도 이후 인증 문맥이 바뀌었거나(다른 로그인·로컬 전환·되돌림), 이미 인트라넷 세션이면(그사이 다른 로그인)
      // 늦게 도착한 응답을 적용하지 않는다. 시도 없이 부르는 호출(테스트·옛 호출부)은 예전처럼 적용한다 — 그 경우에도
      // 아래 bumpAuthContext()가 진행 중이던 refresh 결과의 적용을 막는다.
      if (attempt.gen !== authEpochRef.current) return false;
      if (hasIntranetSession(sessionRef.current)) return false;
    }
    const next = normalizeSession({
      mode: 'intranet',
      status: 'ready',
      apiBaseUrl,
      accessToken: serverResponse.accessToken,
      accessExpiresAt: serverResponse.accessExpiresAt,
      refreshedAt: new Date().toISOString(),
      user: serverResponse.user,
    });
    bumpAuthContext();
    // saveStoredSession strips accessToken before writing localStorage.
    saveStoredSession(next);
    sessionRef.current = next;
    setSessionState(next);
    setSessionVerified(true);
    // 같은 사용자(만료 뒤 재로그인)면 작업을 이어 가고, 다른 사용자·로컬 작업이면 화면을 새로 시작한다.
    applyWorkspace({ type: 'login', owner: workspaceOwnerOf(next) });
    // 같은 브라우저의 다른 탭에 알린다(신원 키만 — 토큰·이름 없음). 다른 계정으로 쓰던 탭은 로그인 화면으로 간다.
    broadcastLogin({ server: authServerKeyOf(next.apiBaseUrl), identity: intranetIdentityOf(next) });
    return next;
  }, [applyWorkspace, bumpAuthContext]);

  // Calls /api/auth/logout with an explicit session snapshot. Local session
  // state is left untouched — callers decide when (or whether) to reset.
  //
  // _retry: true skips httpClient's 401-refresh-and-retry interceptor.
  // /api/auth/logout authenticates via the refresh cookie, not the Bearer
  // access token (see server/src/routes/auth.ts), so it works even with an
  // expired access token and never needs a refresh first. Letting it through
  // the interceptor would trigger a refresh whose result races this
  // function's own timeout: a slow refresh could finish after we've already
  // given up and reset locally, resurrecting the just-logged-out session (or
  // worse, landing after a subsequent re-login and clobbering that new
  // session's cookies). Skipping refresh entirely removes that race instead
  // of just narrowing it.
  //
  // 요청은 AbortController로 묶어 대기 시간(2.5초)을 넘기면 취소한다. cancelOnContextChange면 그 전에 인증 문맥이
  // 바뀌어도(다른 탭의 로그인 방송으로 되돌려진 경우 포함) 즉시 취소한다 — 취소된 요청의 응답은 브라우저가 처리하지
  // 않으므로, 뒤늦게 도착한 응답이 그사이 로그인한 계정의 쿠키를 지우지 못한다.
  const revokeServerSession = useCallback(async (snap, { cancelOnContextChange = false } = {}) => {
    if (!hasIntranetSession(snap)) return;
    const controller = new AbortController();
    if (cancelOnContextChange) pendingControllersRef.current.add(controller);
    let raceTimer;
    const raceTimeout = new Promise((resolve) => {
      raceTimer = setTimeout(() => { controller.abort(); resolve(); }, REVOKE_TIMEOUT_MS);
    });
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener('abort', resolve, { once: true });
    });
    try {
      await Promise.race([
        requestJson('/api/auth/logout', {
          baseUrl: resolveApiBaseUrl({ session: snap }),
          method: 'POST',
          session: snap,
          signal: controller.signal,
          _retry: true,
        }),
        raceTimeout,
        aborted,
      ]);
    } catch {
      // Server logout is best-effort.
    } finally {
      clearTimeout(raceTimer);
      pendingControllersRef.current.delete(controller);
    }
  }, []);

  // Revokes the server session first (while sessionRef still points at the
  // live intranet session), then clears local state.
  // 시작할 때 인증 문맥 세대를 잡고, revoke를 기다린 뒤 그대로일 때만 방송 + 세션 리셋 + 작업 공간 비우기를 같은 동기
  // 구간에서 한다. 달라졌으면(그사이 강제 로그아웃 뒤 다른 계정 로그인 등) 아무것도 하지 않는다.
  // expectedGen을 주면(로그아웃 확인창을 연 시점의 세대) 시작할 때 이미 달라졌으면 아무것도 하지 않는다 — 확인창이 떠 있는
  // 동안 다른 탭의 로그인 방송으로 되돌려졌으면 그 탭까지 로그아웃시키지 않게. 끝까지 진행했으면 true.
  const logout = useCallback(async ({ expectedGen } = {}) => {
    const snap = sessionRef.current;
    const gen = authEpochRef.current;
    if (expectedGen !== undefined && expectedGen !== gen) return false;
    await revokeServerSession(snap, { cancelOnContextChange: true });
    if (authEpochRef.current !== gen) return false;
    broadcastLogout();
    resetToLocalSession();
    // 인트라넷 세션의 로그아웃이면 화면을 비운다. 로컬 세션이면 주인이 있을 때만(로컬 작업 보존).
    applyWorkspace({ type: hasIntranetSession(snap) ? 'logout' : 'discard' });
    return true;
  }, [applyWorkspace, resetToLocalSession, revokeServerSession]);

  // Electron: main process asks the renderer to log out before the window
  // actually closes (X button / menu / Ctrl+Q). No local reset here — the
  // app is quitting, and resetting first would race useAuthSync's sessionRef
  // (see revokeServerSession's note above).
  useEffect(() => {
    const lifecycle = getLifecycleBridge();
    if (!lifecycle?.onQuitRequested) return;
    return lifecycle.onQuitRequested(async () => {
      try {
        await revokeServerSession(sessionRef.current);
      } finally {
        lifecycle.notifyQuitLogoutDone();
      }
    });
  }, [revokeServerSession]);

  // Propagate the current access token to the Electron main process so the
  // audit module can sign EMR audit entries without going through the renderer.
  useEffect(() => {
    getLifecycleBridge()?.setAccessToken?.(session?.accessToken || '');
  }, [session?.accessToken]);

  const value = useMemo(() => ({
    session,
    user: normalizeSession(session).user,
    // sessionVerified gates isAuthenticated: persisted intranet sessions are not
    // trusted until the boot-time /api/auth/csrf check confirms the refresh cookie.
    isAuthenticated: hasIntranetSession(session) && !!session?.user?.id && sessionVerified,
    sessionVerified,
    setSession,
    resetToLocalSession,
    getAuthEpoch,
    getSession,
    login,
    logout,
    workspaceEpoch: workspace.epoch,
    getWorkspaceOwner,
    discardWorkspace,
    invalidateAuthContext,
    beginLoginAttempt,
  }), [
    session, sessionVerified, setSession, resetToLocalSession, getAuthEpoch, getSession, login, logout,
    workspace.epoch, getWorkspaceOwner, discardWorkspace, invalidateAuthContext, beginLoginAttempt,
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

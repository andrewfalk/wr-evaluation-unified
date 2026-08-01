import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearStoredSession,
  createLocalSession,
  loadStoredSession,
  normalizeSession,
  saveStoredSession,
} from './session';
import { broadcastLogout } from './authChannel';
import { requestJson } from '../services/httpClient';

const AuthContext = createContext(null);

const REVOKE_TIMEOUT_MS = 2500;

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(() => loadStoredSession());
  // Boot-time flag: false for persisted intranet sessions until /api/auth/csrf confirms
  // the refresh cookie is still valid. True immediately for local/non-intranet sessions.
  const [sessionVerified, setSessionVerified] = useState(
    () => loadStoredSession()?.mode !== 'intranet'
  );
  // Ref that shadows session state so callbacks don't close over stale values.
  const sessionRef = useRef(session);
  // Bumped every time resetToLocalSession() runs. useAuthSync captures this
  // before starting a refresh and re-checks it before applying the result —
  // see resetToLocalSession's comment for why this exists.
  const authEpochRef = useRef(0);

  // Verify a persisted intranet session on mount. Uses plain fetch (not httpClient)
  // to avoid triggering the refresh interceptor before configureHttpClient is wired.
  // On failure, falls back to local session rather than leaving a stale intranet session.
  useEffect(() => {
    const snap = sessionRef.current;
    if (snap?.mode !== 'intranet') return;
    // Identity key: uniquely identifies the session at request time so the response
    // handler can detect if login/logout changed the session while the request was in flight.
    const snapIdentity = `${snap.mode}|${snap.apiBaseUrl || ''}|${snap.user?.id || ''}|${snap.refreshedAt || ''}`;
    const baseUrl = snap.apiBaseUrl || '';
    fetch(`${baseUrl}/api/auth/csrf`, { method: 'POST', credentials: 'include' })
      .then(async r => {
        // Skip if the session changed while the request was in flight (e.g. login/logout).
        const currentIdentity = `${sessionRef.current.mode}|${sessionRef.current.apiBaseUrl || ''}|${sessionRef.current.user?.id || ''}|${sessionRef.current.refreshedAt || ''}`;
        if (currentIdentity !== snapIdentity) return;

        if (!r.ok) {
          clearStoredSession();
          const fallback = saveStoredSession(createLocalSession());
          sessionRef.current = fallback;
          setSessionState(fallback);
          setSessionVerified(true); // local session needs no server check
          return;
        }
        // Apply access token if the server returns one (forward-compatible: no-op if absent).
        let data = null;
        try { data = await r.json(); } catch { /* csrf-only response with no body */ }
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
      })
      .catch(() => {
        // Same guard: don't reset a session that changed after the request started.
        const currentIdentity = `${sessionRef.current.mode}|${sessionRef.current.apiBaseUrl || ''}|${sessionRef.current.user?.id || ''}|${sessionRef.current.refreshedAt || ''}`;
        if (currentIdentity !== snapIdentity) return;
        clearStoredSession();
        const fallback = saveStoredSession(createLocalSession());
        sessionRef.current = fallback;
        setSessionState(fallback);
        setSessionVerified(true); // local session needs no server check
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — mount-only, uses ref snapshot

  // Normalize and persist outside the state updater so the return value is stable.
  const setSession = useCallback((nextSession) => {
    const resolved = typeof nextSession === 'function'
      ? nextSession(sessionRef.current)
      : nextSession;
    const normalized = saveStoredSession(resolved);
    sessionRef.current = normalized;
    setSessionState(normalized);
    return normalized;
  }, []);

  const resetToLocalSession = useCallback(() => {
    // Invalidate any refresh that was already in flight when this reset was
    // triggered — without this, a refresh that finally succeeds after we've
    // reset (e.g. past revokeServerSession's timeout backstop) would call
    // setSession() with a fresh accessToken/user and silently resurrect an
    // intranet session right after the user logged out.
    authEpochRef.current += 1;
    clearStoredSession();
    const fallback = saveStoredSession(createLocalSession());
    sessionRef.current = fallback;
    setSessionState(fallback);
    // Local sessions need no server verification — mark as verified immediately
    // so sessionVerified=false is reserved exclusively for "intranet boot check in-flight".
    setSessionVerified(true);
    return fallback;
  }, []);

  const getAuthEpoch = useCallback(() => authEpochRef.current, []);

  // Called after a successful server login. serverResponse = { user, accessToken, accessExpiresAt }.
  const login = useCallback((serverResponse, apiBaseUrl = '') => {
    const next = normalizeSession({
      mode: 'intranet',
      status: 'ready',
      apiBaseUrl,
      accessToken: serverResponse.accessToken,
      accessExpiresAt: serverResponse.accessExpiresAt,
      refreshedAt: new Date().toISOString(),
      user: serverResponse.user,
    });
    // saveStoredSession strips accessToken before writing localStorage.
    saveStoredSession(next);
    sessionRef.current = next;
    setSessionState(next);
    setSessionVerified(true);
    return next;
  }, []);

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
  const revokeServerSession = useCallback(async (snap) => {
    if (snap?.mode !== 'intranet') return;
    let raceTimer;
    const raceTimeout = new Promise((resolve) => {
      raceTimer = setTimeout(resolve, REVOKE_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        requestJson('/api/auth/logout', {
          baseUrl: snap.apiBaseUrl || '',
          method: 'POST',
          session: snap,
          _retry: true,
        }),
        raceTimeout,
      ]);
    } catch {
      // Server logout is best-effort.
    } finally {
      clearTimeout(raceTimer);
    }
  }, []);

  // Revokes the server session first (while sessionRef still points at the
  // live intranet session), then clears local state.
  const logout = useCallback(async () => {
    const snap = sessionRef.current;
    try {
      await revokeServerSession(snap);
    } finally {
      broadcastLogout();
      resetToLocalSession();
    }
  }, [resetToLocalSession, revokeServerSession]);

  // Electron: main process asks the renderer to log out before the window
  // actually closes (X button / menu / Ctrl+Q). No local reset here — the
  // app is quitting, and resetting first would race useAuthSync's sessionRef
  // (see revokeServerSession's note above).
  useEffect(() => {
    if (!window.electron?.onQuitRequested) return;
    return window.electron.onQuitRequested(async () => {
      try {
        await revokeServerSession(sessionRef.current);
      } finally {
        window.electron.notifyQuitLogoutDone();
      }
    });
  }, [revokeServerSession]);

  // Propagate the current access token to the Electron main process so the
  // audit module can sign EMR audit entries without going through the renderer.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron?.setAccessToken) {
      window.electron.setAccessToken(session?.accessToken || '');
    }
  }, [session?.accessToken]);

  const value = useMemo(() => ({
    session,
    user: normalizeSession(session).user,
    // sessionVerified gates isAuthenticated: persisted intranet sessions are not
    // trusted until the boot-time /api/auth/csrf check confirms the refresh cookie.
    isAuthenticated: session?.mode === 'intranet' && !!session?.user?.id && sessionVerified,
    sessionVerified,
    setSession,
    resetToLocalSession,
    getAuthEpoch,
    login,
    logout,
  }), [session, sessionVerified, setSession, resetToLocalSession, getAuthEpoch, login, logout]);

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

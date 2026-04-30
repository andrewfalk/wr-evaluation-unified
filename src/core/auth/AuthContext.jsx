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

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(() => loadStoredSession());
  // Boot-time flag: false for persisted intranet sessions until /api/auth/csrf confirms
  // the refresh cookie is still valid. True immediately for local/non-intranet sessions.
  const [sessionVerified, setSessionVerified] = useState(
    () => loadStoredSession()?.mode !== 'intranet'
  );
  // Ref that shadows session state so callbacks don't close over stale values.
  const sessionRef = useRef(session);

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
    clearStoredSession();
    const fallback = saveStoredSession(createLocalSession());
    sessionRef.current = fallback;
    setSessionState(fallback);
    // Local sessions need no server verification — mark as verified immediately
    // so sessionVerified=false is reserved exclusively for "intranet boot check in-flight".
    setSessionVerified(true);
    return fallback;
  }, []);

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

  // Calls /api/auth/logout, then resets to local session regardless of server response.
  const logout = useCallback(async () => {
    const snap = sessionRef.current; // capture via ref before state is cleared
    broadcastLogout();
    resetToLocalSession();
    try {
      if (snap?.mode === 'intranet') {
        await requestJson('/api/auth/logout', {
          baseUrl: snap.apiBaseUrl || '',
          method: 'POST',
          session: snap,
        });
      }
    } catch {
      // Server logout is best-effort; local state is already cleared.
    }
  }, [resetToLocalSession]);

  const value = useMemo(() => ({
    session,
    user: normalizeSession(session).user,
    // sessionVerified gates isAuthenticated: persisted intranet sessions are not
    // trusted until the boot-time /api/auth/csrf check confirms the refresh cookie.
    isAuthenticated: session?.mode === 'intranet' && !!session?.user?.id && sessionVerified,
    sessionVerified,
    setSession,
    resetToLocalSession,
    login,
    logout,
  }), [session, sessionVerified, setSession, resetToLocalSession, login, logout]);

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

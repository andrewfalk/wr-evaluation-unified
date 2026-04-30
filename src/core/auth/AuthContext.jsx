import { createContext, useCallback, useContext, useMemo, useState } from 'react';
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

  const setSession = useCallback((nextSession) => {
    let normalized;
    setSessionState(prevSession => {
      const resolved = typeof nextSession === 'function'
        ? nextSession(prevSession)
        : nextSession;

      normalized = saveStoredSession(resolved);
      return normalized;
    });

    return normalized;
  }, []);

  const resetToLocalSession = useCallback(() => {
    clearStoredSession();
    const fallback = saveStoredSession(createLocalSession());
    setSessionState(fallback);
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
    setSessionState(next);
    return next;
  }, []);

  // Calls /api/auth/logout, then resets to local session regardless of server response.
  const logout = useCallback(async () => {
    const snap = session; // capture before clear
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
  }, [session, resetToLocalSession]);

  const value = useMemo(() => ({
    session,
    user: normalizeSession(session).user,
    isAuthenticated: session?.mode === 'intranet' && !!session?.user?.id,
    setSession,
    resetToLocalSession,
    login,
    logout,
  }), [session, setSession, resetToLocalSession, login, logout]);

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

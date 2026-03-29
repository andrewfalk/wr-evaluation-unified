import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  clearStoredSession,
  createLocalSession,
  loadStoredSession,
  normalizeSession,
  saveStoredSession,
} from './session';

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

  const value = useMemo(() => ({
    session,
    user: normalizeSession(session).user,
    isAuthenticated: !!session?.user?.id,
    setSession,
    resetToLocalSession,
  }), [session]);

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

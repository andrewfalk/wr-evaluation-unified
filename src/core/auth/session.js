const AUTH_SESSION_KEY = 'wrEvalUnifiedAuthSession';
const AUTH_SESSION_VERSION = 1;

function getRuntimeSource() {
  if (typeof window !== 'undefined' && window.electron) {
    return 'electron';
  }
  return 'web';
}

export function createLocalSession(overrides = {}) {
  const runtime = getRuntimeSource();
  const now = new Date().toISOString();
  const baseSession = {
    version: AUTH_SESSION_VERSION,
    mode: 'local',
    status: 'ready',
    accessToken: null,
    apiBaseUrl: '',
    refreshedAt: now,
    user: {
      id: `${runtime}-user`,
      displayName: runtime === 'electron-local' ? 'Desktop User' : 'Local User',
      email: '',
      role: 'clinician',
      organizationId: runtime === 'electron-local' ? 'local-electron-workspace' : 'local-web-workspace',
      authProvider: 'local-fallback',
    },
  };

  return {
    ...baseSession,
    ...overrides,
    user: {
      ...baseSession.user,
      ...(overrides.user || {}),
    },
  };
}

export function normalizeSession(session) {
  if (!session || typeof session !== 'object') {
    return createLocalSession();
  }

  const fallback = createLocalSession();
  return {
    ...fallback,
    ...session,
    user: {
      ...fallback.user,
      ...(session.user || {}),
    },
  };
}

export function loadStoredSession() {
  if (typeof window === 'undefined') {
    return createLocalSession();
  }

  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return createLocalSession();
    return normalizeSession(JSON.parse(raw));
  } catch {
    return createLocalSession();
  }
}

export function saveStoredSession(session) {
  if (typeof window === 'undefined') return normalizeSession(session);

  const normalized = normalizeSession(session);
  // Access token lives in memory only — never persisted to localStorage.
  // Refresh token lives in HttpOnly cookie (server-managed).
  const { accessToken: _drop, ...toStore } = normalized;
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(toStore));
  return normalized;
}

export function clearStoredSession() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(AUTH_SESSION_KEY);
}

export function buildSessionHeaders(session) {
  const headers = {};

  if (session?.accessToken) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  }

  if (session?.user?.id) {
    headers['X-WR-User-Id'] = session.user.id;
  }

  if (session?.user?.organizationId) {
    headers['X-WR-Org-Id'] = session.user.organizationId;
  }

  if (session?.mode) {
    headers['X-WR-Auth-Mode'] = session.mode;
  }

  return headers;
}

export function getSessionUser(session) {
  return normalizeSession(session).user;
}

import { useEffect, useRef } from 'react';
import { configureHttpClient } from '../services/httpClient';
import { getCsrfToken } from '../utils/csrfCookie';
import { normalizeSession } from '../auth/session';
import { runRefreshWithBroadcast, onAuthBroadcast, broadcastLogout } from '../auth/authChannel';

export function applyAuthUpdate(currentSession, authUpdate) {
  const patch = typeof authUpdate === 'string'
    ? { accessToken: authUpdate }
    : (authUpdate || {});
  const next = {
    ...(currentSession || {}),
    status: 'ready',
  };
  if (patch.accessToken !== undefined) next.accessToken = patch.accessToken;
  if (patch.accessExpiresAt !== undefined) next.accessExpiresAt = patch.accessExpiresAt;
  if (patch.user) next.user = { ...(currentSession?.user || {}), ...patch.user };
  return normalizeSession(next);
}

// 인증 토큰 리프레시 + 멀티탭 브로드캐스트 와이어링
export function useAuthSync({ session, setSession, resetToLocalSession }) {
  // Keep a stable ref to the latest session so the refresh handler never
  // captures a stale closure value.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Wire up httpClient's 401-refresh interceptor once at mount.
  useEffect(() => {
    configureHttpClient({
      // baseUrl comes from the original failed request so we always hit the
      // same server, even if session.apiBaseUrl is momentarily out of sync.
      onRefresh: ({ baseUrl: requestBaseUrl, forceCsrf = false } = {}) =>
        runRefreshWithBroadcast(
          // doRefresh: this tab won the lock and performs the actual refresh.
          async () => {
            const current = sessionRef.current;
            const base = (
              requestBaseUrl ?? current?.apiBaseUrl ?? ''
            ).trim().replace(/\/$/, '');

            let csrfToken = getCsrfToken();

            // CSRF cookie missing: call /api/auth/csrf first (no CSRF required
            // for this endpoint). It re-validates the HttpOnly refresh cookie,
            // sets a new wr_csrf cookie, and returns a fresh accessToken.
            if (forceCsrf || !csrfToken) {
              const csrfRes = await fetch(`${base}/api/auth/csrf`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
              });
              if (!csrfRes.ok) throw new Error('CSRF renewal failed');
              const csrfData = await csrfRes.json();
              const newSession = applyAuthUpdate(sessionRef.current, csrfData);
              setSession(newSession);
              return newSession;
            }

            const res = await fetch(`${base}/api/auth/refresh`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
              },
            });
            if (!res.ok) throw new Error('Refresh failed');
            const data = await res.json();
            const newSession = applyAuthUpdate(sessionRef.current, data);
            setSession(newSession);
            return newSession;
          },
          // applyToken: another tab broadcast REFRESH_SUCCESS — update this
          // tab's session without a server round-trip.
          (authUpdate) => {
            const newSession = applyAuthUpdate(sessionRef.current, authUpdate);
            setSession(newSession);
            return newSession;
          },
        ),
      onLogout: () => { broadcastLogout(); resetToLocalSession(); },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync session state when another tab refreshes or logs out.
  useEffect(() => {
    return onAuthBroadcast((msg) => {
      if (msg?.type === 'REFRESH_SUCCESS' && msg.accessToken) {
        setSession(prev => applyAuthUpdate(prev, msg));
      } else if (msg?.type === 'LOGOUT') {
        resetToLocalSession();
      }
    });
  }, [setSession, resetToLocalSession]);
}

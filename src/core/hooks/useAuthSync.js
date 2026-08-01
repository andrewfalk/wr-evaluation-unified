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
export function useAuthSync({ session, setSession, resetToLocalSession, getAuthEpoch }) {
  // Keep a stable ref to the latest session so the refresh handler never
  // captures a stale closure value.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Wire up httpClient's 401-refresh interceptor once at mount.
  useEffect(() => {
    configureHttpClient({
      // baseUrl comes from the original failed request so we always hit the
      // same server, even if session.apiBaseUrl is momentarily out of sync.
      onRefresh: ({ baseUrl: requestBaseUrl, forceCsrf = false } = {}) => {
        // Captured once per refresh attempt. If resetToLocalSession() runs
        // (e.g. a caller gave up waiting and logged out locally) before this
        // refresh finishes, the epoch will have moved on — the result below
        // is then applied to authChannel's cross-tab broadcast only, never
        // to this tab's own session, so it can't resurrect a logged-out tab.
        const epoch = getAuthEpoch?.();
        const isStale = () => epoch !== undefined && getAuthEpoch?.() !== epoch;

        return runRefreshWithBroadcast(
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
              if (!isStale()) setSession(newSession);
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
            if (!isStale()) setSession(newSession);
            return newSession;
          },
          // applyToken: another tab broadcast REFRESH_SUCCESS — update this
          // tab's session without a server round-trip.
          (authUpdate) => {
            const newSession = applyAuthUpdate(sessionRef.current, authUpdate);
            if (!isStale()) setSession(newSession);
            return newSession;
          },
        );
      },
      onLogout: () => { broadcastLogout(); resetToLocalSession(); },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync session state when another tab refreshes or logs out.
  useEffect(() => {
    return onAuthBroadcast((msg) => {
      // Guard against a REFRESH_SUCCESS that was broadcast by another tab's
      // refresh but arrives after THIS tab already logged out locally (e.g.
      // it processed an earlier LOGOUT broadcast, or its own logout timed
      // out and reset). Applying it here would silently resurrect this tab's
      // session right after the user logged out.
      if (msg?.type === 'REFRESH_SUCCESS' && msg.accessToken && sessionRef.current?.mode === 'intranet') {
        setSession(prev => applyAuthUpdate(prev, msg));
      } else if (msg?.type === 'LOGOUT') {
        resetToLocalSession();
      }
    });
  }, [setSession, resetToLocalSession]);
}

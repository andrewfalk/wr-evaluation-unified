// @ts-nocheck
import { useEffect, useRef } from 'react';
import { configureHttpClient } from '../services/httpClient';
import { getCsrfToken } from '../utils/csrfCookie';
import { normalizeSession } from '../auth/session';
import { runRefreshWithBroadcast, onAuthBroadcast, broadcastLogout } from '../auth/authChannel';

import { hasIntranetSession, intranetIdentityOf } from '../../platform/dataMode';
import { refreshAccessToken, renewCsrf } from '../api/authApi';
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
export function useAuthSync({ session, setSession, resetToLocalSession, getAuthEpoch, getSession }) {
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
        // 갱신을 시작한 계정 — 기다리는 사이 화면의 계정이 바뀌었으면(로그인·되돌림) 결과로 지금 세션을 덮어쓰지 않는다.
        const readCurrent = () => (getSession ? getSession() : sessionRef.current);
        const startIdentity = intranetIdentityOf(readCurrent());
        const isStale = () => (epoch !== undefined && getAuthEpoch?.() !== epoch)
          || intranetIdentityOf(readCurrent()) !== startIdentity;

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
              const csrfData = await renewCsrf(base);
              const newSession = applyAuthUpdate(readCurrent(), csrfData);
              if (!isStale()) setSession(newSession);
              return newSession;
            }

            const data = await refreshAccessToken(base, csrfToken);
            const newSession = applyAuthUpdate(readCurrent(), data);
            if (!isStale()) setSession(newSession);
            return newSession;
          },
          // applyToken: another tab broadcast REFRESH_SUCCESS — update this
          // tab's session without a server round-trip.
          (authUpdate) => {
            const newSession = applyAuthUpdate(readCurrent(), authUpdate);
            if (!isStale()) setSession(newSession);
            return newSession;
          },
        );
      },
      onLogout: () => { broadcastLogout(); resetToLocalSession(); },
      // 요청 신원 고정 — 이미 떠난 계정의 요청이 401을 받으면 갱신·로그아웃하지 않는다(apiClient).
      // AuthContext의 getSession은 세션이 바뀌는 그 동기 구간에 갱신된다(이 훅의 sessionRef는 effect 뒤라 늦다).
      getCurrentSession: () => (getSession ? getSession() : sessionRef.current),
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
      if (msg?.type === 'REFRESH_SUCCESS' && msg.accessToken && hasIntranetSession(sessionRef.current)) {
        setSession(prev => applyAuthUpdate(prev, msg));
      } else if (msg?.type === 'LOGOUT') {
        resetToLocalSession();
      }
    });
  }, [setSession, resetToLocalSession]);
}

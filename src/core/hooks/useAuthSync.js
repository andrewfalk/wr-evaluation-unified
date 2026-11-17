// @ts-nocheck
import { useEffect, useRef } from 'react';
import { configureHttpClient } from '../services/httpClient';
import { getCsrfToken } from '../utils/csrfCookie';
import { normalizeSession } from '../auth/session';
import { runRefreshWithBroadcast, onAuthBroadcast, broadcastLogout, authServerKeyOf } from '../auth/authChannel';

import { hasIntranetSession, intranetIdentityOf, sessionIdentityOf } from '../../platform/dataMode';
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
        // 갱신을 시작한 계정(서버 주소 포함) — 기다리는 사이 화면의 계정·서버가 바뀌었으면(로그인·되돌림) 결과로 지금 세션을 덮어쓰지 않는다.
        const readCurrent = () => (getSession ? getSession() : sessionRef.current);
        const startIdentity = sessionIdentityOf(readCurrent());
        const isStale = () => (epoch !== undefined && getAuthEpoch?.() !== epoch)
          || sessionIdentityOf(readCurrent()) !== startIdentity;

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
      // 판정은 AuthContext의 getSession()(세션이 바뀌는 그 동기 구간에 갱신)으로 — 이 훅의 sessionRef는 커밋 뒤 effect에서야
      // 따라와, 로컬 세션으로 바뀐 직후·다음 커밋 전에는 이전(인트라넷) 세션을 가리킨다(아래 LOGIN 처리와 같은 방식, P2-46b).
      if (msg?.type === 'REFRESH_SUCCESS' && msg.accessToken && hasIntranetSession(getSession ? getSession() : sessionRef.current)) {
        setSession(prev => applyAuthUpdate(prev, msg));
      } else if (msg?.type === 'LOGOUT') {
        resetToLocalSession();
      } else if (msg?.type === 'LOGIN') {
        // 다른 탭이 같은 서버에 로그인했다 — 그 서버의 로그인 쿠키는 이제 그 계정 것이다. 이 탭이 같은 서버를 다른 계정으로
        // 쓰고 있으면 로그인 화면으로 되돌린다(작업 공간 주인은 유지 — 원래 계정으로 다시 로그인하면 이어 간다).
        // 같은 계정·로컬 세션·다른 서버(쿠키가 따로)·서버 정보가 없는 방송은 무시.
        const current = getSession ? getSession() : sessionRef.current;
        const mine = intranetIdentityOf(current);
        if (
          mine !== null && typeof msg.identity === 'string' && typeof msg.server === 'string'
          && msg.server === authServerKeyOf(current?.apiBaseUrl) && msg.identity !== mine
        ) {
          resetToLocalSession();
        }
      }
    });
  }, [setSession, resetToLocalSession, getSession]);
}

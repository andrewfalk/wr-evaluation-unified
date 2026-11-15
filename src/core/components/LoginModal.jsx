// @ts-nocheck
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { requestJson } from '../services/httpClient';
import { isElectron } from '../utils/platform';
import { SignupRequestModal } from './SignupRequestModal';

// 429 두 종류를 한국어로 안내한다: LOGIN_LOCKED = 같은 아이디로 여러 번 실패해 서버가 잠시 잠금
// (SEC-B M2, retryAfterSec 포함), RATE_LIMITED = 이 PC(IP)에서 1분에 5회를 넘김.
function loginErrorMessage(err) {
  if (err?.status === 429) {
    if (err.data?.code === 'LOGIN_LOCKED') {
      const sec = Number(err.data.retryAfterSec);
      const wait = Number.isFinite(sec) && sec > 0
        ? (sec >= 60 ? `약 ${Math.ceil(sec / 60)}분` : `${Math.ceil(sec)}초`)
        : '잠시';
      return `로그인에 여러 번 실패해 이 아이디가 잠시 잠겼습니다. ${wait} 후 다시 시도하세요.`;
    }
    return '로그인 시도가 너무 많습니다. 1분 뒤 다시 시도하세요.';
  }
  return err?.message || '로그인에 실패했습니다.';
}

// onBeforeLogin: 서버 인증에 성공한 뒤 로그인을 적용하기 직전에 기다릴 일(로컬 작업 보존 — 실패하면 던진다, AS-4).
// onPendingChange: 로그인 요청이 진행 중인지 알린다(그동안 "로컬 모드로 전환"을 막는다).
export function LoginModal({ apiBaseUrl = '', onBeforeLogin, onPendingChange }) {
  const { login, beginLoginAttempt } = useAuth();
  // 언마운트된 화면은 늦게 끝난 로그인 요청을 적용하지 않는다(StrictMode의 시험 언마운트 뒤에는 setup이 되돌린다).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [loginId, setLoginId]       = useState('');
  const [password, setPassword]     = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [showSignup, setShowSignup] = useState(false);
  // 웹은 7.2.0부터 기본이 세션 쿠키(브라우저를 닫으면 다시 로그인, SEC-B M3) — "로그인 유지"를 켜야
  // 영구 쿠키를 받는다. Electron은 항상 false(앱 재시작 시 재로그인, PR#79)라 체크박스를 보이지 않는다.
  const [rememberMe, setRememberMe] = useState(false);
  const electron = isElectron();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!loginId.trim() || !password) return;
    setLoading(true);
    setError('');
    onPendingChange?.(true);
    // 로그인 시도 — 인증 문맥이 바뀌면(다른 로그인·로컬 전환·화면 재시작) 요청이 취소되고 응답이 와도 적용되지 않는다.
    const attempt = beginLoginAttempt?.();
    try {
      const data = await requestJson('/api/auth/login', {
        baseUrl: apiBaseUrl,
        method: 'POST',
        body: { loginId: loginId.trim(), password, rememberMe: !electron && rememberMe },
        _retry: true, // login 401 = wrong credentials, not token expiry — skip refresh interceptor
        ...(attempt ? { signal: attempt.signal } : {}),
      });
      if (!mountedRef.current) return;
      if (onBeforeLogin) {
        try {
          await onBeforeLogin();
        } catch {
          if (mountedRef.current) setError('로컬 작업을 저장하지 못했습니다. 다시 시도하세요.');
          return;
        }
        // 기다리는 사이 화면이 내려갔으면 적용하지 않는다(문맥이 바뀌었으면 login이 시도 세대로 거른다).
        if (!mountedRef.current) return;
      }
      login(data, apiBaseUrl, attempt);
    } catch (err) {
      // 문맥이 바뀌어 취소된 시도는 안내하지 않는다(사용자가 다른 동작을 했다).
      if (err?.name === 'AbortError' || attempt?.signal.aborted) return;
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
      onPendingChange?.(false);
    }
  };

  return (
    <div className="app-boot-overlay">
      <div className="app-boot-box login-modal-box">
        <h2 className="login-modal-title">인트라넷 로그인</h2>
        {apiBaseUrl && (
          <p className="app-boot-hint">{apiBaseUrl}</p>
        )}
        <form onSubmit={handleSubmit} className="login-modal-form">
          <div className="login-modal-field">
            <label htmlFor="login-id">아이디</label>
            <input
              id="login-id"
              type="text"
              value={loginId}
              onChange={e => setLoginId(e.target.value)}
              autoComplete="username"
              autoFocus
              disabled={loading}
              required
            />
          </div>
          <div className="login-modal-field">
            <label htmlFor="login-password">비밀번호</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={loading}
              required
            />
          </div>
          {!electron && (
            <label className="login-modal-remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
                disabled={loading}
              />
              로그인 유지
            </label>
          )}
          {error && (
            <p className="login-modal-error">{error}</p>
          )}
          <button
            type="submit"
            className="btn btn-primary login-modal-submit"
            disabled={loading || !loginId.trim() || !password}
          >
            {loading ? '로그인 중…' : '로그인'}
          </button>
        </form>
        <p className="login-modal-signup-hint">
          계정이 없으신가요?{' '}
          <button
            type="button"
            className="login-modal-signup-link"
            onClick={() => setShowSignup(true)}
          >
            계정 신청
          </button>
        </p>
      </div>
      {showSignup && (
        <SignupRequestModal apiBaseUrl={apiBaseUrl} onClose={() => setShowSignup(false)} />
      )}
    </div>
  );
}

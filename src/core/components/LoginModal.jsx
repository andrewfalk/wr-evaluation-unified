// @ts-nocheck
import { useState } from 'react';
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

export function LoginModal({ apiBaseUrl = '' }) {
  const { login } = useAuth();
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
    try {
      const data = await requestJson('/api/auth/login', {
        baseUrl: apiBaseUrl,
        method: 'POST',
        body: { loginId: loginId.trim(), password, rememberMe: !electron && rememberMe },
        _retry: true, // login 401 = wrong credentials, not token expiry — skip refresh interceptor
      });
      login(data, apiBaseUrl);
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
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

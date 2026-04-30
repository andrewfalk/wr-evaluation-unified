import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { requestJson } from '../services/httpClient';

export function LoginModal({ apiBaseUrl = '' }) {
  const { login } = useAuth();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!loginId.trim() || !password) return;
    setLoading(true);
    setError('');
    try {
      const data = await requestJson('/api/auth/login', {
        baseUrl: apiBaseUrl,
        method: 'POST',
        body: { loginId: loginId.trim(), password },
      });
      login(data, apiBaseUrl);
    } catch (err) {
      setError(err.message || '로그인에 실패했습니다.');
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
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { requestJson } from '../services/httpClient';

export function ChangePasswordModal({ apiBaseUrl = '', onClose }) {
  const { session, setSession } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const mismatch = confirmPassword && newPassword !== confirmPassword;
  const tooShort = newPassword && newPassword.length < 10;
  const canSubmit = currentPassword && newPassword.length >= 10 && newPassword === confirmPassword && !loading;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError('');
    try {
      const data = await requestJson('/api/auth/change-password', {
        baseUrl: apiBaseUrl,
        method: 'POST',
        session,
        body: { currentPassword, newPassword },
        // No _retry: token expiry 401 → interceptor refreshes → retry (correct).
        // Wrong password 401 → httpClient detects WRONG_CURRENT_PASSWORD code and throws directly,
        // skipping refresh entirely (see httpClient.js WRONG_CURRENT_PASSWORD guard).
      });
      // Server returns updated user (mustChangePassword=false) and optionally new tokens.
      if (data?.accessToken) {
        // Full session rotation (server revoked other sessions, issued new token).
        setSession(prev => ({
          ...prev,
          accessToken: data.accessToken,
          accessExpiresAt: data.accessExpiresAt,
          refreshedAt: new Date().toISOString(),
          user: { ...prev.user, ...data.user, mustChangePassword: false },
        }));
      } else {
        setSession(prev => ({
          ...prev,
          user: { ...prev.user, ...(data?.user || {}), mustChangePassword: false },
        }));
      }
    } catch (err) {
      setError(err.message || '비밀번호 변경에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const isForced = !onClose;

  return (
    <div className={isForced ? 'app-boot-overlay' : 'modal-overlay'} onClick={isForced ? undefined : onClose}>
      <div className={isForced ? 'app-boot-box login-modal-box' : 'modal login-modal-box'} onClick={e => e.stopPropagation()}>
        <h2 className="login-modal-title">{isForced ? '비밀번호 변경 필요' : '비밀번호 변경'}</h2>
        {isForced && (
          <p className="app-boot-hint" style={{ textAlign: 'center' }}>
            최초 로그인입니다. 보안을 위해 비밀번호를 변경해 주세요.
          </p>
        )}
        <form onSubmit={handleSubmit} className="login-modal-form">
          <div className="login-modal-field">
            <label htmlFor="cp-current">현재 비밀번호</label>
            <input
              id="cp-current"
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              disabled={loading}
              required
            />
          </div>
          <div className="login-modal-field">
            <label htmlFor="cp-new">새 비밀번호 (10자 이상)</label>
            <input
              id="cp-new"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              autoComplete="new-password"
              disabled={loading}
              required
            />
            {tooShort && (
              <span className="login-modal-error">비밀번호는 10자 이상이어야 합니다.</span>
            )}
          </div>
          <div className="login-modal-field">
            <label htmlFor="cp-confirm">새 비밀번호 확인</label>
            <input
              id="cp-confirm"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              disabled={loading}
              required
            />
            {mismatch && (
              <span className="login-modal-error">비밀번호가 일치하지 않습니다.</span>
            )}
          </div>
          {error && <p className="login-modal-error">{error}</p>}
          <button
            type="submit"
            className="btn btn-primary login-modal-submit"
            disabled={!canSubmit}
          >
            {loading ? '변경 중…' : '비밀번호 변경'}
          </button>
          {!isForced && (
            <button
              type="button"
              className="btn btn-secondary login-modal-submit"
              style={{ marginTop: 8 }}
              onClick={onClose}
              disabled={loading}
            >
              취소
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

// @ts-nocheck
import { useState } from 'react';
import { requestJson } from '../services/httpClient';

const ROLE_LABELS = { doctor: '의사', nurse: '간호사', staff: '직원' };

export function SignupRequestModal({ apiBaseUrl = '', onClose }) {
  const [loginId, setLoginId]           = useState('');
  const [name, setName]                 = useState('');
  const [requestedRole, setRequestedRole] = useState('doctor');
  const [note, setNote]                 = useState('');
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');
  const [done, setDone]                 = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await requestJson('/api/auth/signup-requests', {
        baseUrl: apiBaseUrl,
        method: 'POST',
        body: {
          loginId: loginId.trim(),
          name: name.trim(),
          requestedRole,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        _retry: true,
      });
      setDone(true);
    } catch (err) {
      // 서버는 형식이 맞으면 중복·기존 아이디도 항상 202로 답한다(SEC-B L4) — 여기 오는 것은 형식 오류(400),
      // 신청 횟수 제한(429), 네트워크·서버 오류뿐이다.
      setError(err?.status === 429
        ? '신청이 너무 많습니다. 잠시 후 다시 시도하세요.'
        : err?.status === 400
          ? '입력 내용을 확인하세요.'
          : err?.message || '요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: '420px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>계정 신청</h2>
            <p className="modal-section-description">관리자 승인 후 계정이 생성됩니다.</p>
          </div>
        </div>

        {done ? (
          <div style={{ padding: '1.5rem 0', textAlign: 'center' }}>
            <p style={{ marginBottom: '1rem', color: 'var(--text-primary)' }}>
              요청이 접수되었습니다.<br />
              관리자 승인 후 로그인 정보를 안내합니다.
            </p>
            <p className="modal-section-description" style={{ marginBottom: '1rem' }}>
              이미 신청했거나 사용 중인 아이디는 새로 접수되지 않습니다. 안내가 없으면 관리자에게 문의하세요.
            </p>
            <button className="btn btn-primary" onClick={onClose}>확인</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="admin-create-form">
            <div className="admin-create-form-row">
              <label>아이디</label>
              <input
                type="text"
                value={loginId}
                onChange={e => setLoginId(e.target.value)}
                placeholder="영문·숫자·._- 사용 가능"
                required
                minLength={3}
                maxLength={50}
                disabled={loading}
                autoFocus
              />
            </div>
            <div className="admin-create-form-row">
              <label>이름</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                maxLength={100}
                disabled={loading}
              />
            </div>
            <div className="admin-create-form-row">
              <label>직종</label>
              <select
                value={requestedRole}
                onChange={e => setRequestedRole(e.target.value)}
                disabled={loading}
              >
                {Object.entries(ROLE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div className="admin-create-form-row">
              <label>메모 (선택)</label>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={500}
                rows={2}
                disabled={loading}
                style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '0.9rem' }}
              />
            </div>
            {error && <p className="admin-error">{error}</p>}
            <div className="modal-actions" style={{ marginTop: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={loading}>
                취소
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || !loginId.trim() || !name.trim()}
              >
                {loading ? '신청 중…' : '신청'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

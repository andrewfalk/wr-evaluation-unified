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
      const raw = err?.message || '';
      setError(raw.includes('ALREADY_REQUESTED')
        ? '이미 대기 중인 신청이 있습니다.'
        : raw || '요청에 실패했습니다.');
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
              신청이 접수되었습니다.<br />
              관리자 승인 후 로그인 정보가 전달됩니다.
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

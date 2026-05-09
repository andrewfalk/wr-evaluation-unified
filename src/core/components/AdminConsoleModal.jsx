import { useEffect, useState } from 'react';
import { requestJson } from '../services/httpClient';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Mirrors server checkPasswordPolicy in auth/passwordPolicy.ts
function validatePassword(pw) {
  if (!pw || pw.length < 10) return '비밀번호는 10자 이상이어야 합니다.';
  if (!/[a-zA-Z가-힣]/.test(pw)) return '비밀번호에 문자(영문 또는 한글)가 포함되어야 합니다.';
  if (!/\d/.test(pw)) return '비밀번호에 숫자가 포함되어야 합니다.';
  if (!/[^a-zA-Z0-9가-힣]/.test(pw)) return '비밀번호에 특수문자가 포함되어야 합니다.';
  return null;
}

function fmt(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString('ko-KR'); } catch { return String(value); }
}

function StatusBadge({ status }) {
  const map = { active: ['connected', '활성'], pending: ['checking', '대기'], revoked: ['fallback', '취소됨'] };
  const [tone, label] = map[status] ?? ['local', status];
  return <span className={`admin-badge admin-badge--${tone}`}>{label}</span>;
}

function RoleBadge({ role }) {
  const label = { admin: '관리자', doctor: '의사', nurse: '간호사', staff: '직원' }[role] ?? role;
  return <span className={`admin-badge admin-badge--role admin-badge--role-${role}`}>{label}</span>;
}

// ── Audit Log Tab ─────────────────────────────────────────────────────────────
function AuditTab({ session }) {
  const [items, setItems]                   = useState([]);
  const [total, setTotal]                   = useState(0);
  const [page, setPage]                     = useState(1);
  const [limit, setLimit]                   = useState(50);
  const [actionFilter, setActionFilter]     = useState('');
  const [targetFilter, setTargetFilter]     = useState('');
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState(null);
  const baseUrl = session?.apiBaseUrl || '';

  const load = async (p = 1) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(limit) });
      if (actionFilter) params.set('action', actionFilter);
      if (targetFilter) params.set('targetType', targetFilter);
      const data = await requestJson(`/api/admin/audit?${params}`, { baseUrl, session });
      setItems(data.items);
      setTotal(data.total);
      setPage(p);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(1); }, []);

  return (
    <div className="admin-tab-content">
      <div className="admin-filter-row">
        <input
          placeholder="액션 필터 (예: patient_push)"
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load(1)}
        />
        <input
          placeholder="대상 유형 (예: patient)"
          value={targetFilter}
          onChange={e => setTargetFilter(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load(1)}
        />
        <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
          {[20, 50, 100, 200].map(n => <option key={n} value={n}>{n}개</option>)}
        </select>
        <button className="btn btn-secondary btn-sm" onClick={() => load(1)} disabled={loading}>
          {loading ? '조회 중…' : '조회'}
        </button>
      </div>
      {error && <div className="admin-error">{error}</div>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>시각</th><th>사용자 ID</th><th>액션</th><th>결과</th>
              <th>대상</th><th>IP</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id}>
                <td>{fmt(item.createdAt)}</td>
                <td className="admin-cell-mono">{item.actorUserId?.slice(0, 8) ?? '-'}</td>
                <td>{item.action}</td>
                <td>
                  <span className={`admin-badge admin-badge--${item.outcome === 'success' ? 'connected' : 'fallback'}`}>
                    {item.outcome}
                  </span>
                </td>
                <td>{item.targetType ? `${item.targetType}/${item.targetId?.slice(0, 8) ?? ''}` : '-'}</td>
                <td className="admin-cell-mono">{item.ip ?? '-'}</td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr><td colSpan={6} className="admin-empty">감사 로그가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="admin-pagination">
        <span>총 {total}건 (페이지 {page})</span>
        {page > 1 && (
          <button className="btn btn-secondary btn-sm" onClick={() => load(page - 1)} disabled={loading}>이전</button>
        )}
        {page * limit < total && (
          <button className="btn btn-secondary btn-sm" onClick={() => load(page + 1)} disabled={loading}>다음</button>
        )}
      </div>
    </div>
  );
}

// ── Devices Tab ───────────────────────────────────────────────────────────────
function DevicesTab({ session }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState(null);
  const [error, setError] = useState(null);
  const baseUrl = session?.apiBaseUrl || '';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await requestJson('/api/admin/devices', { baseUrl, session });
      setDevices(data.devices);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (deviceId, path) => {
    setActioning(deviceId);
    try {
      await requestJson(`/api/admin/devices/${deviceId}/${path}`, { baseUrl, method: 'POST', session });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setActioning(null);
    }
  };

  return (
    <div className="admin-tab-content">
      <div className="admin-filter-row">
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? '로딩 중…' : '새로고침'}
        </button>
      </div>
      {error && <div className="admin-error">{error}</div>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>상태</th><th>사용자</th><th>빌드</th>
              <th>등록일</th><th>마지막 접속</th><th>IP</th><th>액션</th>
            </tr>
          </thead>
          <tbody>
            {devices.map(d => (
              <tr key={d.id} className={d.suspicious ? 'admin-row--warn' : ''}>
                <td><StatusBadge status={d.status} /></td>
                <td>
                  {d.suspicious && <span className="admin-badge admin-badge--warn" title="비정상 UA">⚠</span>}
                  {' '}{d.userName}
                  <div className="admin-cell-hint">{d.userLoginId}</div>
                </td>
                <td>{d.buildTarget}</td>
                <td>{fmt(d.registeredAt)}</td>
                <td>{fmt(d.lastSeenAt)}</td>
                <td className="admin-cell-mono">{d.registerIp ?? '-'}</td>
                <td className="admin-actions-cell">
                  {d.status === 'pending' && (
                    <button className="btn btn-primary btn-sm" disabled={actioning === d.id}
                      onClick={() => act(d.id, 'approve')}>승인</button>
                  )}
                  {d.status !== 'revoked' && (
                    <button className="btn btn-danger btn-sm" disabled={actioning === d.id}
                      onClick={() => act(d.id, 'revoke')}>취소</button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && devices.length === 0 && (
              <tr><td colSpan={7} className="admin-empty">등록된 디바이스가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Users Tab ─────────────────────────────────────────────────────────────────
const EMPTY_FORM = { loginId: '', name: '', role: 'doctor', password: '' };

function UsersTab({ session }) {
  const [users, setUsers]                   = useState([]);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState(null);
  const [form, setForm]                     = useState(EMPTY_FORM);
  const [formError, setFormError]           = useState(null);
  const [creating, setCreating]             = useState(false);
  const [actioning, setActioning]           = useState(null);
  const [resetTarget, setResetTarget]       = useState(null);
  const [resetPw, setResetPw]               = useState('');
  const [resetError, setResetError]         = useState(null);
  const baseUrl = session?.apiBaseUrl || '';
  const selfId  = session?.user?.id;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await requestJson('/api/admin/users', { baseUrl, session });
      setUsers(data.users);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    setFormError(null);
    if (!form.loginId || !form.name || !form.password) {
      setFormError('아이디, 이름, 비밀번호는 필수입니다.');
      return;
    }
    const pwError = validatePassword(form.password);
    if (pwError) {
      setFormError(pwError);
      return;
    }
    setCreating(true);
    try {
      await requestJson('/api/admin/users', { baseUrl, method: 'POST', body: form, session });
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDisableToggle = async (user) => {
    setActioning(user.id);
    setError(null);
    try {
      await requestJson(`/api/admin/users/${user.id}/${user.disabled ? 'enable' : 'disable'}`, {
        baseUrl, method: 'POST', session,
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setActioning(null);
    }
  };

  const handleResetPassword = async () => {
    setResetError(null);
    const pwError = validatePassword(resetPw);
    if (pwError) {
      setResetError(pwError);
      return;
    }
    try {
      await requestJson(`/api/admin/users/${resetTarget}/reset-password`, {
        baseUrl, method: 'POST', body: { password: resetPw }, session,
      });
      setResetTarget(null);
      setResetPw('');
    } catch (e) {
      setResetError(e.message);
    }
  };

  return (
    <div className="admin-tab-content">
      <div className="admin-create-form">
        <div className="admin-create-form-title">새 계정 생성</div>
        <div className="admin-create-form-row">
          <input placeholder="로그인 아이디" value={form.loginId}
            onChange={e => setForm(f => ({ ...f, loginId: e.target.value }))} />
          <input placeholder="이름" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="doctor">의사</option>
            <option value="nurse">간호사</option>
            <option value="staff">직원</option>
            <option value="admin">관리자</option>
          </select>
          <input type="password" placeholder="임시 비밀번호 (10자+, 숫자·특수문자 포함)" value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && handleCreate()} />
          <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={creating}>
            {creating ? '생성 중…' : '생성'}
          </button>
        </div>
        {formError && <div className="admin-error">{formError}</div>}
      </div>

      {error && <div className="admin-error">{error}</div>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>이름</th><th>아이디</th><th>역할</th><th>상태</th>
              <th>가입일</th><th>마지막 로그인</th><th>액션</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className={u.disabled ? 'admin-row--disabled' : ''}>
                <td>
                  {u.name}
                  {u.mustChangePassword && (
                    <span className="admin-badge admin-badge--warn" title="비밀번호 변경 필요"> !</span>
                  )}
                </td>
                <td className="admin-cell-mono">{u.loginId}</td>
                <td><RoleBadge role={u.role} /></td>
                <td>
                  {u.disabled
                    ? <span className="admin-badge admin-badge--fallback">비활성</span>
                    : <span className="admin-badge admin-badge--connected">활성</span>}
                </td>
                <td>{fmt(u.createdAt)}</td>
                <td>{fmt(u.lastLoginAt)}</td>
                <td className="admin-actions-cell">
                  <button className="btn btn-secondary btn-sm"
                    onClick={() => { setResetTarget(u.id); setResetPw(''); setResetError(null); }}>
                    비밀번호 초기화
                  </button>
                  <button
                    className={`btn btn-sm ${u.disabled ? 'btn-secondary' : 'btn-danger'}`}
                    disabled={actioning === u.id || u.id === selfId}
                    title={u.id === selfId ? '자신의 계정은 비활성화할 수 없습니다' : ''}
                    onClick={() => handleDisableToggle(u)}
                  >
                    {u.disabled ? '활성화' : '비활성화'}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td colSpan={7} className="admin-empty">등록된 사용자가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {resetTarget && (
        <div className="admin-inline-modal-backdrop" onClick={() => setResetTarget(null)}>
          <div className="admin-inline-modal" onClick={e => e.stopPropagation()}>
            <div className="admin-inline-modal-title">비밀번호 초기화</div>
            <input
              type="password"
              placeholder="새 임시 비밀번호 (10자+, 숫자·특수문자 포함)"
              value={resetPw}
              onChange={e => setResetPw(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleResetPassword()}
              autoFocus
            />
            {resetError && <div className="admin-error">{resetError}</div>}
            <div className="admin-inline-modal-actions">
              <button className="btn btn-secondary btn-sm"
                onClick={() => { setResetTarget(null); setResetPw(''); setResetError(null); }}>취소</button>
              <button className="btn btn-primary btn-sm" onClick={handleResetPassword}>초기화</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'audit',   label: '감사 로그' },
  { id: 'devices', label: '디바이스' },
  { id: 'users',   label: '사용자 관리' },
];

export function AdminConsoleModal({ session, onClose }) {
  const [activeTab, setActiveTab] = useState('audit');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>관리자 콘솔</h2>
            <p className="modal-section-description">감사 로그, 디바이스, 계정을 관리합니다.</p>
          </div>
        </div>

        <div className="admin-tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`admin-tab-btn${activeTab === t.id ? ' admin-tab-btn--active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'audit'   && <AuditTab   session={session} />}
        {activeTab === 'devices' && <DevicesTab session={session} />}
        {activeTab === 'users'   && <UsersTab   session={session} />}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

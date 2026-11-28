// 관리자 콘솔 — 사용자 관리 탭. P2-82a에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { useLatestGuard } from '../../hooks/useLatestGuard';
import { createAdminUser, fetchAdminUsers, postUserStatus, resetUserPassword } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import { validatePassword, RoleBadge, fmt } from './shared';
import type { TabProps, UserRow, UsersResponse } from './shared';

// ── Users Tab ─────────────────────────────────────────────────────────────────
const EMPTY_FORM = { loginId: '', name: '', role: 'doctor', password: '' };

export function UsersTab({ session }: TabProps) {
  const [users, setUsers]                   = useState<UserRow[]>([]);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [form, setForm]                     = useState(EMPTY_FORM);
  const [formError, setFormError]           = useState<string | null>(null);
  const [creating, setCreating]             = useState(false);
  const [actioning, setActioning]           = useState<string | null>(null);
  const [resetTarget, setResetTarget]       = useState<string | null>(null);
  const [resetPw, setResetPw]               = useState('');
  const [resetError, setResetError]         = useState<string | null>(null);
  const beginLoad = useLatestGuard();
  const baseUrl = resolveApiBaseUrl({ session });
  const selfId  = session?.user?.id;

  const load = async () => {
    const isLatest = beginLoad();
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminUsers({ baseUrl, session }) as UsersResponse;
      if (!isLatest()) return;
      setUsers(data.users);
    } catch (e) {
      if (isLatest()) setError((e as Error).message);
    } finally {
      if (isLatest()) setLoading(false);
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
      await createAdminUser({ baseUrl, session }, form);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDisableToggle = async (user: UserRow) => {
    setActioning(user.id);
    setError(null);
    try {
      await postUserStatus({ baseUrl, session }, user.id, user.disabled ? 'enable' : 'disable');
      await load();
    } catch (e) {
      setError((e as Error).message);
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
      await resetUserPassword({ baseUrl, session }, resetTarget as string, resetPw);
      setResetTarget(null);
      setResetPw('');
    } catch (e) {
      setResetError((e as Error).message);
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
          <input type="password" maxLength={128} placeholder="임시 비밀번호 (10자+, 숫자·특수문자 포함)" value={form.password}
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
              maxLength={128}
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

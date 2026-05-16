import { useEffect, useRef, useState } from 'react';
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

// ── Signup Requests Tab ───────────────────────────────────────────────────────
function SignupRequestsTab({ session }) {
  const [items, setItems]               = useState([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState(null);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [approvalResult, setApprovalResult] = useState(null);
  const baseUrl = session?.apiBaseUrl || '';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: statusFilter });
      const data = await requestJson(`/api/admin/signup-requests?${params}`, { baseUrl, session });
      setItems(data.requests);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const handleApprove = async (id) => {
    try {
      const data = await requestJson(`/api/admin/signup-requests/${id}/approve`, {
        baseUrl, session, method: 'POST',
      });
      setApprovalResult(data);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleReject = async (id) => {
    if (!confirm('이 신청을 거절하시겠습니까?')) return;
    try {
      await requestJson(`/api/admin/signup-requests/${id}/reject`, {
        baseUrl, session, method: 'POST',
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="admin-tab-content">
      <div className="admin-filter-row">
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="pending">대기 중</option>
          <option value="approved">승인됨</option>
          <option value="rejected">거절됨</option>
        </select>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>새로 고침</button>
      </div>

      {approvalResult && (
        <div className="signup-approval-result">
          <strong>승인 완료</strong>: {approvalResult.name} ({approvalResult.loginId})<br />
          임시 비밀번호:{' '}
          <code className="signup-temp-pw">{approvalResult.tempPassword}</code>
          <button
            className="btn btn-secondary"
            style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}
            onClick={() => navigator.clipboard?.writeText(approvalResult.tempPassword)}
          >
            복사
          </button>
          <button
            className="btn"
            style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}
            onClick={() => setApprovalResult(null)}
          >
            닫기
          </button>
        </div>
      )}

      {error && <p className="admin-error">{error}</p>}

      {loading ? (
        <p className="admin-empty">불러오는 중…</p>
      ) : items.length === 0 ? (
        <p className="admin-empty">신청 내역이 없습니다.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>아이디</th>
                <th>이름</th>
                <th>직종</th>
                <th>메모</th>
                <th>신청일</th>
                <th>검토자</th>
                {statusFilter === 'pending' && <th>작업</th>}
              </tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={r.id}>
                  <td>{r.loginId}</td>
                  <td>{r.name}</td>
                  <td><RoleBadge role={r.requestedRole} /></td>
                  <td>{r.note || '-'}</td>
                  <td>{fmt(r.createdAt)}</td>
                  <td>{r.reviewerName || '-'}</td>
                  {statusFilter === 'pending' && (
                    <td className="admin-actions-cell">
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: '0.8rem' }}
                        onClick={() => handleApprove(r.id)}
                      >
                        승인
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '0.8rem' }}
                        onClick={() => handleReject(r.id)}
                      >
                        거절
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Patient Assignment Tab ────────────────────────────────────────────────────
function PatientAssignmentTab({ session, onPatientAssignmentChanged }) {
  const [doctors, setDoctors]     = useState([]);
  const [patients, setPatients]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [pending, setPending]     = useState({}); // { patientId: userId | '' }
  const [actioning, setActioning] = useState(null);
  const [search, setSearch]       = useState('');
  const controllerRef             = useRef(null);
  const baseUrl = session?.apiBaseUrl || '';

  // Load doctors once on mount.
  useEffect(() => {
    requestJson('/api/admin/users', { baseUrl, session })
      .then(data => setDoctors((data.users || []).filter(u => u.role === 'doctor' && !u.disabled)))
      .catch(err => setError(err.message));
    return () => { controllerRef.current?.abort(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Unified offset loop for both full-load and search.
  // Aborts any in-flight request before starting a new one (race condition guard).
  const loadPatients = async (q) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;

    setLoading(true);
    setError(null);
    try {
      const LIMIT = 100;
      const qParam = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : '';
      let all = [];
      let offset = 0;
      while (true) {
        const data = await requestJson(
          `/api/patients?scope=all&limit=${LIMIT}&offset=${offset}${qParam}`,
          { baseUrl, session, signal }
        );
        all = [...all, ...(data.items || [])];
        if (all.length >= (data.total ?? 0)) break;
        offset += LIMIT;
      }
      setPatients(all);
      setPending({});
    } catch (err) {
      if (signal.aborted) return; // stale request superseded by a newer one
      setError(err.message);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  };

  // Initial full load; re-runs with debounce when search changes.
  useEffect(() => {
    if (!search.trim()) {
      loadPatients('');
      return;
    }
    const timer = setTimeout(() => loadPatients(search), 400);
    return () => { clearTimeout(timer); controllerRef.current?.abort(); };
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAssign = async (patientId) => {
    const selectedVal  = pending[patientId];
    const assignedUserId = selectedVal === '' ? null : (selectedVal ?? null);
    setActioning(patientId);
    try {
      await requestJson(`/api/patients/${patientId}/assignment`, {
        baseUrl, session, method: 'POST', body: { assignedUserId },
      });
      onPatientAssignmentChanged?.();
      await loadPatients(search);
    } catch (err) {
      setError(err.message);
      setActioning(null);
    }
  };

  return (
    <div className="admin-tab-content">
      <div className="admin-filter-row">
        <input
          type="text"
          placeholder="환자명 또는 등록번호 검색 (서버 검색)"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button className="btn btn-secondary" onClick={() => loadPatients(search)} disabled={loading}>새로 고침</button>
      </div>

      {error && <p className="admin-error">{error}</p>}

      {loading ? (
        <p className="admin-empty">불러오는 중…</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>환자명</th><th>등록번호</th><th>현재 담당의</th><th>배정 변경</th><th></th>
              </tr>
            </thead>
            <tbody>
              {patients.map(p => {
                const shared     = p.data?.shared || {};
                const currentId  = p.assignedDoctorUserId ?? null;
                const selectedVal = pending[p.id] !== undefined ? pending[p.id] : (currentId ?? '');
                const hasChange  = selectedVal !== (currentId ?? '');
                return (
                  <tr key={p.id}>
                    <td>{shared.name || '-'}</td>
                    <td className="admin-cell-mono">{shared.patientNo || '-'}</td>
                    <td>
                      {currentId === null
                        ? <span className="admin-badge admin-badge--warn">미배정</span>
                        : (shared.doctorName || '-')}
                    </td>
                    <td>
                      <select
                        value={selectedVal}
                        onChange={e => setPending(prev => ({ ...prev, [p.id]: e.target.value }))}
                      >
                        <option value="">미배정</option>
                        {doctors.map(d => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="admin-actions-cell">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!hasChange || actioning === p.id}
                        onClick={() => handleAssign(p.id)}
                      >
                        변경
                      </button>
                    </td>
                  </tr>
                );
              })}
              {patients.length === 0 && (
                <tr><td colSpan={5} className="admin-empty">{search.trim() ? '검색 결과가 없습니다.' : '환자가 없습니다.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Ops Status Tab ────────────────────────────────────────────────────────────
const OPS_SUMMARY_LABELS = {
  ok:                 '정상',
  stale:              '백업 지연',
  alert_open:         '장애 미처리',
  stale_and_alert:    '백업 지연 + 장애 미처리',
  dry_run_alert_open: '검증 알림 (정상)',
};

function OpsTab({ session }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);
  const [acting, setActing] = useState(null); // runId currently being ack/resolved
  const baseUrl = session?.apiBaseUrl || '';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await requestJson('/api/admin/ops/backup-status', { baseUrl, session });
      setData(result);
    } catch (e) {
      setError(e.message || '불러오기 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAck = async (runId) => {
    setActing(runId);
    try {
      await requestJson(`/api/admin/ops/backup-alerts/${runId}/ack`, { baseUrl, session, method: 'POST' });
      await load();
    } catch (e) {
      setError(e.message || '확인 처리 실패');
    } finally {
      setActing(null);
    }
  };

  const handleResolve = async (runId) => {
    setActing(runId);
    try {
      await requestJson(`/api/admin/ops/backup-alerts/${runId}/resolve`, { baseUrl, session, method: 'POST' });
      await load();
    } catch (e) {
      setError(e.message || '해결 처리 실패');
    } finally {
      setActing(null);
    }
  };

  const report = data?.monitorReport;
  const backup = data?.backupStatus;

  return (
    <div className="admin-tab-content">
      <div className="admin-list-header">
        <span style={{ fontWeight: 600 }}>백업 운영 상태</span>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>

      {error && <div className="admin-error">{error}</div>}

      {!data && !loading && !error && (
        <div className="admin-empty">백업 모니터 데이터를 아직 불러오지 못했습니다.</div>
      )}

      {report && (
        <>
          <table className="admin-table" style={{ marginTop: '0.5rem' }}>
            <tbody>
              <tr><td>모니터 체크 시각</td><td>{fmt(report.checkedAt)}</td></tr>
              <tr><td>요약 상태</td><td>{OPS_SUMMARY_LABELS[report.summary] ?? report.summary}</td></tr>
              <tr><td>백업 지연 여부</td><td>{report.isStale ? `지연 (기준: ${report.staleThresholdHours}h)` : '정상'}</td></tr>
              <tr><td>마지막 성공 시각</td><td>{fmt(report.lastSuccessAt)}</td></tr>
            </tbody>
          </table>

          {backup && (
            <table className="admin-table" style={{ marginTop: '0.75rem' }}>
              <tbody>
                <tr><td>최근 실행 상태</td><td>{backup.status}</td></tr>
                <tr><td>최근 실행 ID</td><td>{backup.runId ?? '-'}</td></tr>
                <tr><td>마지막 실패</td><td>{fmt(backup.lastFailureAt)}</td></tr>
                <tr><td>실패 원인</td><td>{backup.reasonClass ?? '-'}</td></tr>
              </tbody>
            </table>
          )}

          {report.openAlerts.length === 0 ? (
            <div className="admin-empty" style={{ marginTop: '1rem' }}>미처리 알림 없음</div>
          ) : (
            <div style={{ marginTop: '1rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
                미처리 알림 ({report.openAlerts.length}건)
              </div>
              {report.openAlerts.map(alert => (
                <div key={alert.runId} className="admin-card" style={{ marginBottom: '0.5rem' }}>
                  <table className="admin-table">
                    <tbody>
                      <tr><td>실행 ID</td><td>{alert.runId}</td></tr>
                      <tr><td>원인</td><td>{alert.reasonClass}</td></tr>
                      <tr><td>발생 시각</td><td>{fmt(alert.createdAt)}</td></tr>
                      <tr><td>종류</td><td>{alert.dryRun ? '검증(DryRun)' : '실제 장애'}</td></tr>
                    </tbody>
                  </table>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleAck(alert.runId)}
                      disabled={acting === alert.runId}
                    >
                      확인
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleResolve(alert.runId)}
                      disabled={acting === alert.runId}
                    >
                      해결 완료
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'audit',      label: '감사 로그' },
  { id: 'devices',    label: '디바이스' },
  { id: 'users',      label: '사용자 관리' },
  { id: 'requests',   label: '가입 요청' },
  { id: 'assignment', label: '환자 배정' },
  { id: 'ops',        label: '운영 상태' },
];

export function AdminConsoleModal({ session, onClose, onPatientAssignmentChanged }) {
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

        {activeTab === 'audit'      && <AuditTab              session={session} />}
        {activeTab === 'devices'    && <DevicesTab            session={session} />}
        {activeTab === 'users'      && <UsersTab              session={session} />}
        {activeTab === 'requests'   && <SignupRequestsTab     session={session} />}
        {activeTab === 'assignment' && <PatientAssignmentTab  session={session} onPatientAssignmentChanged={onPatientAssignmentChanged} />}
        {activeTab === 'ops'        && <OpsTab                session={session} />}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

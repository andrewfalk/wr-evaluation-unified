const ROLE_LABELS = { admin: '관리자', doctor: '의사', nurse: '간호사', staff: '직원' };

const SYNC_STATUS_LABELS = {
  idle:    '대기',
  syncing: '동기화 중',
  ok:      '정상',
  error:   '오류',
};

function Row({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <tr>
      <th>{label}</th>
      <td>{value}</td>
    </tr>
  );
}

export function AccountProfileModal({
  session,
  settings,
  syncState,
  onClose,
  onLogout,
  onChangePassword,
  onShowAdminConsole,
}) {
  const user        = session?.user ?? {};
  const name        = user.name || user.displayName || '(없음)';
  const role        = ROLE_LABELS[user.role] || user.role || '(없음)';
  const serverUrl   = session?.apiBaseUrl || settings?.apiBaseUrl || '(없음)';
  const isIntranet  = session?.mode === 'intranet';
  const authStatus  = isIntranet ? '인트라넷 로그인' : '로컬 모드';
  const mustChange  = user.mustChangePassword ? '비밀번호 변경 필요' : null;
  const lastSynced  = syncState?.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toLocaleString('ko-KR')
    : null;
  const syncStatus  = SYNC_STATUS_LABELS[syncState?.status] || syncState?.status || null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}>내 계정</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
        </div>

        {mustChange && (
          <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
            {mustChange}
          </div>
        )}

        <table className="info-table" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.5rem' }}>
          <tbody>
            <Row label="이름"          value={name} />
            <Row label="역할"          value={role} />
            <Row label="인증 상태"     value={authStatus} />
            <Row label="사용자 ID"     value={user.id} />
            <Row label="조직 ID"       value={user.organizationId} />
            <Row label="서버 주소"     value={serverUrl} />
            <Row label="동기화 상태"   value={syncStatus} />
            <Row label="마지막 동기화" value={lastSynced} />
            {syncState?.lastError && (
              <tr>
                <th>동기화 오류</th>
                <td style={{ color: 'var(--color-danger, #c00)' }}>{syncState.lastError}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {user.role === 'admin' && (
            <button className="btn btn-secondary btn-sm" onClick={onShowAdminConsole}>관리자 콘솔</button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={onChangePassword}>비밀번호 변경</button>
          <button className="btn btn-danger btn-sm" onClick={onLogout}>로그아웃</button>
        </div>
      </div>
    </div>
  );
}

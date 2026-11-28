// 관리자 콘솔 — 통계 권한 탭. P2-82b에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { useLatestGuard } from '../../hooks/useLatestGuard';
import { createCapabilityGrant, fetchAdminUsers, fetchCapabilityCatalog, fetchCapabilityGrants, revokeCapabilityGrant } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import { fmt } from './shared';
import type { TabProps, UserRow } from './shared';

// ── Capabilities Tab (PR0-A) ─────────────────────────────────────────────────
// 통계 워크벤치 권한(capability) 부여/회수. default_all_roles인 capability는 목록에
// 나오지만 grant 없이도 모든 사용자가 통과하므로 부여 폼에서는 안내만 하고 막지 않는다
// — 서버가 최종 판정을 하고, 여기선 grant가 필요한 capability 운용을 돕는 용도.
function GrantStatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = { active: ['connected', '활성'], expired: ['fallback', '만료'], revoked: ['local', '회수됨'] };
  const [tone, label] = map[status] ?? ['local', status];
  return <span className={`admin-badge admin-badge--${tone}`}>{label}</span>;
}

const EMPTY_GRANT_FORM = { userId: '', capability: '', reason: '', expiresAt: '' };

interface CapabilityEntry {
  key: string;
  label: string;
}

interface GrantRow {
  id: string;
  userName: string;
  capability: string;
  status: string;
  grantedByName?: string | null;
  reason: string;
  expiresAt: string | null;
}

export function CapabilitiesTab({ session }: TabProps) {
  const [catalog, setCatalog]         = useState<CapabilityEntry[]>([]);
  const [grants, setGrants]           = useState<GrantRow[]>([]);
  const [users, setUsers]             = useState<UserRow[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [status, setStatus]           = useState<string | null>(null);
  const [form, setForm]               = useState(EMPTY_GRANT_FORM);
  const [formError, setFormError]     = useState<string | null>(null);
  const [creating, setCreating]       = useState(false);
  const [actioning, setActioning]     = useState<string | null>(null);
  const beginLoad = useLatestGuard();
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    const isLatest = beginLoad();
    setLoading(true);
    setError(null);
    try {
      const [catalogData, grantsData, usersData] = await Promise.all([
        fetchCapabilityCatalog({ baseUrl, session }),
        fetchCapabilityGrants({ baseUrl, session }),
        fetchAdminUsers({ baseUrl, session }),
      ]) as [{ capabilities?: CapabilityEntry[] }, { grants?: GrantRow[] }, { users?: UserRow[] }];
      if (!isLatest()) return;
      setCatalog(catalogData.capabilities || []);
      setGrants(grantsData.grants || []);
      setUsers(usersData.users || []);
    } catch (e) {
      if (isLatest()) setError((e as Error).message);
    } finally {
      if (isLatest()) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const capabilityLabel = (key: string) => catalog.find(c => c.key === key)?.label ?? key;

  const handleCreate = async () => {
    setFormError(null);
    setStatus(null);
    if (!form.userId || !form.capability || !form.reason.trim()) {
      setFormError('사용자, 권한, 사유는 필수입니다.');
      return;
    }
    setCreating(true);
    try {
      await createCapabilityGrant({ baseUrl, session }, {
        userId:     form.userId,
        capability: form.capability,
        reason:     form.reason.trim(),
        ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
      });
      setForm(EMPTY_GRANT_FORM);
      setStatus('권한을 부여했습니다.');
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (grant: GrantRow) => {
    setActioning(grant.id);
    setError(null);
    try {
      await revokeCapabilityGrant({ baseUrl, session }, grant.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActioning(null);
    }
  };

  return (
    <div className="admin-tab-content">
      <div className="admin-form-row">
        <select value={form.userId} onChange={e => setForm(f => ({ ...f, userId: e.target.value }))}>
          <option value="">사용자 선택</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.loginId})</option>)}
        </select>
        <select value={form.capability} onChange={e => setForm(f => ({ ...f, capability: e.target.value }))}>
          <option value="">권한 선택</option>
          {catalog.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <input
          className="admin-search"
          placeholder="부여 사유(필수)"
          value={form.reason}
          onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
        />
        <input
          type="date"
          value={form.expiresAt}
          onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
          title="만료일(선택, 비워두면 무기한)"
        />
        <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={creating}>
          {creating ? '부여 중…' : '부여'}
        </button>
        <span className="admin-toolbar-spacer" />
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>새로 고침</button>
      </div>

      {formError && <div className="admin-error">{formError}</div>}
      {status && <div className="admin-status">{status}</div>}
      {error && <div className="admin-error">{error}</div>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>사용자</th><th>권한</th><th>상태</th><th>부여자</th>
              <th>사유</th><th>만료일</th><th>액션</th>
            </tr>
          </thead>
          <tbody>
            {grants.map(g => (
              <tr key={g.id}>
                <td>{g.userName}</td>
                <td>{capabilityLabel(g.capability)}</td>
                <td><GrantStatusBadge status={g.status} /></td>
                <td>{g.grantedByName || '-'}</td>
                <td>{g.reason}</td>
                <td>{fmt(g.expiresAt)}</td>
                <td className="admin-actions-cell">
                  {g.status === 'active' && (
                    <button className="btn btn-danger btn-sm" disabled={actioning === g.id}
                      onClick={() => handleRevoke(g)}>회수</button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && grants.length === 0 && (
              <tr><td colSpan={7} className="admin-empty">부여된 권한이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 관리자 콘솔 — 프리셋 공유 탭. P2-82b에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { useLatestGuard } from '../../hooks/useLatestGuard';
import { fetchAdminPresets, postPresetVisibility } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import type { TabProps } from './shared';

// ── Preset Sharing Tab ──────────────────────────────────────────────────────
// Org-wide preset visibility manager. Admin can select presets (incl. other
// users' private ones) and bulk-convert visibility either direction.
function PresetVisibilityBadge({ visibility }: { visibility: string }) {
  return visibility === 'organization'
    ? <span className="admin-badge admin-badge--connected">조직 공유</span>
    : <span className="admin-badge admin-badge--fallback">비공개(소유자만)</span>;
}

interface PresetRow {
  id: string;
  jobName?: string | null;
  category?: string | null;
  ownerName?: string | null;
  organizationId?: string | null;
  visibility: string;
}

export function PresetsTab({ session }: TabProps) {
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [status, setStatus]   = useState<string | null>(null);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [search, setSearch]   = useState('');
  const [visFilter, setVisFilter] = useState('all');
  const [pending, setPending] = useState<string | null>(null);   // 'organization' | 'private' awaiting confirm
  const [acting, setActing]   = useState(false);
  const beginLoad = useLatestGuard();
  const baseUrl = resolveApiBaseUrl({ session });
  // Superadmin (no org bound) sees presets across all orgs → show org column.
  const isSuperadmin = !session?.user?.organizationId;

  const load = async () => {
    const isLatest = beginLoad();
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setPending(null);
    try {
      const data = await fetchAdminPresets({ baseUrl, session }) as { presets?: PresetRow[] };
      if (!isLatest()) return;
      setPresets(data.presets || []);
    } catch (e) {
      if (isLatest()) setError((e as Error).message);
    } finally {
      if (isLatest()) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter changes must reset selection — otherwise a preset selected under a
  // previous filter (now hidden) could be converted unseen.
  const onSearch    = (v: string) => { setSearch(v);    setSelected(new Set()); setPending(null); };
  const onVisFilter = (v: string) => { setVisFilter(v); setSelected(new Set()); setPending(null); };

  const filtered = presets.filter(p => {
    if (visFilter !== 'all' && p.visibility !== visFilter) return false;
    if (search && !String(p.jobName || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const allSelected = filtered.length > 0 && filtered.every(p => selected.has(p.id));

  const toggleOne = (id: string) => {
    setPending(null);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setPending(null);
    setSelected(prev => {
      const next = new Set(prev);
      if (filtered.length > 0 && filtered.every(p => next.has(p.id))) {
        filtered.forEach(p => next.delete(p.id));
      } else {
        filtered.forEach(p => next.add(p.id));
      }
      return next;
    });
  };

  const arm = (visibility: string) => { setError(null); setStatus(null); setPending(visibility); };

  const confirmConvert = async () => {
    const ids = [...selected];
    if (ids.length === 0 || !pending) return;
    setActing(true);
    setError(null);
    try {
      const data = await postPresetVisibility({ baseUrl, session }, ids, pending) as { requested: number; updated: number };
      const label = pending === 'organization' ? '조직 공유' : '비공개(소유자만)';
      setStatus(`선택 ${data.requested}개 중 ${data.updated}개를 ${label}로 전환했습니다.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  };

  const pendingLabel = pending === 'organization' ? '조직 공유' : '비공개(소유자만)';
  const colCount = isSuperadmin ? 6 : 5;

  return (
    <div className="admin-tab-content">
      <div className="admin-toolbar">
        <input
          className="admin-search"
          placeholder="직종명 검색"
          value={search}
          onChange={e => onSearch(e.target.value)}
        />
        <select value={visFilter} onChange={e => onVisFilter(e.target.value)}>
          <option value="all">전체</option>
          <option value="organization">조직 공유</option>
          <option value="private">비공개(소유자만)</option>
        </select>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>새로 고침</button>
        <span className="admin-toolbar-spacer" />
        <button className="btn btn-primary btn-sm" disabled={selected.size === 0 || acting}
          onClick={() => arm('organization')}>선택 → 조직 공유</button>
        <button className="btn btn-secondary btn-sm" disabled={selected.size === 0 || acting}
          onClick={() => arm('private')}>선택 → 비공개(소유자만)</button>
      </div>

      {pending && (
        <div className="admin-confirm-bar">
          선택한 {selected.size}개 프리셋을 <strong>{pendingLabel}</strong>로 전환합니다.
          <button className="btn btn-primary btn-sm" onClick={confirmConvert} disabled={acting}>
            {acting ? '전환 중…' : '확인'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setPending(null)} disabled={acting}>취소</button>
        </div>
      )}

      {status && <div className="admin-status">{status}</div>}
      {error && <div className="admin-error">{error}</div>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th><input type="checkbox" checked={allSelected} onChange={toggleAll}
                aria-label="전체 선택" disabled={filtered.length === 0} /></th>
              <th>직종명</th><th>카테고리</th><th>소유자</th>
              {isSuperadmin && <th>조직</th>}
              <th>공개 범위</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => (
              <tr key={p.id}>
                <td><input type="checkbox" checked={selected.has(p.id)}
                  onChange={() => toggleOne(p.id)} aria-label={`${p.jobName} 선택`} /></td>
                <td>{p.jobName}</td>
                <td>{p.category}</td>
                <td>{p.ownerName || '-'}</td>
                {isSuperadmin && <td className="admin-cell-mono">{p.organizationId || '-'}</td>}
                <td><PresetVisibilityBadge visibility={p.visibility} /></td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={colCount} className="admin-empty">표시할 프리셋이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

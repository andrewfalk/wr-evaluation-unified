// 관리자 콘솔 — 감사 로그 탭. P2-82a에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { fetchAuditLog } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import { emrAuditNote } from '../adminAuditNotes';
import { fmt } from './shared';
import type { TabProps } from './shared';

// ── Audit Log Tab ─────────────────────────────────────────────────────────────
// EMR 기록의 비고: 설치본이 알린 발생 시각과 서버 표시(옛 설치본·행위자 불확실/미검증·몰아서 전송·기관 미확정).
function EmrAuditNoteCell({ item }: { item: AuditRow }) {
  const note = emrAuditNote(item);
  if (!note || (!note.occurredAt && note.flags.length === 0)) return '-';
  return (
    <>
      {note.occurredAt && <div className="admin-cell-hint">발생 {fmt(note.occurredAt)}</div>}
      {note.flags.map(flag => (
        <span key={flag} className="admin-badge admin-badge--warn">{flag}</span>
      ))}
    </>
  );
}

interface AuditRow {
  id: string;
  createdAt: string | null;
  actorUserId?: string | null;
  action: string;
  outcome: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  extra?: unknown;
}

interface AuditPage {
  items: AuditRow[];
  total: number;
}

export function AuditTab({ session }: TabProps) {
  const [items, setItems]                   = useState<AuditRow[]>([]);
  const [total, setTotal]                   = useState(0);
  const [page, setPage]                     = useState(1);
  const [limit, setLimit]                   = useState(50);
  const [actionFilter, setActionFilter]     = useState('');
  const [targetFilter, setTargetFilter]     = useState('');
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async (p = 1) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(limit) });
      if (actionFilter) params.set('action', actionFilter);
      if (targetFilter) params.set('targetType', targetFilter);
      const data = await fetchAuditLog({ baseUrl, session }, params) as AuditPage;
      setItems(data.items);
      setTotal(data.total);
      setPage(p);
    } catch (e) {
      setError((e as Error).message);
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
              <th>대상</th><th>비고</th><th>IP</th>
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
                <td><EmrAuditNoteCell item={item} /></td>
                <td className="admin-cell-mono">{item.ip ?? '-'}</td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr><td colSpan={7} className="admin-empty">감사 로그가 없습니다.</td></tr>
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

// 관리자 콘솔 — 가입 요청 탭. P2-82a에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { approveSignupRequest, fetchSignupRequests, rejectSignupRequest } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import { RoleBadge, fmt } from './shared';
import type { TabProps } from './shared';

// ── Signup Requests Tab ───────────────────────────────────────────────────────
interface SignupRow {
  id: string;
  loginId: string;
  name: string;
  requestedRole: string;
  note?: string | null;
  createdAt: string | null;
  reviewerName?: string | null;
}

interface ApprovalResult {
  name: string;
  loginId: string;
  tempPassword: string;
}

export function SignupRequestsTab({ session }: TabProps) {
  const [items, setItems]               = useState<SignupRow[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [approvalResult, setApprovalResult] = useState<ApprovalResult | null>(null);
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: statusFilter });
      const data = await fetchSignupRequests({ baseUrl, session }, params) as { requests: SignupRow[] };
      setItems(data.requests);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const handleApprove = async (id: string) => {
    try {
      const data = await approveSignupRequest({ baseUrl, session }, id) as ApprovalResult;
      setApprovalResult(data);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReject = async (id: string) => {
    if (!confirm('이 신청을 거절하시겠습니까?')) return;
    try {
      await rejectSignupRequest({ baseUrl, session }, id);
      load();
    } catch (err) {
      setError((err as Error).message);
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

// 관리자 콘솔 — 운영 상태 탭. P2-82b에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { useLatestGuard } from '../../hooks/useLatestGuard';
import { ackBackupAlert, fetchBackupStatus, resolveBackupAlert } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import { fmt } from './shared';
import type { TabProps } from './shared';

// ── Ops Status Tab ────────────────────────────────────────────────────────────
const OPS_SUMMARY_LABELS: Record<string, string> = {
  ok:                 '정상',
  stale:              '백업 지연',
  alert_open:         '장애 미처리',
  stale_and_alert:    '백업 지연 + 장애 미처리',
  dry_run_alert_open: '검증 알림 (정상)',
};

interface OpsAlert {
  runId: string;
  reasonClass: string;
  createdAt: string | null;
  dryRun?: boolean;
}

interface OpsStatus {
  monitorReport?: {
    checkedAt: string | null;
    summary: string;
    isStale?: boolean;
    staleThresholdHours?: number;
    lastSuccessAt: string | null;
    openAlerts: OpsAlert[];
  } | null;
  backupStatus?: {
    status: string;
    runId?: string | null;
    lastFailureAt: string | null;
    reasonClass?: string | null;
  } | null;
}

interface OpsTabProps extends TabProps {
  onOpsStatusChanged?: () => void;
}

export function OpsTab({ session, onOpsStatusChanged }: OpsTabProps) {
  const [data, setData]     = useState<OpsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null); // runId currently being ack/resolved
  const beginLoad = useLatestGuard();
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    const isLatest = beginLoad();
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBackupStatus({ baseUrl, session }) as OpsStatus | null;
      if (!isLatest()) return;
      setData(result);
    } catch (e) {
      if (isLatest()) setError((e as Error).message || '불러오기 실패');
    } finally {
      if (isLatest()) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAck = async (runId: string) => {
    setActing(runId);
    try {
      await ackBackupAlert({ baseUrl, session }, runId);
      onOpsStatusChanged?.();
      await load();
    } catch (e) {
      setError((e as Error).message || '확인 처리 실패');
    } finally {
      setActing(null);
    }
  };

  const handleResolve = async (runId: string) => {
    setActing(runId);
    try {
      await resolveBackupAlert({ baseUrl, session }, runId);
      onOpsStatusChanged?.();
      await load();
    } catch (e) {
      setError((e as Error).message || '해결 처리 실패');
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

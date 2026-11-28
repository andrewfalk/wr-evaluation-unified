// 관리자 콘솔 — 디바이스 탭. P2-82a에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { useLatestGuard } from '../../hooks/useLatestGuard';
import { fetchDevices, postDeviceAction } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import { deviceActionErrorMessage, devicesPerPc } from '../adminAuditNotes';
import { StatusBadge, fmt } from './shared';
import type { TabProps } from './shared';

// ── Devices Tab ───────────────────────────────────────────────────────────────
interface DeviceRow {
  id: string;
  userName: string;
  userLoginId: string;
  buildTarget: string;
  status: string;
  registeredAt: string | null;
  lastSeenAt: string | null;
  registerIp?: string | null;
  suspicious?: boolean;
  keyPrefix?: string | null;
}

export function DevicesTab({ session }: TabProps) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const beginLoad = useLatestGuard();
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    const isLatest = beginLoad();
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDevices({ baseUrl, session }) as { devices: DeviceRow[] };
      if (!isLatest()) return;
      setDevices(data.devices);
    } catch (e) {
      if (isLatest()) setError((e as Error).message);
    } finally {
      if (isLatest()) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (deviceId: string, path: string) => {
    setActioning(deviceId);
    try {
      await postDeviceAction({ baseUrl, session }, deviceId, path);
      await load();
    } catch (e) {
      setError(deviceActionErrorMessage(e as Error));
    } finally {
      setActioning(null);
    }
  };

  const pcRows = devicesPerPc(devices);

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
              <th>상태</th><th>사용자</th><th>PC</th><th>빌드</th>
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
                <td>
                  <span className="admin-cell-mono" title="장치 키 지문 앞자리 — 같은 값이면 같은 PC">{d.keyPrefix ?? '-'}</span>
                  {(pcRows.get(d.keyPrefix as string) ?? 0) > 1 && (
                    <div className="admin-cell-hint">같은 PC {pcRows.get(d.keyPrefix as string)}행</div>
                  )}
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
              <tr><td colSpan={8} className="admin-empty">등록된 디바이스가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

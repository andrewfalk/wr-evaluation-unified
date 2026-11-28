// 관리자 콘솔 — 환자 배정 탭. P2-82b에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useRef, useEffect } from 'react';
import { requestJson } from '../../services/httpClient';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import type { TabProps, UserRow, UsersResponse } from './shared';

// ── Patient Assignment Tab ────────────────────────────────────────────────────
interface PatientShared {
  name?: string;
  patientNo?: string;
  doctorName?: string;
}

interface ServerPatientRow {
  id: string;
  assignedDoctorUserId?: string | null;
  data?: { shared?: PatientShared | null } | null;
}

interface PatientsPage {
  items?: ServerPatientRow[];
  total?: number;
}

interface PatientAssignmentTabProps extends TabProps {
  onPatientAssignmentChanged?: () => unknown;
}

export function PatientAssignmentTab({ session, onPatientAssignmentChanged }: PatientAssignmentTabProps) {
  const [doctors, setDoctors]     = useState<UserRow[]>([]);
  const [patients, setServerPatients] = useState<ServerPatientRow[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [pending, setPending]     = useState<Record<string, string>>({}); // { patientId: userId | '' }
  const [actioning, setActioning] = useState<string | null>(null);
  const [search, setSearch]       = useState('');
  const controllerRef             = useRef<AbortController | null>(null);
  const baseUrl = resolveApiBaseUrl({ session });

  // Load doctors once on mount.
  useEffect(() => {
    requestJson('/api/admin/users', { baseUrl, session })
      .then((data: UsersResponse) => setDoctors((data.users || []).filter(u => u.role === 'doctor' && !u.disabled)))
      .catch(err => setError(err.message));
    return () => { controllerRef.current?.abort(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Unified offset loop for both full-load and search.
  // Aborts any in-flight request before starting a new one (race condition guard).
  const loadPatients = async (q: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;

    setLoading(true);
    setError(null);
    try {
      const LIMIT = 100;
      const qParam = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : '';
      let all: ServerPatientRow[] = [];
      let offset = 0;
      while (true) {
        const data: PatientsPage = await requestJson(
          `/api/patients?scope=all&limit=${LIMIT}&offset=${offset}${qParam}`,
          { baseUrl, session, signal }
        );
        all = [...all, ...(data.items || [])];
        if (all.length >= (data.total ?? 0)) break;
        offset += LIMIT;
      }
      setServerPatients(all);
      setPending({});
    } catch (err) {
      if (signal.aborted) return; // stale request superseded by a newer one
      setError((err as Error).message);
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

  const handleAssign = async (patientId: string) => {
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
      setError((err as Error).message);
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
                const shared: PatientShared = p.data?.shared || {};
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

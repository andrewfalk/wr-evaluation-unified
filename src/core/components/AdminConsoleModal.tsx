import { useEffect, useRef, useState } from 'react';
import { requestJson } from '../services/httpClient';
import { resolveApiBaseUrl } from '../../platform/dataMode';
import { fmt } from './admin/shared';
import type { TabProps, UserRow, UsersResponse, AdminSession } from './admin/shared';
import { AuditTab } from './admin/AuditTab';
import { DevicesTab } from './admin/DevicesTab';
import { UsersTab } from './admin/UsersTab';
import { SignupRequestsTab } from './admin/SignupRequestsTab';

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

function PatientAssignmentTab({ session, onPatientAssignmentChanged }: PatientAssignmentTabProps) {
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

function OpsTab({ session }: TabProps) {
  const [data, setData]     = useState<OpsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null); // runId currently being ack/resolved
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result: OpsStatus | null = await requestJson('/api/admin/ops/backup-status', { baseUrl, session });
      setData(result);
    } catch (e) {
      setError((e as Error).message || '불러오기 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAck = async (runId: string) => {
    setActing(runId);
    try {
      await requestJson(`/api/admin/ops/backup-alerts/${runId}/ack`, { baseUrl, session, method: 'POST' });
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
      await requestJson(`/api/admin/ops/backup-alerts/${runId}/resolve`, { baseUrl, session, method: 'POST' });
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

// ── Inference Device Tab (6.0-12) ───────────────────────────────────────────────
const DEVICE_OPTIONS = [
  { value: 'auto', label: '자동 (GPU 우선)', hint: 'GPU 사용 가능하면 GPU, 아니면 CPU로 자동 폴백(권장).' },
  { value: 'cpu',  label: 'CPU 강제',        hint: '항상 CPU로 추론.' },
  { value: 'cuda', label: 'GPU 강제 (CUDA)', hint: 'GPU(CUDA)로만 추론. 사용 불가 시 분석 실패(에러).' },
];

interface GpuStatus {
  cudaAvailable?: boolean;
  error?: string | null;
}

interface OrgSettings {
  inferenceDevice: string | null;
  gpu?: GpuStatus | null;
}

function InferenceDeviceTab({ session }: TabProps) {
  const [device, setDevice]   = useState<string | null>(null);   // 서버 저장값
  const [draft, setDraft]     = useState<string | null>(null);    // 편집값
  const [gpu, setGpu]         = useState<GpuStatus | null>(null);     // { cudaAvailable, providers, error }
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    setLoading(true);
    setError(null);
    setSavedMsg(null);
    try {
      const data: OrgSettings = await requestJson('/api/admin/org-settings', { baseUrl, session });
      setDevice(data.inferenceDevice);
      setDraft(data.inferenceDevice);
      setGpu(data.gpu || null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const data: OrgSettings = await requestJson('/api/admin/org-settings', {
        baseUrl, method: 'PATCH', body: { inferenceDevice: draft }, session,
      });
      setDevice(data.inferenceDevice);
      setDraft(data.inferenceDevice);
      setSavedMsg('저장되었습니다.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
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

      {/* 서버 GPU 감지 상태(Python probe). onnxruntime-gpu 미설치면 감지 불가. */}
      <div className="admin-cell-hint" style={{ marginBottom: 8 }}>
        {gpu == null ? 'GPU 상태 확인 중…'
          : gpu.cudaAvailable
            ? '서버 GPU: CUDA 사용 가능 ✓'
            : `서버 GPU: CUDA provider 미설치/감지 불가${gpu.error ? ` (${gpu.error})` : ''}`}
      </div>

      <fieldset style={{ border: 'none', padding: 0, margin: 0 }} disabled={loading || saving}>
        {DEVICE_OPTIONS.map(opt => (
          <label key={opt.value} style={{ display: 'block', marginBottom: 6 }}>
            <input type="radio" name="inferenceDevice" value={opt.value}
              checked={draft === opt.value}
              onChange={() => { setDraft(opt.value); setSavedMsg(null); }} />
            {' '}<b>{opt.label}</b>
            <div className="admin-cell-hint" style={{ marginLeft: 22 }}>
              {opt.hint}
              {opt.value === 'cuda' && gpu && !gpu.cudaAvailable && (
                <span style={{ color: 'var(--color-warning)' }}> — 현재 서버에서 CUDA 미감지(선택 시 분석 실패)</span>
              )}
            </div>
          </label>
        ))}
      </fieldset>

      <div style={{ marginTop: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={save}
          disabled={loading || saving || draft == null || draft === device}>
          {saving ? '저장 중…' : '저장'}
        </button>
        {savedMsg && <span className="admin-cell-hint" style={{ marginLeft: 8 }}>{savedMsg}</span>}
      </div>
    </div>
  );
}

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

function PresetsTab({ session }: TabProps) {
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [status, setStatus]   = useState<string | null>(null);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [search, setSearch]   = useState('');
  const [visFilter, setVisFilter] = useState('all');
  const [pending, setPending] = useState<string | null>(null);   // 'organization' | 'private' awaiting confirm
  const [acting, setActing]   = useState(false);
  const baseUrl = resolveApiBaseUrl({ session });
  // Superadmin (no org bound) sees presets across all orgs → show org column.
  const isSuperadmin = !session?.user?.organizationId;

  const load = async () => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setPending(null);
    try {
      const data: { presets?: PresetRow[] } = await requestJson('/api/admin/presets', { baseUrl, session });
      setPresets(data.presets || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
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
      const data: { requested: number; updated: number } = await requestJson('/api/admin/presets/visibility', {
        baseUrl, method: 'POST', session, body: { ids, visibility: pending },
      });
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

function CapabilitiesTab({ session }: TabProps) {
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
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [catalogData, grantsData, usersData]: [
        { capabilities?: CapabilityEntry[] }, { grants?: GrantRow[] }, { users?: UserRow[] },
      ] = await Promise.all([
        requestJson('/api/capabilities/catalog', { baseUrl, session }),
        requestJson('/api/capabilities/grants',  { baseUrl, session }),
        requestJson('/api/admin/users',          { baseUrl, session }),
      ]);
      setCatalog(catalogData.capabilities || []);
      setGrants(grantsData.grants || []);
      setUsers(usersData.users || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
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
      await requestJson('/api/capabilities/grants', {
        baseUrl, method: 'POST', session,
        body: {
          userId:     form.userId,
          capability: form.capability,
          reason:     form.reason.trim(),
          ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
        },
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
      await requestJson(`/api/capabilities/grants/${grant.id}/revoke`, { baseUrl, method: 'POST', session });
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

// ── Main ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'audit',      label: '감사 로그' },
  { id: 'devices',    label: '디바이스' },
  { id: 'users',      label: '사용자 관리' },
  { id: 'requests',   label: '가입 요청' },
  { id: 'presets',    label: '프리셋 공유' },
  { id: 'assignment', label: '환자 배정' },
  { id: 'inference',  label: '추론 디바이스' },
  { id: 'capabilities', label: '통계 권한' },
  { id: 'ops',        label: '운영 상태' },
];

export interface AdminConsoleModalProps {
  session: AdminSession;
  onClose: () => void;
  onPatientAssignmentChanged?: () => unknown;
}

export function AdminConsoleModal({ session, onClose, onPatientAssignmentChanged }: AdminConsoleModalProps) {
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
        {activeTab === 'presets'    && <PresetsTab            session={session} />}
        {activeTab === 'assignment' && <PatientAssignmentTab  session={session} onPatientAssignmentChanged={onPatientAssignmentChanged} />}
        {activeTab === 'inference'  && <InferenceDeviceTab    session={session} />}
        {activeTab === 'capabilities' && <CapabilitiesTab     session={session} />}
        {activeTab === 'ops'        && <OpsTab                session={session} />}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

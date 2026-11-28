// 관리자 콘솔 — 추론 디바이스 탭. P2-82b에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.
import { useState, useEffect } from 'react';
import { useLatestGuard } from '../../hooks/useLatestGuard';
import { fetchOrgSettings, patchOrgSettings } from '../../services/adminRepository';
import { resolveApiBaseUrl } from '../../../platform/dataMode';
import type { TabProps } from './shared';

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

export function InferenceDeviceTab({ session }: TabProps) {
  const [device, setDevice]   = useState<string | null>(null);   // 서버 저장값
  const [draft, setDraft]     = useState<string | null>(null);    // 편집값
  const [gpu, setGpu]         = useState<GpuStatus | null>(null);     // { cudaAvailable, providers, error }
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const beginLoad = useLatestGuard();
  const baseUrl = resolveApiBaseUrl({ session });

  const load = async () => {
    const isLatest = beginLoad();
    setLoading(true);
    setError(null);
    setSavedMsg(null);
    try {
      const data = await fetchOrgSettings({ baseUrl, session }) as OrgSettings;
      if (!isLatest()) return;
      setDevice(data.inferenceDevice);
      setDraft(data.inferenceDevice);
      setGpu(data.gpu || null);
    } catch (e) {
      if (isLatest()) setError((e as Error).message);
    } finally {
      if (isLatest()) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const data = await patchOrgSettings({ baseUrl, session }, draft) as OrgSettings;
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

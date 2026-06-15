// [공유] 영상 분석 스텝 (6.0-3, mock-first). 서버 추론 없이 로컬 mock feature로
// 공정 정리 → mock 분석 → 제안 검토 → 적용/무시 → provenance/rollback 흐름을 검증한다.
// 실제 업로드·서버 폴링은 PR5(6.0-4), 실제 추론은 M2에서 연결된다.
import { useMemo } from 'react';
import { generateMockFeatures } from '../services/videoMock';
import { aggregateProcessFeatures } from '../services/videoAggregate';
import {
  getModuleSuggestions,
  collectCandidateFeatures,
  applyFeatureToModule,
  rollbackAppliedInput,
} from '../services/videoProvenance';
import { getModule } from '../moduleRegistry';
import { VIDEO_FEATURE_TARGETS } from '@contracts/index';

const VIEWPOINTS = [
  { value: 'sagittal', label: '측면(sagittal)' },
  { value: 'frontal', label: '정면(frontal)' },
  { value: 'other', label: '기타' },
];
const PROFILES = [
  { value: 'posture-basic', label: '자세시간(5~10fps)' },
  { value: 'repetition-upper-limb', label: '상지반복(10~15fps)' },
  { value: 'hand-wrist', label: '손목·손(15~30fps)' },
];
const MOCK_BUNDLE = 'mock-6.0-2';

// ── 순수 헬퍼(테스트 대상) ────────────────────────────────────────────────
/** 활성 모듈로 매핑되는 모든 featureKey(자동·candidate 포함). */
export function requestedFeaturesForModules(activeModules = []) {
  return Object.keys(VIDEO_FEATURE_TARGETS).filter(
    (k) => activeModules.includes(VIDEO_FEATURE_TARGETS[k].moduleId)
  );
}

/** 공정별 feature를 직업(sharedJobId) 단위로 묶어 집계한다(job-scope). */
export function buildJobFeatures(processes = [], processFeatures = []) {
  const byJob = {};
  for (const pf of processFeatures) {
    const proc = processes.find((p) => p.id === pf.processId);
    if (!proc) continue;
    (byJob[proc.sharedJobId] = byJob[proc.sharedJobId] || []).push({
      share: proc.shiftSharePercent,
      features: pf.features,
    });
  }
  return Object.keys(byJob).map((sharedJobId) => ({
    sharedJobId,
    features: aggregateProcessFeatures(byJob[sharedJobId]),
  }));
}

/** 공정 시간점유율 합(직업별). 100% 초과/미달 경고용. */
export function shareTotalsByJob(processes = []) {
  const totals = {};
  for (const p of processes) {
    totals[p.sharedJobId] = (totals[p.sharedJobId] || 0) + (Number(p.shiftSharePercent) || 0);
  }
  return totals;
}

// 입력(공정/클립)이 바뀌면 mock 분석 파생결과는 stale이 되므로 비운다(잘못된 기준 적용 방지).
// 이미 모듈에 적용된 값(appliedInputs)·provenance는 보존한다.
export function clearDerived(va) {
  return { ...va, processFeatures: [], jobFeatures: [], candidateFeatures: [] };
}
export function addProcessVA(va, jobs = []) {
  return clearDerived({
    ...va,
    processes: [...va.processes, {
      id: crypto.randomUUID(),
      sharedJobId: jobs[0]?.id || '',
      name: `공정 ${va.processes.length + 1}`,
      shiftSharePercent: 0,
      analysisProfile: 'posture-basic',
    }],
  });
}
export function editProcessVA(va, id, patch) {
  return clearDerived({ ...va, processes: va.processes.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
}
export function removeProcessVA(va, id) {
  return clearDerived({
    ...va,
    processes: va.processes.filter((p) => p.id !== id),
    clips: va.clips.filter((c) => c.processId !== id),
  });
}
export function addClipVA(va, processId) {
  return clearDerived({
    ...va,
    clips: [...va.clips, { id: crypto.randomUUID(), processId, viewpoint: 'sagittal', analysisProfile: 'posture-basic' }],
  });
}
export function editClipVA(va, id, patch) {
  return clearDerived({ ...va, clips: va.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}
export function removeClipVA(va, id) {
  return clearDerived({ ...va, clips: va.clips.filter((c) => c.id !== id) });
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────
export function VideoAnalysisStep({ shared, updateShared, updatePatient, activePatient, activeModules = [], session }) {
  const va = shared?.videoAnalysis || {
    processes: [], clips: [], processFeatures: [], jobFeatures: [], candidateFeatures: [], appliedInputs: [],
  };
  const jobs = shared?.jobs || [];
  const jobName = (id) => jobs.find((j) => j.id === id)?.jobName || '(직업 미지정)';
  const appliedBy = session?.user?.name || shared?.doctorName || 'unknown';

  const jobScopeModules = activeModules.filter((m) => getModule(m)?.videoMappingConfig?.scope === 'job');
  const shareTotals = useMemo(() => shareTotalsByJob(va.processes), [va.processes]);

  const updateVA = (mutator) => updateShared({ ...shared, videoAnalysis: mutator(va) });

  // ── 공정/클립 편집 ── 입력 변경 시 파생 분석결과는 비워 stale 적용을 막는다(clearDerived).
  const addProcess = () => updateVA((v) => addProcessVA(v, jobs));
  const editProcess = (id, patch) => updateVA((v) => editProcessVA(v, id, patch));
  const removeProcess = (id) => updateVA((v) => removeProcessVA(v, id));
  const addClip = (processId) => updateVA((v) => addClipVA(v, processId));
  const editClip = (id, patch) => updateVA((v) => editClipVA(v, id, patch));
  const removeClip = (id) => updateVA((v) => removeClipVA(v, id));

  // ── mock 분석 실행 ──
  const runMockAnalysis = () => {
    const requested = requestedFeaturesForModules(activeModules);
    const processFeatures = va.processes.map((p) => ({
      processId: p.id,
      features: generateMockFeatures(requested, p.analysisProfile),
    }));
    const jobFeatures = buildJobFeatures(va.processes, processFeatures);
    const candidateFeatures = processFeatures.flatMap((pf) =>
      collectCandidateFeatures(pf.features, { processIds: [pf.processId] })
    );
    updateVA((v) => ({ ...v, processFeatures, jobFeatures, candidateFeatures }));
  };

  // ── 제안 적용 / 되돌리기 ──
  const applySuggestion = (moduleId, ctx, s, processIds) => {
    updatePatient((d) => applyFeatureToModule({ data: d }, {
      moduleId, ctx, featureKey: s.featureKey,
      suggestedValue: s.suggestedValue, confidence: s.confidence,
      processIds: processIds || [], analysisBundleVersion: MOCK_BUNDLE, appliedBy,
    }).patient.data);
  };
  const rollback = (entry) => updatePatient((d) => rollbackAppliedInput({ data: d }, d.shared.videoAnalysis.appliedInputs.indexOf(entry)).data);

  const hasAnalysis = (va.jobFeatures || []).length > 0 || (va.processFeatures || []).length > 0;

  return (
    <div className="panel">
      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">🎥</span>작업 영상 인간공학 분석 (mock)</h2>
            <p className="section-description">
              조사 서류 기반으로 공정을 정리하고 mock 분석을 실행합니다. 결과는 항상 <b>제안값</b>이며 전문의가 확정합니다.
              (서버 추론·업로드는 후속 단계에서 연결됩니다.)
            </p>
          </div>
        </div>

        {/* 1) 공정 정리 */}
        <h3>공정</h3>
        {va.processes.length === 0 && <p className="muted">공정을 추가하세요. 공정 구조·시간 점유율은 조사 서류 기반 수기 입력입니다.</p>}
        {va.processes.map((p) => {
          const clips = va.clips.filter((c) => c.processId === p.id);
          const total = shareTotals[p.sharedJobId] || 0;
          return (
            <div key={p.id} className="va-process-row" style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={p.name} onChange={(e) => editProcess(p.id, { name: e.target.value })} placeholder="공정명" />
                <select value={p.sharedJobId} onChange={(e) => editProcess(p.id, { sharedJobId: e.target.value })}>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.jobName || '(직업 미지정)'}</option>)}
                </select>
                <label>점유율
                  <input type="number" min="0" max="100" value={p.shiftSharePercent}
                    onChange={(e) => editProcess(p.id, { shiftSharePercent: Number(e.target.value) })} style={{ width: 70 }} />%
                </label>
                <select value={p.analysisProfile} onChange={(e) => editProcess(p.id, { analysisProfile: e.target.value })}>
                  {PROFILES.map((pr) => <option key={pr.value} value={pr.value}>{pr.label}</option>)}
                </select>
                <button type="button" onClick={() => removeProcess(p.id)}>삭제</button>
              </div>
              {total !== 100 && <p className="muted" style={{ color: '#b26a00' }}>⚠ "{jobName(p.sharedJobId)}" 공정 점유율 합 {total}% (100% 권장)</p>}
              <div style={{ marginTop: 6 }}>
                {clips.map((c) => (
                  <span key={c.id} style={{ display: 'inline-flex', gap: 4, marginRight: 8, alignItems: 'center' }}>
                    <select value={c.viewpoint} onChange={(e) => editClip(c.id, { viewpoint: e.target.value })}>
                      {VIEWPOINTS.map((vp) => <option key={vp.value} value={vp.value}>{vp.label}</option>)}
                    </select>
                    <button type="button" onClick={() => removeClip(c.id)}>×</button>
                  </span>
                ))}
                <button type="button" onClick={() => addClip(p.id)}>+ 클립</button>
                {clips.length === 0 && <span className="muted"> 클립(시점) 미태깅</span>}
              </div>
            </div>
          );
        })}
        <button type="button" onClick={addProcess}>+ 공정 추가</button>

        {/* 2) mock 분석 */}
        <div style={{ marginTop: 16 }}>
          <button type="button" onClick={runMockAnalysis} disabled={va.processes.length === 0}>mock 분석 실행</button>
        </div>

        {/* 3) 제안 검토 (job-scope) */}
        {hasAnalysis && (
          <div style={{ marginTop: 16 }}>
            <h3>제안 검토 (직업 단위)</h3>
            {jobScopeModules.length === 0 && <p className="muted">자동 매핑 지원 직업단위 모듈(무릎·어깨)이 활성화되어 있지 않습니다.</p>}
            {(va.jobFeatures || []).map((jf) => (
              <div key={jf.sharedJobId} style={{ marginBottom: 10 }}>
                <b>{jobName(jf.sharedJobId)}</b>
                {jobScopeModules.map((moduleId) => {
                  const suggestions = getModuleSuggestions(jf.features, moduleId);
                  if (suggestions.length === 0) return null;
                  const procIds = va.processes.filter((p) => p.sharedJobId === jf.sharedJobId).map((p) => p.id);
                  return (
                    <ul key={moduleId} style={{ listStyle: 'none', paddingLeft: 12 }}>
                      {suggestions.map((s) => (
                        <li key={s.featureKey} style={{ margin: '4px 0' }}>
                          <code>{s.featureKey}</code> → {String(s.suggestedValue)} {s.unit || ''}
                          <span style={{ marginLeft: 6, fontSize: 12, color: s.confidence >= 0.8 ? '#2e7d32' : '#b26a00' }}>
                            신뢰도 {Math.round(s.confidence * 100)}%
                          </span>
                          {s.requiresManualReview && <span style={{ marginLeft: 6, fontSize: 12, color: '#b26a00' }}>수기확인</span>}
                          <button type="button" style={{ marginLeft: 8 }}
                            onClick={() => applySuggestion(moduleId, { sharedJobId: jf.sharedJobId }, s, procIds)}>적용</button>
                        </li>
                      ))}
                    </ul>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* 4) candidate (참고만) */}
        {(va.candidateFeatures || []).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3>참고 후보 (자동입력 금지)</h3>
            <ul>
              {va.candidateFeatures.map((c, i) => (
                <li key={`${c.featureKey}-${i}`}><code>{c.featureKey}</code>: {String(c.value)} — <span className="muted">{c.reason}</span></li>
              ))}
            </ul>
          </div>
        )}

        {/* 5) 적용 이력 + 되돌리기 */}
        {(va.appliedInputs || []).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3>적용 이력 (provenance)</h3>
            <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
              {va.appliedInputs.map((e, i) => (
                <li key={i} style={{ margin: '4px 0' }}>
                  <code>{e.targetPath.split('.').slice(-2).join('.')}</code> = {String(e.appliedValue)}
                  <span className="muted" style={{ marginLeft: 6 }}>(이전: {String(e.previousValue)})</span>
                  <button type="button" style={{ marginLeft: 8 }} onClick={() => rollback(e)}>되돌리기</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

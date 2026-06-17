// [공유] 영상 분석 스텝 (6.0-3/6.0-4, mock-first). mock feature로 공정 정리 → 분석 →
// 제안 검토 → 적용/무시 → provenance/rollback 흐름. 인트라넷+synced 환자는 적용을
// 서버 경로(clip→job→apply, audit·영속화)로, 그 외는 로컬로 처리한다(§8.2/§8.12).
// 실제 추론은 M2에서 서버 셸에 연결된다.
import { useMemo, useState } from 'react';
import { generateMockFeatures } from '../services/videoMock';
import { aggregateProcessFeatures } from '../services/videoAggregate';
import {
  getModuleSuggestions,
  collectCandidateFeatures,
  applyFeatureToModule,
  rollbackAppliedInput,
} from '../services/videoProvenance';
import { isVideoAnalysisSupported, createClip, sampleDetectClip, selectTarget } from '../services/videoAnalysisClient';
import { applyVideoFeatureViaServer } from '../services/videoServerApply';
import { runServerAnalysis } from '../services/videoAnalysisRun';
import { TargetPicker } from './TargetPicker';
import { getModule } from '../moduleRegistry';
import { VIDEO_FEATURE_TARGETS, resolveAnalysisJobIds } from '@contracts/index';

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

/**
 * 공정별 feature를 직업(sharedJobId) 단위로 묶어 집계한다(job-scope).
 * @param {boolean} absolutePerDay - 서버 실분석 값은 ratio×activeMinutesPerDay로 이미 절대 per-day이므로
 *   share로 재가중하지 않고 합산한다(share=100). mock 값은 "공정 100% 가정" 값이라 share 가중(기본).
 *   둘을 섞으면 per-day가 이중 차감되므로 경로별로 분리한다(PR D1).
 */
export function buildJobFeatures(processes = [], processFeatures = [], { absolutePerDay = false } = {}) {
  const byJob = {};
  for (const pf of processFeatures) {
    const proc = processes.find((p) => p.id === pf.processId);
    if (!proc) continue;
    (byJob[proc.sharedJobId] = byJob[proc.sharedJobId] || []).push({
      share: absolutePerDay ? 100 : proc.shiftSharePercent,
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
      activeMinutesPerDay: null, // 공정활동분/일(수기). per-day 환산 입력. null=모름(적용 불가).
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

// 적용 경로 결정: 인트라넷=서버(synced 필요), 인트라넷+미동기=차단, 그 외=로컬.
export function resolveApplyMode(serverSupported, isSynced) {
  if (serverSupported && isSynced) return 'server';
  if (serverSupported && !isSynced) return 'blocked';
  return 'local';
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────
export function VideoAnalysisStep({ shared, updateShared, updatePatient, activePatient, activeModules = [], session, settings, fixtureMode = false, onServerApplied }) {
  const va = shared?.videoAnalysis || {
    processes: [], clips: [], processFeatures: [], jobFeatures: [], candidateFeatures: [], appliedInputs: [],
  };
  const jobs = shared?.jobs || [];
  const jobName = (id) => jobs.find((j) => j.id === id)?.jobName || '(직업 미지정)';
  const appliedBy = session?.user?.name || shared?.doctorName || 'unknown';

  // 적용 경로 결정: 인트라넷=서버 경로(synced 필요), 그 외=로컬.
  const serverSupported = isVideoAnalysisSupported(session);
  const isSynced = !!activePatient?.sync?.serverId && activePatient?.sync?.syncStatus === 'synced';
  const applyMode = resolveApplyMode(serverSupported, isSynced);
  const serverMode = applyMode === 'server';
  const applyBlocked = applyMode === 'blocked'; // 인트라넷인데 미동기 → 적용 불가
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  // 서버 실분석 산출물: 적용 시 provenance recipe·누락 활동시간 안내에 사용.
  const [analysisBundle, setAnalysisBundle] = useState(MOCK_BUNDLE);
  const [missingActiveTime, setMissingActiveTime] = useState({}); // { processId: featureKey[] }
  // 대상자 선택(§8.7, PR D2b): 클립별 { serverClipId, result, selectedId, fixtureClipName }. 환자 JSONB 미저장(전송 X).
  const [detection, setDetection] = useState({}); // { [clipMetaId]: {...} }
  const [detecting, setDetecting] = useState(null); // 진행 중 clipMetaId

  // detection이 현재 클립과 일치할 때만 유효(fixtureClipName 변경/clip 삭제 시 stale → 무시). 무효화-at-use.
  const validDetection = (clipMeta) => {
    const d = detection[clipMeta.id];
    return d && d.fixtureClipName === clipMeta.fixtureClipName ? d : null;
  };

  const jobScopeModules = activeModules.filter((m) => getModule(m)?.videoMappingConfig?.scope === 'job');
  const shareTotals = useMemo(() => shareTotalsByJob(va.processes), [va.processes]);

  const updateVA = (mutator) => updateShared({ ...shared, videoAnalysis: mutator(va) });

  // ── 공정/클립 편집 ── 입력 변경 시 파생 분석결과는 비워 stale 적용을 막는다(clearDerived).
  const addProcess = () => updateVA((v) => addProcessVA(v, jobs));
  const editProcess = (id, patch) => updateVA((v) => editProcessVA(v, id, patch));
  const removeProcess = (id) => updateVA((v) => removeProcessVA(v, id));
  const addClip = (processId) => updateVA((v) => addClipVA(v, processId));
  const editClip = (id, patch) => updateVA((v) => editClipVA(v, id, patch));
  const dropDetection = (clipMetaId) => setDetection((d) => { const n = { ...d }; delete n[clipMetaId]; return n; });
  const removeClip = (id) => { dropDetection(id); updateVA((v) => removeClipVA(v, id)); };

  // ── 대상자 선택(§8.7, PR D2b) ── 대표 프레임 후보 탐지 → 박스 클릭 → select-target.
  const detectTarget = async (clipMeta, processId) => {
    setAnalysisError('');
    setDetecting(clipMeta.id);
    try {
      const clip = await createClip(activePatient, { processId, fixtureClipName: clipMeta.fixtureClipName, session, settings });
      const result = await sampleDetectClip(clip.clipId, { session, settings });
      setDetection((d) => ({ ...d, [clipMeta.id]: { serverClipId: clip.clipId, result, selectedId: null, fixtureClipName: clipMeta.fixtureClipName } }));
    } catch (e) {
      setAnalysisError(e?.message || '대상자 탐지에 실패했습니다.');
    } finally {
      setDetecting(null);
    }
  };
  const chooseTarget = async (clipMeta, personId) => {
    const d = detection[clipMeta.id];
    if (!d) return;
    try {
      await selectTarget(d.serverClipId, personId, { session, settings });
      setDetection((prev) => ({ ...prev, [clipMeta.id]: { ...prev[clipMeta.id], selectedId: personId } }));
    } catch (e) {
      setAnalysisError(e?.message || '대상자 선택에 실패했습니다.');
    }
  };

  // 분석 산출(공통): processFeatures → jobFeatures/candidateFeatures 재구성 후 저장.
  // absolutePerDay: 서버 실분석은 절대 per-day(합산), mock은 공정점유율 가중.
  const commitAnalysis = (processFeatures, { absolutePerDay = false } = {}) => {
    const jobFeatures = buildJobFeatures(va.processes, processFeatures, { absolutePerDay });
    const candidateFeatures = processFeatures.flatMap((pf) =>
      collectCandidateFeatures(pf.features, { processIds: [pf.processId] })
    );
    updateVA((v) => ({ ...v, processFeatures, jobFeatures, candidateFeatures }));
  };

  // ── 분석 실행 ── 서버 모드=fixture 실추론+per-day 환산, 그 외=mock. 적용과 분리(추론은 여기서만).
  const runAnalysis = async () => {
    setAnalysisError('');
    setMissingActiveTime({});
    if (!serverMode) {
      const requested = requestedFeaturesForModules(activeModules);
      const processFeatures = va.processes.map((p) => ({
        processId: p.id,
        features: generateMockFeatures(requested, p.analysisProfile),
      }));
      setAnalysisBundle(MOCK_BUNDLE);
      commitAnalysis(processFeatures);
      return;
    }
    setAnalyzing(true);
    try {
      // 유효 detection(serverClipId+선택)만 전달 — stale(fixture 변경/삭제)은 validDetection이 거른다.
      const detections = {};
      for (const c of va.clips || []) {
        const d = validDetection(c);
        if (d?.serverClipId && d.selectedId) detections[c.id] = { serverClipId: d.serverClipId, selectedId: d.selectedId };
      }
      const { processFeatures, missingActiveTime: missing, bundleVersion, errors } =
        await runServerAnalysis(activePatient, va, { activeModules, session, settings, detections });
      setAnalysisBundle(bundleVersion || MOCK_BUNDLE);
      setMissingActiveTime(missing);
      commitAnalysis(processFeatures, { absolutePerDay: true });
      if (errors.length > 0) setAnalysisError(errors.map((e) => e.message).join(' / '));
    } catch (e) {
      setAnalysisError(e?.message || '분석에 실패했습니다.');
    } finally {
      setAnalyzing(false);
    }
  };

  // ── 제안 적용 / 되돌리기 ──
  // 서버 모드: clip→job→apply(영속화·audit) 후 서버 동기화 환자를 목록에 반영(per-field, apply마다 job).
  // 로컬 모드: updatePatient로 즉시 반영(standalone/web).
  const applySuggestion = async (moduleId, ctx, s, processIds, analysisProfile) => {
    if (applyBlocked) {
      setApplyError('서버에 저장·동기화된 환자만 적용할 수 있습니다. 먼저 저장하세요.');
      return;
    }
    // 이 제안을 만든 원본 분석 job(들): 해당 공정들의 analysisJobIds(폴백: jobId). 셸 적용 job과 구분해 provenance에.
    // D3b: 한 공정이 여러 시점 클립(여러 job)을 융합 → 배열을 모두 운반(정규화로 [undefined] 방지).
    const analysisJobIds = (va.processFeatures || [])
      .filter((pf) => (processIds || []).includes(pf.processId))
      .flatMap((pf) => resolveAnalysisJobIds(pf));
    if (!serverMode) {
      updatePatient((d) => applyFeatureToModule({ data: d }, {
        moduleId, ctx, featureKey: s.featureKey,
        suggestedValue: s.suggestedValue, confidence: s.confidence,
        processIds: processIds || [], analysisJobIds, analysisBundleVersion: analysisBundle, appliedBy,
      }).patient.data);
      return;
    }
    setBusy(true);
    setApplyError('');
    try {
      const serverPatient = await applyVideoFeatureViaServer(
        activePatient,
        { moduleId, ctx, featureKey: s.featureKey, suggestedValue: s.suggestedValue, confidence: s.confidence, processIds: processIds || [], analysisJobIds, analysisBundleVersion: analysisBundle, analysisProfile },
        { session, settings, appliedBy }
      );
      onServerApplied?.(serverPatient);
    } catch (e) {
      setApplyError(e?.message || '서버 적용에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };
  // rollback은 로컬 적용에만(서버 apply 후 rollback은 M3 — §8.12 경계).
  const rollback = (entry) => updatePatient((d) => rollbackAppliedInput({ data: d }, d.shared.videoAnalysis.appliedInputs.indexOf(entry)).data);

  const hasAnalysis = (va.jobFeatures || []).length > 0 || (va.processFeatures || []).length > 0;

  return (
    <div className="panel">
      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">🎥</span>작업 영상 인간공학 분석{serverMode && fixtureMode ? ' (fixture)' : serverMode ? '' : ' (mock)'}</h2>
            <p className="section-description">
              조사 서류 기반으로 공정을 정리하고 mock 분석을 실행합니다. 결과는 항상 <b>제안값</b>이며 전문의가 확정합니다.
              {serverMode && ' 적용은 서버에 기록됩니다(audit).'}
              {!serverSupported && ' (인트라넷 외 모드: 로컬 적용만)'}
            </p>
            {applyBlocked && (
              <p className="muted" style={{ color: '#b26a00' }}>
                ⚠ 이 환자는 서버에 동기화되지 않았습니다. 먼저 저장·동기화하면 영상 분석 결과를 적용할 수 있습니다.
              </p>
            )}
            {applyError && <p className="muted" style={{ color: '#c62828' }}>오류: {applyError}</p>}
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
                <label title="공정활동분/일(수기). per-day 환산 입력 — 비우면 모름(적용 불가).">활동시간
                  <input type="number" min="0" max="1440" placeholder="분/일"
                    value={p.activeMinutesPerDay ?? ''}
                    onChange={(e) => editProcess(p.id, { activeMinutesPerDay: e.target.value === '' ? null : Number(e.target.value) })}
                    style={{ width: 80 }} />분/일
                </label>
                <select value={p.analysisProfile} onChange={(e) => editProcess(p.id, { analysisProfile: e.target.value })}>
                  {PROFILES.map((pr) => <option key={pr.value} value={pr.value}>{pr.label}</option>)}
                </select>
                <button type="button" onClick={() => removeProcess(p.id)}>삭제</button>
              </div>
              {total !== 100 && <p className="muted" style={{ color: '#b26a00' }}>⚠ "{jobName(p.sharedJobId)}" 공정 점유율 합 {total}% (100% 권장)</p>}
              <div style={{ marginTop: 6 }}>
                {clips.map((c) => {
                  const canDetect = fixtureMode && serverMode && !!c.fixtureClipName;
                  const det = canDetect ? validDetection(c) : null;
                  return (
                    <div key={c.id} style={{ marginBottom: 6 }}>
                      <span style={{ display: 'inline-flex', gap: 4, marginRight: 8, alignItems: 'center' }}>
                        <select value={c.viewpoint} onChange={(e) => editClip(c.id, { viewpoint: e.target.value })}>
                          {VIEWPOINTS.map((vp) => <option key={vp.value} value={vp.value}>{vp.label}</option>)}
                        </select>
                        {fixtureMode && (
                          <input type="text" placeholder="fixture 파일명(dev)" value={c.fixtureClipName || ''}
                            onChange={(e) => editClip(c.id, { fixtureClipName: e.target.value })} style={{ width: 150 }} />
                        )}
                        {canDetect && (
                          <button type="button" disabled={detecting === c.id} onClick={() => detectTarget(c, p.id)}>
                            {detecting === c.id ? '탐지 중…' : (det ? '재탐지' : '대상자 탐지')}
                          </button>
                        )}
                        <button type="button" onClick={() => removeClip(c.id)}>×</button>
                      </span>
                      {det && (
                        <div style={{ marginTop: 4 }}>
                          <TargetPicker result={det.result} selectedId={det.selectedId} onSelect={(id) => chooseTarget(c, id)} />
                          <p className="muted" style={{ fontSize: 12 }}>
                            {det.selectedId ? `대상자: ${det.selectedId}` : '박스를 클릭해 대상 작업자를 선택하세요(미선택 시 자동=주요 인물).'}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={() => addClip(p.id)}>+ 클립</button>
                {clips.length === 0 && <span className="muted"> 클립(시점) 미태깅</span>}
              </div>
            </div>
          );
        })}
        <button type="button" onClick={addProcess}>+ 공정 추가</button>

        {/* 2) 분석 실행 (서버=fixture 실추론, 그 외=mock) */}
        <div style={{ marginTop: 16 }}>
          <button type="button" onClick={runAnalysis} disabled={va.processes.length === 0 || analyzing}>
            {analyzing ? '분석 중…' : (serverMode ? '분석 실행' : 'mock 분석 실행')}
          </button>
          {analysisError && <p className="muted" style={{ color: '#c62828' }}>분석 오류: {analysisError}</p>}
          {Object.keys(missingActiveTime).length > 0 && (
            <p className="muted" style={{ color: '#b26a00' }}>
              ⚠ 일부 공정의 활동시간(분/일)이 비어 있어 per-day 제안을 만들지 못했습니다. 공정 "활동시간"을 입력 후 다시 분석하세요.
            </p>
          )}
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
                  const jobProcesses = va.processes.filter((p) => p.sharedJobId === jf.sharedJobId);
                  const procIds = jobProcesses.map((p) => p.id);
                  const analysisProfile = jobProcesses[0]?.analysisProfile;
                  return (
                    <ul key={moduleId} style={{ listStyle: 'none', paddingLeft: 12 }}>
                      {suggestions.map((s) => {
                        // 저신뢰 게이팅(§8.8 D3a): autoSuggestAllowed=false면 "참고만" — 자동제안 금지, 적용 버튼 비활성.
                        const refOnly = s.autoSuggestAllowed === false;
                        return (
                        <li key={s.featureKey} style={{ margin: '4px 0' }}>
                          <code>{s.featureKey}</code> → {String(s.suggestedValue)} {s.unit || ''}
                          <span style={{ marginLeft: 6, fontSize: 12, color: s.confidence >= 0.8 ? '#2e7d32' : '#b26a00' }}>
                            신뢰도 {Math.round(s.confidence * 100)}%
                          </span>
                          {refOnly && <span style={{ marginLeft: 6, fontSize: 12, color: '#b26a00' }} title="저신뢰 — 수기 확인 필요">참고만</span>}
                          {s.requiresManualReview && <span style={{ marginLeft: 6, fontSize: 12, color: '#b26a00' }}>수기확인</span>}
                          <button type="button" style={{ marginLeft: 8 }} disabled={busy || applyBlocked || refOnly}
                            onClick={() => applySuggestion(moduleId, { sharedJobId: jf.sharedJobId }, s, procIds, analysisProfile)}>
                            {serverMode ? '서버 적용' : '적용'}
                          </button>
                        </li>
                        );
                      })}
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
            {serverMode && (
              <p className="muted">서버 적용 항목의 되돌리기는 후속 단계(M3)에서 지원됩니다. 모듈 탭에서 직접 수정하세요.</p>
            )}
            <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
              {va.appliedInputs.map((e, i) => (
                <li key={i} style={{ margin: '4px 0' }}>
                  <code>{e.targetPath.split('.').slice(-2).join('.')}</code> = {String(e.appliedValue)}
                  <span className="muted" style={{ marginLeft: 6 }}>(이전: {String(e.previousValue)})</span>
                  {/* 서버 모드: 로컬 rollback은 서버(done) 상태와 갈라지므로 미노출(§8.12, Codex). */}
                  {!serverMode && (
                    <button type="button" style={{ marginLeft: 8 }} onClick={() => rollback(e)}>되돌리기</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

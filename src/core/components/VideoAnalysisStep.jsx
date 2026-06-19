// [공유] 영상 분석 스텝 (6.0-3/6.0-4, mock-first). mock feature로 공정 정리 → 분석 →
// 제안 검토 → 적용/무시 → provenance/rollback 흐름. 인트라넷+synced 환자는 적용을
// 서버 경로(clip→job→apply, audit·영속화)로, 그 외는 로컬로 처리한다(§8.2/§8.12).
// 실제 추론은 M2에서 서버 셸에 연결된다.
import { useMemo, useState, useRef, useEffect } from 'react';
import { generateMockFeatures } from '../services/videoMock';
import { aggregateProcessFeatures, getAggregationMethod } from '../services/videoAggregate';
import {
  getModuleSuggestions,
  collectCandidateFeatures,
  applyFeatureToModule,
  rollbackAppliedInput,
} from '../services/videoProvenance';
import { isVideoAnalysisSupported, createClip, uploadClip, sampleDetectClip, selectTarget, fetchSampleFrame } from '../services/videoAnalysisClient';
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
/**
 * 대상자 탐지(sample-detect) 가능 여부. 서버 모드 전제.
 * 실 업로드 완료 clip(upload.status==='done') 또는 dev fixture 파일명 보유 clip만 탐지 가능(M3-7a).
 */
export function canDetectClip({ serverMode, fixtureMode, clip, upload }) {
  if (!serverMode) return false;
  if (upload && upload.status === 'done' && upload.serverClipId) return true;
  return !!(fixtureMode && clip.fixtureClipName);
}

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

/**
 * 공정별 근거(processEvidence)를 직업(sharedJobId) 단위로 묶어 "왜 이 값?" 패널 lookup map을 만든다.
 * 값 집계(buildJobFeatures)와 **완전 분리** — evidence는 feature 객체에 미부착·shared에 영속화 안 함.
 * 2단 keying: jobEvidenceBySharedJobId[sharedJobId][featureKey] (featureKey 단독은 다직업 충돌).
 * @param {Array} processFeatures - per-day 값(공정별 per-feature value 참조용)
 * @param {Array} processEvidence - [{ processId, analysisJobIds, evidenceByFeatureKey }]
 * @returns {object} jobEvidenceBySharedJobId
 */
export function buildJobEvidence(processes = [], processFeatures = [], processEvidence = []) {
  const featuresByProcess = {};
  for (const pf of processFeatures) featuresByProcess[pf.processId] = pf.features || {};
  const byJob = {};
  for (const pe of processEvidence) {
    const proc = processes.find((p) => p.id === pe.processId);
    if (!proc) continue;
    const jobMap = byJob[proc.sharedJobId] || (byJob[proc.sharedJobId] = {});
    for (const [featureKey, ev] of Object.entries(pe.evidenceByFeatureKey || {})) {
      const entry = jobMap[featureKey] || (jobMap[featureKey] = {
        aggregationMethod: getAggregationMethod(featureKey),
        contributions: [],
        analysisJobIds: [],
      });
      entry.contributions.push({
        processId: proc.id,
        processName: proc.name,
        // 실 공정 점유율(검토자 표시용). 집계 가중치(서버 absolute 경로의 내부 100%)와 구분 — 오해 방지.
        sharePercent: proc.shiftSharePercent,
        perDayValue: featuresByProcess[pe.processId]?.[featureKey]?.value,
        evidence: ev,
      });
      for (const jid of pe.analysisJobIds || []) {
        if (entry.analysisJobIds.indexOf(jid) < 0) entry.analysisJobIds.push(jid);
      }
    }
  }
  return byJob;
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
  // 대상자 선택(§8.7, PR D2b): 클립별 { serverClipId, result, selectedId, clipKey }. 환자 JSONB 미저장(전송 X).
  const [detection, setDetection] = useState({}); // { [clipMetaId]: {...} }
  const [detecting, setDetecting] = useState(null); // 진행 중 clipMetaId
  // 실 업로드(M3-7a): 클립별 { serverClipId, fileName, progress, status }. UI 임시 상태(환자 JSONB·경로·Blob 미저장).
  const [uploads, setUploads] = useState({}); // { [clipMetaId]: {...} }
  // 근거 패널(B2 선행): "왜 이 값?" evidence. **transient만** — shared.videoAnalysis에 저장 안 함(영속화 차단).
  // 새로고침/환자전환/입력변경 시 사라짐(의도) → 부재 제안행은 fallback 안내.
  const [analysisEvidence, setAnalysisEvidence] = useState({ jobEvidenceBySharedJobId: {}, processEvidenceByProcessId: {} });
  const [expandedEvidence, setExpandedEvidence] = useState(null); // 펼친 제안 키 `${sharedJobId}:${featureKey}`
  const resetEvidence = () => { setAnalysisEvidence({ jobEvidenceBySharedJobId: {}, processEvidenceByProcessId: {} }); setExpandedEvidence(null); };

  // 썸네일 objectURL 누수 방지: 언마운트 시 남은 frameUrl 모두 해제(detection 최신값을 ref로 추적).
  const detectionRef = useRef(detection);
  detectionRef.current = detection;
  useEffect(() => () => {
    Object.keys(detectionRef.current).forEach((k) => {
      const u = detectionRef.current[k]?.frameUrl;
      if (u) URL.revokeObjectURL(u);
    });
  }, []);

  // 클립의 현재 "출처 키"(fixture 파일명 또는 업로드 serverClipId). 변경 시 detection이 stale이 된다.
  const clipKeyOf = (clipMeta) => clipMeta.fixtureClipName || uploads[clipMeta.id]?.serverClipId || null;
  // detection이 현재 클립 출처와 일치할 때만 유효(fixture명/업로드 변경·clip 삭제 시 stale → 무시). 무효화-at-use.
  const validDetection = (clipMeta) => {
    const d = detection[clipMeta.id];
    return d && d.clipKey === clipKeyOf(clipMeta) ? d : null;
  };

  const jobScopeModules = activeModules.filter((m) => getModule(m)?.videoMappingConfig?.scope === 'job');
  const shareTotals = useMemo(() => shareTotalsByJob(va.processes), [va.processes]);

  const updateVA = (mutator) => updateShared({ ...shared, videoAnalysis: mutator(va) });

  // 업로드/대상자 등 컴포넌트 state 입력이 바뀌면 파생 분석결과(jobFeatures)가 stale이 된다(이들은
  // clearDerived를 안 거침). 명시적으로 비운다 → jobFeatures useEffect가 evidence도 자동 reset(코덱스 3차 #1).
  const invalidateDerived = () => {
    if ((va.jobFeatures || []).length > 0 || (va.processFeatures || []).length > 0) {
      updateVA((v) => clearDerived(v));
    }
  };

  // evidence reset 정책: ① 환자 전환 시 무조건 reset(이전 환자 근거 잔존 방지),
  //   ② jobFeatures가 비면(입력 편집·invalidateDerived) reset. evidence는 영속화 안 하므로 set은 runAnalysis에서만.
  useEffect(() => { resetEvidence(); }, [activePatient?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if ((va.jobFeatures || []).length === 0) resetEvidence(); }, [va.jobFeatures]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 공정/클립 편집 ── 입력 변경 시 파생 분석결과는 비워 stale 적용을 막는다(clearDerived).
  const addProcess = () => updateVA((v) => addProcessVA(v, jobs));
  const editProcess = (id, patch) => updateVA((v) => editProcessVA(v, id, patch));
  const removeProcess = (id) => updateVA((v) => removeProcessVA(v, id));
  const addClip = (processId) => updateVA((v) => addClipVA(v, processId));
  const editClip = (id, patch) => updateVA((v) => editClipVA(v, id, patch));
  const dropDetection = (clipMetaId) => {
    invalidateDerived(); // 대상자 무효화 → 파생결과·evidence stale
    setDetection((d) => {
      const n = { ...d };
      if (n[clipMetaId]?.frameUrl) URL.revokeObjectURL(n[clipMetaId].frameUrl); // objectURL 누수 방지
      delete n[clipMetaId];
      return n;
    });
  };
  const dropUpload = (clipMetaId) => setUploads((u) => { const n = { ...u }; delete n[clipMetaId]; return n; });
  const removeClip = (id) => { dropDetection(id); dropUpload(id); updateVA((v) => removeClipVA(v, id)); };

  // ── 실 영상 업로드(M3-7a) ── createClip(analysis_upload) → uploadClip(진행률). 완료 시 serverClipId 보관.
  const uploadClipFile = async (clipMeta, processId, file) => {
    if (!file) return;
    setAnalysisError('');
    dropDetection(clipMeta.id); // 새 업로드 → 기존 detection 무효화.
    setUploads((u) => ({ ...u, [clipMeta.id]: { fileName: file.name, progress: 0, status: 'uploading', serverClipId: null } }));
    try {
      const clip = await createClip(activePatient, { processId, purpose: 'analysis_upload', session, settings });
      await uploadClip(clip.clipId, file, {
        session, settings,
        onProgress: ({ loaded, total }) =>
          setUploads((u) => ({ ...u, [clipMeta.id]: { ...u[clipMeta.id], progress: total ? loaded / total : 0 } })),
      });
      setUploads((u) => ({ ...u, [clipMeta.id]: { ...u[clipMeta.id], serverClipId: clip.clipId, progress: 1, status: 'done' } }));
    } catch (e) {
      setUploads((u) => ({ ...u, [clipMeta.id]: { ...u[clipMeta.id], status: 'error' } }));
      setAnalysisError(e?.message || '영상 업로드에 실패했습니다.');
    }
  };

  // ── 대상자 선택(§8.7, PR D2b) ── 대표 프레임 후보 탐지 → 박스 클릭 → select-target.
  const detectTarget = async (clipMeta, processId) => {
    setAnalysisError('');
    invalidateDerived(); // 재탐지 → 기존 분석결과·evidence stale
    setDetecting(clipMeta.id);
    try {
      // 업로드 완료 clip은 기존 serverClipId 재사용(새 clip 생성 금지). fixture만 여기서 clip 생성.
      const up = uploads[clipMeta.id];
      let clipId;
      if (up?.serverClipId && up.status === 'done') {
        clipId = up.serverClipId;
      } else {
        const clip = await createClip(activePatient, { processId, purpose: 'fixture', fixtureClipName: clipMeta.fixtureClipName, session, settings });
        clipId = clip.clipId;
      }
      const result = await sampleDetectClip(clipId, { session, settings });
      // 정책 예외(서버 게이트 on): 대표 프레임 썸네일 best-effort 취득(off/미생성이면 null → 박스-only).
      let frameUrl = null;
      try { frameUrl = await fetchSampleFrame(clipId, { session, settings }); } catch { frameUrl = null; }
      setDetection((d) => {
        const prev = d[clipMeta.id];
        if (prev?.frameUrl && prev.frameUrl !== frameUrl) URL.revokeObjectURL(prev.frameUrl); // 이전 objectURL 해제
        return { ...d, [clipMeta.id]: { serverClipId: clipId, result, selectedId: null, clipKey: clipKeyOf(clipMeta), frameUrl } };
      });
    } catch (e) {
      setAnalysisError(e?.message || '대상자 탐지에 실패했습니다.');
    } finally {
      setDetecting(null);
    }
  };
  const chooseTarget = async (clipMeta, personId) => {
    const d = detection[clipMeta.id];
    if (!d) return;
    invalidateDerived(); // 대상자 재선택 → 기존 분석결과·evidence stale
    try {
      await selectTarget(d.serverClipId, personId, { session, settings });
      setDetection((prev) => ({ ...prev, [clipMeta.id]: { ...prev[clipMeta.id], selectedId: personId } }));
    } catch (e) {
      setAnalysisError(e?.message || '대상자 선택에 실패했습니다.');
    }
  };

  // 분석 산출(공통): processFeatures → jobFeatures/candidateFeatures 재구성 후 저장.
  // absolutePerDay: 서버 실분석은 절대 per-day(합산), mock은 공정점유율 가중.
  // processEvidence: "왜 이 값?" 근거(서버 실분석만 제공, mock은 빈 배열). va에 저장 안 하고 별도 state로.
  const commitAnalysis = (processFeatures, { absolutePerDay = false, processEvidence = [] } = {}) => {
    const jobFeatures = buildJobFeatures(va.processes, processFeatures, { absolutePerDay });
    const candidateFeatures = processFeatures.flatMap((pf) =>
      collectCandidateFeatures(pf.features, { processIds: [pf.processId] })
    );
    updateVA((v) => ({ ...v, processFeatures, jobFeatures, candidateFeatures }));
    // evidence는 transient state(영속화 차단). buildJobEvidence로 직업단위 lookup map 구성.
    const jobEvidenceBySharedJobId = buildJobEvidence(va.processes, processFeatures, processEvidence);
    const processEvidenceByProcessId = {};
    for (const pe of processEvidence) processEvidenceByProcessId[pe.processId] = pe.evidenceByFeatureKey || {};
    setAnalysisEvidence({ jobEvidenceBySharedJobId, processEvidenceByProcessId });
  };

  // ── 분석 실행 ── 서버 모드=fixture 실추론+per-day 환산, 그 외=mock. 적용과 분리(추론은 여기서만).
  const runAnalysis = async () => {
    setAnalysisError('');
    setMissingActiveTime({});
    resetEvidence(); // 새 분석 시작 → 이전 근거 비움(성공 시 commitAnalysis가 다시 채움)
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
      // 분석에 쓸 serverClipId 전달: ① 유효 detection(선택까지) 우선, ② 없으면 업로드 완료 clip(대상=dominant).
      // stale detection(fixture/업로드 변경·삭제)은 validDetection이 거른다.
      const detections = {};
      for (const c of va.clips || []) {
        const d = validDetection(c);
        if (d?.serverClipId && d.selectedId) {
          detections[c.id] = { serverClipId: d.serverClipId, selectedId: d.selectedId };
        } else {
          const up = uploads[c.id];
          if (up?.serverClipId && up.status === 'done') detections[c.id] = { serverClipId: up.serverClipId };
        }
      }
      const { processFeatures, processEvidence, missingActiveTime: missing, bundleVersion, errors } =
        await runServerAnalysis(activePatient, va, { activeModules, session, settings, detections });
      setAnalysisBundle(bundleVersion || MOCK_BUNDLE);
      setMissingActiveTime(missing);
      commitAnalysis(processFeatures, { absolutePerDay: true, processEvidence });
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
    // 서버 모드는 원본 분석 job 추적이 필수(D3b) — 빈 provenance면 적용 거부(로컬/mock은 예외).
    if (serverMode && analysisJobIds.length === 0) {
      setApplyError('이 제안의 원본 분석 정보를 찾을 수 없어 적용할 수 없습니다. 분석을 다시 실행해 주세요.');
      return;
    }
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

  // ── coarse 파이프라인 진행바(B2 선행) ── fixture/자동 dominant 경로도 포괄. queued→processing→
  // review_pending 실시간 단계는 pollJob 내부라 미표시(이번 범위 제외).
  const PIPELINE_STEPS = ['클립 준비', '대상자 확인', '분석 중', '검수대기/제안생성'];
  const anyAnalyzableClip = (va.clips || []).some(
    (c) => c.fixtureClipName || uploads[c.id]?.status === 'done' || validDetection(c)?.serverClipId,
  );
  const anyTargetChosen = (va.clips || []).some((c) => validDetection(c)?.selectedId);
  let pipelineIndex = -1;
  if (anyAnalyzableClip) pipelineIndex = 0;
  if (anyTargetChosen) pipelineIndex = 1;
  if (hasAnalysis) pipelineIndex = 3;
  if (analyzing) pipelineIndex = 2; // 재분석 중에는 이전 결과(hasAnalysis)보다 "분석 중"을 우선 표시

  // 한 contribution(공정)의 환산식 문자열(자세비율 × 활동시간). ratio metric만 표시. 단위별 분기.
  const contribFormula = (ev, perDayValue, unit) => {
    if (!ev || ev.intrinsicMetric !== 'posture_ratio' || ev.activeMinutesPerDay == null) return null;
    const ratio = typeof ev.intrinsicValue === 'number' ? ev.intrinsicValue.toFixed(3) : ev.intrinsicValue;
    const pd = typeof perDayValue === 'number' ? Math.round(perDayValue * 10) / 10 : perDayValue;
    const pdStr = pd == null ? '?' : pd;
    const am = ev.activeMinutesPerDay;
    if (unit === 'hours_per_day') return `${pdStr} 시간/일 = 자세비율 ${ratio} × 활동 ${am}분/일 ÷ 60`;
    if (unit === 'minutes_per_day') return `${pdStr} 분/일 = 자세비율 ${ratio} × 활동 ${am}분/일`;
    return `${pdStr} ${unit || ''} = 자세비율 ${ratio} × 활동 ${am}분/일`;
  };

  // "왜 이 값?" 근거 패널. jobEv 없으면(mock·이전 세션) fallback 안내(영속화 안 하는 설계 표현).
  const renderEvidencePanel = (jobEv, unit) => {
    if (!jobEv) {
      return (
        <div className="muted" style={{ fontSize: 12, marginTop: 4, paddingLeft: 12 }}>
          근거 정보는 현재 분석 세션에서만 표시됩니다. 다시 분석하면 확인할 수 있습니다.
        </div>
      );
    }
    return (
      <div style={{ fontSize: 12, marginTop: 4, paddingLeft: 12, borderLeft: '2px solid var(--border, #ddd)' }}>
        <div className="muted">집계 방식: <code>{jobEv.aggregationMethod}</code>{jobEv.analysisJobIds?.length > 0 && <> · 분석 job: {jobEv.analysisJobIds.join(', ')}</>}</div>
        {(jobEv.contributions || []).map((c, i) => {
          const ev = c.evidence || {};
          const formula = contribFormula(ev, c.perDayValue, unit);
          const bd = ev.confidenceBreakdown;
          const adopted = ev.fusion?.adopted;
          return (
            <div key={i} style={{ marginTop: 4 }}>
              <b>{c.processName || '(공정)'}</b> <span className="muted">공정 점유율 {c.sharePercent}%</span>
              {formula && <div>· {formula}</div>}
              {adopted && <div className="muted">· 채택 시점: {adopted.viewpoint || '미지정'}{adopted.jobId ? ` (job ${adopted.jobId})` : ''}{ev.fusion?.candidates?.length > 1 ? ` / 후보 ${ev.fusion.candidates.length}개` : ''}</div>}
              {bd && (
                <div className="muted">· 신뢰도 성분: {['keypoint', 'visibility', 'tracking', 'viewpoint', 'usableFrameRatio']
                  .filter((k) => bd[k] != null)
                  .map((k) => `${k} ${Math.round(bd[k] * 100)}%`).join(' / ')}</div>
              )}
              {ev.segments?.length > 0 && <div className="muted">· 근거 구간 {ev.segments.length}개</div>}
              {ev.warnings?.length > 0 && <div style={{ color: '#b26a00' }}>· 경고: {ev.warnings.join(', ')}</div>}
            </div>
          );
        })}
        <div className="muted" style={{ marginTop: 4, fontStyle: 'italic' }}>
          ※ 신뢰도·경고는 실험값입니다(자동제안 차단 임계값은 검증 전까지 비활성). 값은 전문의가 확정합니다.
        </div>
      </div>
    );
  };

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
                  const up = uploads[c.id];
                  const canDetect = canDetectClip({ serverMode, fixtureMode, clip: c, upload: up });
                  const det = canDetect ? validDetection(c) : null;
                  return (
                    <div key={c.id} style={{ marginBottom: 6 }}>
                      <span style={{ display: 'inline-flex', gap: 4, marginRight: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select value={c.viewpoint} onChange={(e) => editClip(c.id, { viewpoint: e.target.value })}>
                          {VIEWPOINTS.map((vp) => <option key={vp.value} value={vp.value}>{vp.label}</option>)}
                        </select>
                        {fixtureMode && (
                          <input type="text" placeholder="fixture 파일명(dev)" value={c.fixtureClipName || ''}
                            onChange={(e) => editClip(c.id, { fixtureClipName: e.target.value })} style={{ width: 150 }} />
                        )}
                        {/* 실 영상 업로드(서버 모드, fixture 파일명 미사용 클립) */}
                        {serverMode && !c.fixtureClipName && (
                          <>
                            <input type="file" accept="video/*" disabled={up?.status === 'uploading'}
                              onChange={(e) => uploadClipFile(c, p.id, e.target.files && e.target.files[0])} />
                            {up?.status === 'uploading' && <span className="muted" style={{ fontSize: 12 }}>업로드 {Math.round((up.progress || 0) * 100)}%</span>}
                            {up?.status === 'done' && <span className="muted" style={{ fontSize: 12, color: '#2e7d32' }}>업로드 완료</span>}
                            {up?.status === 'error' && <span className="muted" style={{ fontSize: 12, color: '#c62828' }}>업로드 실패</span>}
                          </>
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
                          <TargetPicker result={det.result} selectedId={det.selectedId} frameUrl={det.frameUrl} onSelect={(id) => chooseTarget(c, id)} />
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

        {/* 파이프라인 진행바(coarse) */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 14 }}>
          {PIPELINE_STEPS.map((label, i) => {
            const done = i < pipelineIndex;
            const active = i === pipelineIndex;
            return (
              <span key={label} style={{
                fontSize: 12, padding: '2px 8px', borderRadius: 12,
                border: `1px solid ${active ? '#2e7d32' : 'var(--border, #ddd)'}`,
                background: done ? '#e8f5e9' : (active ? '#f1f8e9' : 'transparent'),
                color: done || active ? '#2e7d32' : '#999',
              }}>{done ? '✓ ' : (active ? '▶ ' : '')}{label}</span>
            );
          })}
        </div>

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
                        const evKey = `${jf.sharedJobId}:${s.featureKey}`;
                        const expanded = expandedEvidence === evKey;
                        const jobEv = analysisEvidence.jobEvidenceBySharedJobId[jf.sharedJobId]?.[s.featureKey];
                        return (
                        <li key={s.featureKey} style={{ margin: '4px 0' }}>
                          <code>{s.featureKey}</code> → {String(s.suggestedValue)} {s.unit || ''}
                          <span style={{ marginLeft: 6, fontSize: 12, color: s.confidence >= 0.8 ? '#2e7d32' : '#b26a00' }}>
                            신뢰도 {Math.round(s.confidence * 100)}%
                          </span>
                          {refOnly && <span style={{ marginLeft: 6, fontSize: 12, color: '#b26a00' }} title="저신뢰 — 수기 확인 필요">참고만</span>}
                          {s.requiresManualReview && <span style={{ marginLeft: 6, fontSize: 12, color: '#b26a00' }}>수기확인</span>}
                          <button type="button" style={{ marginLeft: 6, fontSize: 12 }}
                            onClick={() => setExpandedEvidence(expanded ? null : evKey)}>
                            {expanded ? '근거 닫기' : '왜 이 값?'}
                          </button>
                          <button type="button" style={{ marginLeft: 8 }} disabled={busy || applyBlocked || refOnly}
                            onClick={() => applySuggestion(moduleId, { sharedJobId: jf.sharedJobId }, s, procIds, analysisProfile)}>
                            {serverMode ? '서버 적용' : '적용'}
                          </button>
                          {expanded && renderEvidencePanel(jobEv, s.unit)}
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

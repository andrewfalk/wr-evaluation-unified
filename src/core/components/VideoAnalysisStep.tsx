// [공유] 영상 분석 스텝 (6.0-3/6.0-4, mock-first). mock feature로 공정 정리 → 분석 →
// 제안 검토 → 적용/무시 → provenance/rollback 흐름. 인트라넷+synced 환자는 적용을
// 서버 경로(clip→job→apply, audit·영속화)로, 그 외는 로컬로 처리한다(§8.2/§8.12).
// 실제 추론은 M2에서 서버 셸에 연결된다.
import { useMemo, useState, useRef, useEffect } from 'react';
import { generateMockFeatures } from '../services/videoMock';
import {
  REPETITION_FEATURE_KEYS, REPETITION_PROFILES, HAND_WRIST_FEATURE_KEYS, REPETITION_BAND_FEATURE_KEYS,
} from '../services/videoFeatureProfiles';
import { gateFeaturesByViewpoint } from '../services/videoViewpointConfig';
import { collectCandidateFeatures, applyFeatureToModule, rollbackAppliedInput } from '../services/videoProvenance';
import { DEFAULT_CONFIDENCE_THRESHOLDS } from '../services/videoConfidenceConfig';
import { isVideoAnalysisSupported, createClip, uploadClip, sampleDetectClip, selectTarget, fetchSampleFrame, fetchOverlay, closeReview } from '../services/videoAnalysisClient';
import { applyVideoFeatureViaServer } from '../services/videoServerApply';
import { runServerAnalysis } from '../services/videoAnalysisRun';
import { useWorkspaceLifetime } from '../../app/useWorkspaceLifetime';
import { SkeletonOverlay } from './SkeletonOverlay';
import { getModule } from '../moduleRegistry';
import { resolveAnalysisJobIds, buildAppliedRecipe } from '@wr/contracts/index';
import type {
  AppliedInputEntry, FeatureEvidence, InferenceDevice, ProcessEvidence, ProcessFeatures, SuppressedCandidate, UploadState,
  VideoAnalysisData, VideoClip, VideoFeatureMap, VideoProcess,
} from '../services/videoStepTypes';
import {
  buildVideoStatus, buildJobFeatures, buildJobEvidence, buildProcessEvidence, resolveSourceJobs, segmentsForJob, sourceJobLabel,
} from '../services/videoStepEvidence';
import { excludeTaskScopeCandidates } from '../services/videoStepCandidates';
import {
  MOCK_BUNDLE, requestedFeaturesForModules,
  shareTotalsByJob, clearDerived, addProcessVA, editProcessVA, removeProcessVA, addClipVA, editClipVA, removeClipVA, resolveApplyMode,
} from '../services/videoStepState';
import { EvidencePanel } from './video/EvidencePanel';
import { FlatCandidateList } from './video/FlatCandidateList';
import { SetupColumn } from './video/SetupColumn';
import { JobScopeReview } from './video/JobScopeReview';
import { TaskScopeReview } from './video/TaskScopeReview';
import { AppliedHistory } from './video/AppliedHistory';
import type {
  AnalysisEvidenceState, ApplyContext, DetectionState, ModuleSuggestion, OverlayState, PatientData, RequestError, ReviewRowContext,
  ServerAnalysisResult, SourceRecipe, VideoAnalysisStepProps,
} from './video/types';

// 순수 헬퍼와 타입은 services/videoStep*.ts로(P2-75c), 하위 화면은 video/로(P2-75d) 옮겼다 — 테스트 등이 이 파일에서 가져가므로
// 지금 이름 그대로 다시 내보낸다.
export { EvidencePanel } from './video/EvidencePanel';
export { FlatCandidateList } from './video/FlatCandidateList';
export type { VideoAnalysisStepProps } from './video/types';
export {
  buildVideoStatus, fmtNum, effectiveShare, buildJobFeatures, buildJobEvidence, buildProcessEvidence, resolveSourceJobs,
  segmentsForJob, contribFormula, sourceJobLabel,
} from '../services/videoStepEvidence';
export {
  candidateMinutesPerDay, candidateHoursPerDay, formatCandidateSubValue, flatCandidateRowRef, hasAnyFlatEvidence,
  excludeTaskScopeCandidates, flatCandidateLabel,
} from '../services/videoStepCandidates';
export {
  canDetectClip, requestedFeaturesForModules, tasksForJob, resolveTargetTaskId, shareTotalsByJob, clearDerived, addProcessVA,
  editProcessVA, removeProcessVA, addClipVA, editClipVA, removeClipVA, resolveApplyMode,
} from '../services/videoStepState';
export type {
  VideoProcess, VideoClip, VideoFeatureValue, VideoFeatureMap, ProcessFeatures, JobFeatures, CandidateFeature, AppliedInputEntry,
  VideoAnalysisData, ContributionEvidence, EvidenceContribution, FeatureEvidence, EvidenceByFeatureKey, ProcessEvidence, SourceJob,
} from '../services/videoStepTypes';

// ── 컴포넌트 ──────────────────────────────────────────────────────────────
export function VideoAnalysisStep({ shared, updateShared, updatePatient, activePatient, activeModules = [], session, settings, fixtureMode = false, serverConfig = null, onServerApplied }: VideoAnalysisStepProps) {
  // 화면 수명(계정 전환 수정 AS-4) — 화면이 내려가면 진행 중이던 분석·적용이 이전 세션으로 서버 요청·조회를 이어 가지 않는다.
  const { isAlive } = useWorkspaceLifetime();
  const va: VideoAnalysisData = shared?.videoAnalysis || {
    processes: [], clips: [], processFeatures: [], jobFeatures: [], candidateFeatures: [], appliedInputs: [],
  };
  const jobs = shared?.jobs || [];
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.jobName || '(직업 미지정)';
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
  // jobId → 서버 산출 recipe(§8.11, 6.0-9). 적용 시 source job들의 recipe로 entry recipe를 만든다(서버 검증 대조).
  const [analysisRecipes, setAnalysisRecipes] = useState<Record<string, SourceRecipe>>({});
  // 제안 행별 수정 사유 메모(시범 운영 피드백, 정책 B). rowKey→text. 적용 시 appliedInputs.editReason으로 영속.
  const [applyNotes, setApplyNotes] = useState<Record<string, string>>({});
  const [missingActiveTime, setMissingActiveTime] = useState<Record<string, string[]>>({}); // { processId: featureKey[] }
  // 대상자 선택(§8.7, PR D2b): 클립별 { serverClipId, result, selectedId, clipKey }. 환자 JSONB 미저장(전송 X).
  const [detection, setDetection] = useState<Record<string, DetectionState>>({}); // { [clipMetaId]: {...} }
  const [detecting, setDetecting] = useState<string | null>(null); // 진행 중 clipMetaId
  // 실 업로드(M3-7a): 클립별 { serverClipId, fileName, progress, status }. UI 임시 상태(환자 JSONB·경로·Blob 미저장).
  const [uploads, setUploads] = useState<Record<string, UploadState>>({}); // { [clipMetaId]: {...} }
  // 근거 패널(B2 선행): "왜 이 값?" evidence. **transient만** — shared.videoAnalysis에 저장 안 함(영속화 차단).
  // 새로고침/환자전환/입력변경 시 사라짐(의도) → 부재 제안행은 fallback 안내.
  const [analysisEvidence, setAnalysisEvidence] = useState<AnalysisEvidenceState>({ jobEvidenceBySharedJobId: {}, processEvidenceByProcessId: {}, suppressedCandidates: [], deviceByProcessId: {} });
  const [expandedEvidence, setExpandedEvidence] = useState<string | null>(null); // 펼친 제안 키 `${sharedJobId}:${featureKey}`
  // 골격 검수 overlay(6.0-8): transient — overlay 데이터 캐시는 jobId→{loading,data,error,closed},
  // 펼친 패널은 row+job 복합키 1개(같은 job을 쓰는 여러 feature 행에서 패널 중복 노출 방지). 영속화 안 함.
  const [overlayByJob, setOverlayByJob] = useState<Record<string, OverlayState>>({});
  const [expandedOverlay, setExpandedOverlay] = useState<string | null>(null); // `${rowKey}::${jobId}` | null
  // task-scope 적용 대상 task: `${processId}:${moduleId}` → taskId. transient(같은 세션 내 적용용).
  // 직업에 그 모듈 task가 1개면 자동, 여러 개면 사용자가 선택. 환자 전환 시 reset.
  const [taskTargets, setTaskTargets] = useState<Record<string, string>>({});
  const resetEvidence = () => {
    setAnalysisEvidence({ jobEvidenceBySharedJobId: {}, processEvidenceByProcessId: {}, suppressedCandidates: [], deviceByProcessId: {} });
    setExpandedEvidence(null);
    setOverlayByJob({});
    setExpandedOverlay(null);
    setTaskTargets({});
  };

  // 골격 검수 열기/닫기(토글). 패널은 클릭한 행(overlayKey)에만, 데이터는 jobId로 캐시 공유.
  // 처음 열 때 fetchOverlay로 적재(404=검수 자료 없음 → error 표시).
  const toggleOverlay = async (overlayKey: string, jobId: string) => {
    if (expandedOverlay === overlayKey) { setExpandedOverlay(null); return; }
    setExpandedOverlay(overlayKey);
    const cur = overlayByJob[jobId];
    if (cur && (cur.data || cur.loading || cur.closed)) return; // 이미 적재/로딩/종료됨
    setOverlayByJob((m) => ({ ...m, [jobId]: { loading: true } }));
    try {
      const payload = await fetchOverlay(jobId, { session, settings });
      setOverlayByJob((m) => ({ ...m, [jobId]: payload ? { data: payload } : { error: '검수 자료가 없습니다(다시 분석 필요).' } }));
    } catch (e) {
      setOverlayByJob((m) => ({ ...m, [jobId]: { error: (e as Error)?.message || '검수 자료를 불러오지 못했습니다.' } }));
    }
  };

  // 검수 종료(6.0-8, job 단위): 서버 200(실제 회수)일 때만 closed 처리(다른 job 보존). 실패면 패널 유지+오류.
  const endReview = async (jobId: string) => {
    try {
      await closeReview(jobId, { session, settings }); // 성공(2xx)만 아래로 진행
    } catch (e) {
      // requestJson 에러는 e.status·e.data만 갖는다(e.code 아님). 서버가 실제로 안 지웠으므로 닫지 않는다.
      const code = (e as RequestError)?.data?.code || (e as RequestError)?.data?.error?.code;
      const msg = code === 'JOB_NOT_READY' ? '분석이 진행 중이라 종료할 수 없습니다.' : '검수 종료에 실패했습니다. 잠시 후 다시 시도하세요.';
      setOverlayByJob((m) => ({ ...m, [jobId]: { ...m[jobId], error: msg } })); // 패널 유지(자료 보존)
      return;
    }
    setOverlayByJob((m) => ({ ...m, [jobId]: { closed: true } }));
    setExpandedOverlay((k) => (k && k.endsWith(`::${jobId}`) ? null : k));
  };

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
  const clipKeyOf = (clipMeta: VideoClip) => clipMeta.fixtureClipName || uploads[clipMeta.id]?.serverClipId || null;
  // detection이 현재 클립 출처와 일치할 때만 유효(fixture명/업로드 변경·clip 삭제 시 stale → 무시). 무효화-at-use.
  const validDetection = (clipMeta: VideoClip) => {
    const d = detection[clipMeta.id];
    return d && d.clipKey === clipKeyOf(clipMeta) ? d : null;
  };

  const jobScopeModules = activeModules.filter((m) => getModule(m)?.videoMappingConfig?.scope === 'job');
  // task-scope(경추·척추): 공정≈task 1:1 → 집계 없이 공정별로 렌더하고 task에 직접 적용한다(§8.6.2).
  // 경추·척추는 작업 갯수·이름이 서로 달라 묶지 않고 모듈별로 독립 처리한다.
  const taskScopeModules = activeModules.filter((m) => getModule(m)?.videoMappingConfig?.scope === 'task');
  const shareTotals = useMemo(() => shareTotalsByJob(va.processes), [va.processes]);

  const updateVA = (mutator: (v: VideoAnalysisData) => VideoAnalysisData) => updateShared({ ...shared, videoAnalysis: mutator(va) });

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
  const editProcess = (id: string, patch: Partial<VideoProcess>) => updateVA((v) => editProcessVA(v, id, patch));
  const removeProcess = (id: string) => updateVA((v) => removeProcessVA(v, id));
  const addClip = (processId: string) => updateVA((v) => addClipVA(v, processId));
  const editClip = (id: string, patch: Partial<VideoClip>) => updateVA((v) => editClipVA(v, id, patch));
  const dropDetection = (clipMetaId: string) => {
    invalidateDerived(); // 대상자 무효화 → 파생결과·evidence stale
    setDetection((d) => {
      const n = { ...d };
      if (n[clipMetaId]?.frameUrl) URL.revokeObjectURL(n[clipMetaId].frameUrl); // objectURL 누수 방지
      delete n[clipMetaId];
      return n;
    });
  };
  const dropUpload = (clipMetaId: string) => setUploads((u) => { const n = { ...u }; delete n[clipMetaId]; return n; });
  const removeClip = (id: string) => { dropDetection(id); dropUpload(id); updateVA((v) => removeClipVA(v, id)); };

  // ── 실 영상 업로드(M3-7a) ── createClip(analysis_upload) → uploadClip(진행률). 완료 시 serverClipId 보관.
  const uploadClipFile = async (clipMeta: VideoClip, processId: string, file: File | null) => {
    if (!file) return;
    setAnalysisError('');
    dropDetection(clipMeta.id); // 새 업로드 → 기존 detection 무효화.
    setUploads((u) => ({ ...u, [clipMeta.id]: { fileName: file.name, progress: 0, status: 'uploading', serverClipId: null } }));
    try {
      const clip = await createClip(activePatient, { processId, purpose: 'analysis_upload', session, settings });
      await uploadClip(clip.clipId, file, {
        session, settings,
        onProgress: ({ loaded, total }: { loaded: number; total: number }) =>
          setUploads((u) => ({ ...u, [clipMeta.id]: { ...u[clipMeta.id], progress: total ? loaded / total : 0 } })),
      });
      setUploads((u) => ({ ...u, [clipMeta.id]: { ...u[clipMeta.id], serverClipId: clip.clipId, progress: 1, status: 'done' } }));
    } catch (e) {
      setUploads((u) => ({ ...u, [clipMeta.id]: { ...u[clipMeta.id], status: 'error' } }));
      setAnalysisError((e as Error)?.message || '영상 업로드에 실패했습니다.');
    }
  };

  // ── 대상자 선택(§8.7, PR D2b) ── 대표 프레임 후보 탐지 → 박스 클릭 → select-target.
  const detectTarget = async (clipMeta: VideoClip, processId: string) => {
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
      setAnalysisError((e as Error)?.message || '대상자 탐지에 실패했습니다.');
    } finally {
      setDetecting(null);
    }
  };
  const chooseTarget = async (clipMeta: VideoClip, personId: string) => {
    const d = detection[clipMeta.id];
    if (!d) return;
    invalidateDerived(); // 대상자 재선택 → 기존 분석결과·evidence stale
    try {
      await selectTarget(d.serverClipId, personId, { session, settings });
      setDetection((prev) => ({ ...prev, [clipMeta.id]: { ...prev[clipMeta.id], selectedId: personId } }));
    } catch (e) {
      setAnalysisError((e as Error)?.message || '대상자 선택에 실패했습니다.');
    }
  };

  // 분석 산출(공통): processFeatures → jobFeatures/candidateFeatures 재구성 후 저장.
  // absolutePerDay: 서버 실분석은 절대 per-day(합산), mock은 공정점유율 가중.
  // processEvidence: "왜 이 값?" 근거(서버 실분석만 제공, mock은 빈 배열). va에 저장 안 하고 별도 state로.
  const commitAnalysis = (
    processFeatures: ProcessFeatures[],
    { absolutePerDay = false, processEvidence = [] }: { absolutePerDay?: boolean; processEvidence?: ProcessEvidence[] } = {},
  ) => {
    // 6.0-17: absolutePerDay(집계 시점 인자, 저장 안 됨)를 processFeatureAggregationMode(저장됨)로
    // 변환 — 리로드 후에도 공정별 서브행 기여값을 이 분석과 같은 방식으로 재계산할 수 있게 한다.
    const processFeatureAggregationMode = absolutePerDay ? 'absolutePerDay' : 'shareWeighted';
    const jobFeatures = buildJobFeatures(va.processes, processFeatures, { processFeatureAggregationMode });
    const candidateFeatures = processFeatures.flatMap((pf) => {
      const cands = collectCandidateFeatures(pf.features, { processIds: [pf.processId] } as Parameters<typeof collectCandidateFeatures>[1]);
      // 반복빈도(어깨/팔꿈치)는 상지반복/손목 profile에서만, 손목(반복+각도)은 손목 profile에서만,
      // 어깨 반복 밴드별 시간합 Left/Right(6.0-16)는 상지반복 profile에서만 노출(저fps·비매칭 profile은
      // 미신뢰). 6.0-11/6.0-10/6.0-16. 정상 경로에서는 이미 요청 생성·mock 단계에서 걸러지지만, raw
      // result_features는 profile 무관하게 값을 포함할 수 있어(§"검증된 사실") 여기서 한 번 더 방어한다.
      const profile = ((va.processes.find((p) => p.id === pf.processId) || {}) as Partial<VideoProcess>).analysisProfile;
      return cands.filter((c) => {
        if (REPETITION_FEATURE_KEYS.has(c.featureKey)) return REPETITION_PROFILES.has(profile as string);
        if (HAND_WRIST_FEATURE_KEYS.has(c.featureKey)) return profile === 'hand-wrist';
        if (REPETITION_BAND_FEATURE_KEYS.has(c.featureKey)) return profile === 'repetition-upper-limb';
        return true;
      });
    });
    updateVA((v) => ({ ...v, processFeatures, jobFeatures, candidateFeatures, processFeatureAggregationMode }));
    // evidence는 transient state(영속화 차단). job-scope=직업단위, task-scope=공정단위 lookup map.
    const jobEvidenceBySharedJobId = buildJobEvidence(va.processes, processFeatures, processEvidence);
    const processEvidenceByProcessId = buildProcessEvidence(va.processes, processFeatures, processEvidence);
    // 시점 하드 게이트로 드롭된 손목 각도 안내(process-level → flat 집계, featureKey 중복 제거). transient.
    const suppressedCandidates: SuppressedCandidate[] = [];
    const seenSuppressed = new Set();
    // 6.0-12: 공정별 실제 실행 디바이스(검토 UI 배지). transient.
    const deviceByProcessId: Record<string, InferenceDevice> = {};
    for (const pe of processEvidence) {
      for (const s of pe.suppressedCandidates || []) {
        if (seenSuppressed.has(s.featureKey)) continue;
        seenSuppressed.add(s.featureKey);
        suppressedCandidates.push(s);
      }
      if (pe.inferenceDevice) deviceByProcessId[pe.processId] = pe.inferenceDevice;
    }
    setAnalysisEvidence({ jobEvidenceBySharedJobId, processEvidenceByProcessId, suppressedCandidates, deviceByProcessId });
  };

  // ── 분석 실행 ── 서버 모드=fixture 실추론+per-day 환산, 그 외=mock. 적용과 분리(추론은 여기서만).
  const runAnalysis = async () => {
    setAnalysisError('');
    setMissingActiveTime({});
    resetEvidence(); // 새 분석 시작 → 이전 근거 비움(성공 시 commitAnalysis가 다시 채움)
    if (!serverMode) {
      const requested = requestedFeaturesForModules(activeModules);
      // mock도 서버 융합과 동형으로 공정의 클립 시점 집합 기준 손목 각도 하드 게이트(6.0-10).
      const processFeatures: ProcessFeatures[] = [];
      const processEvidence: ProcessEvidence[] = [];
      for (const p of va.processes) {
        const raw = generateMockFeatures(requested, p.analysisProfile);
        const viewpoints = (va.clips || []).filter((c) => c.processId === p.id).map((c) => c.viewpoint);
        const { features, suppressedCandidates } = gateFeaturesByViewpoint(raw, viewpoints) as { features: VideoFeatureMap; suppressedCandidates: SuppressedCandidate[] };
        processFeatures.push({ processId: p.id, features });
        if (suppressedCandidates.length > 0) processEvidence.push({ processId: p.id, analysisJobIds: [], suppressedCandidates });
      }
      setAnalysisBundle(MOCK_BUNDLE);
      setAnalysisRecipes({}); // mock 경로는 서버 recipe 없음(로컬 적용은 검증 게이트 미적용).
      commitAnalysis(processFeatures, { processEvidence });
      return;
    }
    setAnalyzing(true);
    try {
      // 분석에 쓸 serverClipId 전달: ① 유효 detection(선택까지) 우선, ② 없으면 업로드 완료 clip(대상=dominant).
      // stale detection(fixture/업로드 변경·삭제)은 validDetection이 거른다.
      const detections: Record<string, { serverClipId: string; selectedId?: string }> = {};
      for (const c of va.clips || []) {
        const d = validDetection(c);
        if (d?.serverClipId && d.selectedId) {
          detections[c.id] = { serverClipId: d.serverClipId, selectedId: d.selectedId };
        } else {
          const up = uploads[c.id];
          if (up?.serverClipId && up.status === 'done') detections[c.id] = { serverClipId: up.serverClipId };
        }
      }
      const { processFeatures, processEvidence, missingActiveTime: missing, bundleVersion, recipesByJobId, errors } =
        await runServerAnalysis(activePatient as object, va, { activeModules, session, settings, detections, serverConfig, shouldContinue: isAlive }) as ServerAnalysisResult;
      setAnalysisBundle(bundleVersion || MOCK_BUNDLE);
      setAnalysisRecipes(recipesByJobId || {}); // 적용 시 source job recipe 대조용(§8.11).
      setMissingActiveTime(missing);
      commitAnalysis(processFeatures, { absolutePerDay: true, processEvidence });
      if (errors.length > 0) setAnalysisError(errors.map((e) => e.message).join(' / '));
    } catch (e) {
      setAnalysisError((e as Error)?.message || '분석에 실패했습니다.');
    } finally {
      setAnalyzing(false);
    }
  };

  // ── 제안 적용 / 되돌리기 ──
  // 서버 모드: clip→job→apply(영속화·audit) 후 서버 동기화 환자를 목록에 반영(per-field, apply마다 job).
  // 로컬 모드: updatePatient로 즉시 반영(standalone/web).
  const applySuggestion = async (
    moduleId: string, ctx: ApplyContext, s: ModuleSuggestion, processIds: string[] | undefined,
    analysisProfile: string | undefined, editReason: string | undefined,
  ) => {
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
    // source job들의 서버 recipe로 entry recipe·bundle 조립(§8.11, 6.0-9). map/vp는 클라 상수 overlay(stale 탐지).
    // 서버 recipe가 없으면(mock/로컬) 기존 bundle 문자열 폴백.
    const { recipe: appliedRecipe, analysisBundleVersion: recipeBundle } =
      buildAppliedRecipe(analysisJobIds.map((id) => analysisRecipes[id]));
    const bundleForApply = recipeBundle || analysisBundle;
    if (!serverMode) {
      updatePatient((d) => (applyFeatureToModule({ data: d }, {
        moduleId, ctx, featureKey: s.featureKey,
        suggestedValue: s.suggestedValue, confidence: s.confidence,
        processIds: processIds || [], analysisJobIds, analysisBundleVersion: bundleForApply, recipe: appliedRecipe, editReason, appliedBy,
      } as Parameters<typeof applyFeatureToModule>[1]).patient as { data: PatientData }).data);
      return;
    }
    setBusy(true);
    setApplyError('');
    try {
      const serverPatient = await applyVideoFeatureViaServer(
        activePatient as Parameters<typeof applyVideoFeatureViaServer>[0],
        { moduleId, ctx, featureKey: s.featureKey, suggestedValue: s.suggestedValue, confidence: s.confidence, processIds: processIds || [], analysisJobIds, analysisBundleVersion: bundleForApply, recipe: appliedRecipe, editReason, analysisProfile },
        { session, settings, appliedBy, shouldContinue: isAlive }
      );
      onServerApplied?.(serverPatient);
    } catch (e) {
      setApplyError((e as Error)?.message || '적용에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };
  // rollback은 로컬 적용에만(서버 apply 후 rollback은 M3 — §8.12 경계).
  const rollback = (entry: AppliedInputEntry) => updatePatient((d) => (rollbackAppliedInput({ data: d }, d.shared.videoAnalysis.appliedInputs.indexOf(entry)) as { data: PatientData }).data);

  const hasAnalysis = (va.jobFeatures || []).length > 0 || (va.processFeatures || []).length > 0;
  // 시범 운영(정책 B): confidence 임계값(6.0-B2)이 아직 배선 안 됨 = 정확도 미검증 상태.
  // 임계값이 채워지면(검증 통과·별도 PR) 자동으로 배너가 사라진다.
  const pilotMode = Object.keys(DEFAULT_CONFIDENCE_THRESHOLDS).length === 0;

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

  // "왜 이 값?" 근거 패널 — 렌더는 모듈 레벨 EvidencePanel(테스트 가능하도록 추출).
  const renderEvidencePanel = (jobEv: FeatureEvidence | null | undefined, unit: string | null | undefined) => <EvidencePanel jobEv={jobEv} unit={unit} />;

  // 골격 검수 sub-block(suggestion·candidate 행 공용). 행(rowKey) 소속 source job별 overlay 토글.
  const renderSkeletonReview = (rowKey: string, jobEv: FeatureEvidence | null | undefined) => {
    const sourceJobs = serverMode ? resolveSourceJobs(jobEv) : []; // 서버 artifact 필요
    if (sourceJobs.length === 0) return null;
    const openSj = sourceJobs.find((sj) => expandedOverlay === `${rowKey}::${sj.jobId}`);
    // 아래에서 openOv는 openSj가 있을 때만 읽는다.
    const openOv = (openSj ? (overlayByJob[openSj.jobId] || {}) : null) as OverlayState;
    return (
      <div className="va-skel">
        <div className="va-skel-actions">
          {sourceJobs.map((sj) => {
            const ov = (overlayByJob[sj.jobId] || {}) as OverlayState;
            const open = expandedOverlay === `${rowKey}::${sj.jobId}`;
            return (
              <button key={sj.jobId} type="button" className="btn btn-secondary btn-sm"
                data-readonly-allow
                onClick={() => toggleOverlay(`${rowKey}::${sj.jobId}`, sj.jobId)} disabled={ov.closed}
                title={ov.closed ? '검수 자료 회수됨' : '중립 배경 골격으로 검수'}>
                {open ? '골격 닫기' : `골격 검수: ${sourceJobLabel(sj)}`}{ov.closed ? ' (회수됨)' : ''}
              </button>
            );
          })}
        </div>
        {openSj && (
          <div className="va-skel-body">
            {openOv.loading && <p className="va-skel-msg">골격 불러오는 중…</p>}
            {openOv.error && <p className="va-skel-msg is-error">{openOv.error}</p>}
            {openOv.data && (
              <>
                <SkeletonOverlay overlay={openOv.data} activeSegments={segmentsForJob(jobEv, openSj.jobId)} session={session} settings={settings} />
                <div className="va-skel-end">
                  <button type="button" className="btn btn-secondary btn-sm"
                    onClick={() => endReview(openSj.jobId)}>
                    이 분석 검수 종료(자료 회수)
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  // 검토 행(SuggestionRow·CandidateRow)이 읽는 본체 값 — 렌더 함수 시절 클로저로 읽던 것 그대로(P2-75f).
  const reviewRow: ReviewRowContext = {
    expandedEvidence, setExpandedEvidence, applyNotes, setApplyNotes, busy, applyBlocked, applySuggestion, renderEvidencePanel,
    renderSkeletonReview,
  };


  return (
    <div className="panel">
      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">🎥</span>작업 영상 인간공학 분석{serverMode && fixtureMode ? ' (시험)' : serverMode ? '' : ' (예시)'}</h2>
            <p className="section-description">
              {serverMode
                ? '조사 서류 기반으로 공정을 정리하고 영상 분석을 실행합니다. '
                : '조사 서류 기반으로 공정을 정리하고 예시 분석을 실행합니다. 예시 데이터로 생성한 결과이며 실제 영상에서 산출한 값이 아닙니다. '}
              결과는 항상 <b>제안값</b>이며 전문의가 확정합니다.
              {serverMode && ' 적용 내역은 서버에 기록됩니다.'}
              {!serverSupported && ' (인트라넷 외 모드: 로컬 적용만)'}
            </p>
            {applyBlocked && (
              <p className="muted" style={{ color: 'var(--color-warning)' }}>
                ⚠ 이 환자는 서버에 동기화되지 않았습니다. 먼저 저장·동기화하면 영상 분석 결과를 적용할 수 있습니다.
              </p>
            )}
            {applyError && <p className="muted" style={{ color: 'var(--color-danger)' }}>오류: {applyError}</p>}
          </div>
        </div>

        {pilotMode && (
          <div role="note" style={{
            margin: '4px 0 12px', padding: '8px 12px', fontSize: 13, lineHeight: 1.5,
            border: '1px solid var(--color-warning)', borderRadius: 6,
            background: 'rgba(240, 173, 78, 0.10)',
          }}>
            ⚠ <b>시범 운영</b> — 영상 분석값은 정확도 검증 전입니다. 모든 값은 <b>참고용</b>이며,
            전문의가 직접 확인·확정해야 합니다. 어긋나거나 이상한 제안은 적용 시 <b>수정 사유 메모</b>로 남겨주시면 검증·개선에 활용됩니다.
          </div>
        )}

        {(() => {
          const st = buildVideoStatus(va, { shareTotals, missingActiveTime, jobScopeModules, taskScopeModules, analyzing, hasAnalysis });
          return (
            <div className="va-statusbar">
              <span className="va-status-chip">공정 <span className="va-status-chip-num">{st.processCount}</span></span>
              <span className="va-status-chip">클립 <span className="va-status-chip-num">{st.clipCount}</span></span>
              <span className={`va-status-chip${st.analysisState === '분석 완료' ? ' tone-safe' : ''}`}>{st.analysisState}</span>
              {hasAnalysis && <span className="va-status-chip tone-info">제안 <span className="va-status-chip-num">{st.suggestionCount}</span></span>}
              {st.warningCount > 0 && <span className="va-status-chip tone-warning">경고 {st.warningCount}</span>}
            </div>
          );
        })()}
        {analysisError && <p className="muted" style={{ color: 'var(--color-danger)' }}>분석 오류: {analysisError}</p>}
        {Object.keys(missingActiveTime).length > 0 && (
          <p className="muted" style={{ color: 'var(--color-warning)' }}>
            ⚠ 일부 공정의 활동시간(분/일)이 비어 있어 per-day 제안을 만들지 못했습니다. 공정 &quot;활동시간&quot;을 입력 후 다시 분석하세요.
          </p>
        )}

        <div className="va-layout">
          {/* 왼쪽: 공정·클립 셋업 */}
          <SetupColumn
            va={va} jobs={jobs} activeModules={activeModules} shareTotals={shareTotals} analysisEvidence={analysisEvidence}
            jobName={jobName} uploads={uploads} serverMode={serverMode} fixtureMode={fixtureMode} detecting={detecting}
            analyzing={analyzing} pipelineSteps={PIPELINE_STEPS} pipelineIndex={pipelineIndex} validDetection={validDetection}
            addProcess={addProcess} editProcess={editProcess} removeProcess={removeProcess} addClip={addClip} editClip={editClip}
            removeClip={removeClip} uploadClipFile={uploadClipFile} detectTarget={detectTarget} chooseTarget={chooseTarget}
            runAnalysis={runAnalysis}
          />

          {/* 오른쪽: 제안 검토 */}
          <div className="va-col va-review-col">
            <div className="va-col-title">검토 — 제안{!hasAnalysis && <small>분석 실행 후 표시됩니다</small>}</div>
            {!hasAnalysis && <p className="evaluation-empty-state">공정·클립을 정리하고 <b>분석 실행</b>을 누르면 제안이 여기에 표시됩니다.</p>}

        {/* 3) 제안 검토 (job-scope) */}
        {hasAnalysis && (
          <JobScopeReview va={va} jobScopeModules={jobScopeModules} jobName={jobName} analysisEvidence={analysisEvidence} review={reviewRow} />
        )}

        {/* 3-task) 제안 검토 (task-scope — 경추·척추, 공정≈task 1:1). 모듈별 독립 + 대상 task 선택. */}
        {hasAnalysis && taskScopeModules.length > 0 && (
          <TaskScopeReview
            va={va} taskScopeModules={taskScopeModules} activePatient={activePatient} taskTargets={taskTargets}
            setTaskTargets={setTaskTargets} analysisEvidence={analysisEvidence} jobName={jobName} review={reviewRow}
          />
        )}

        {/* 4) candidate (참고만) — task-scope 모듈(경추·척추) candidate는 위 "작업 단위"에서 표시하므로 제외.
             6.0-18: FlatCandidateList로 추출 — 골격 검수·근거 배선(renderSkeletonReview/renderEvidencePanel
             은 이 컴포넌트 밖 state 클로저라 render prop으로 주입). */}
        <FlatCandidateList
          candidates={excludeTaskScopeCandidates(va.candidateFeatures || [], taskScopeModules)}
          processes={va.processes}
          processEvidenceByProcessId={analysisEvidence.processEvidenceByProcessId}
          suppressedCandidates={analysisEvidence.suppressedCandidates || []}
          serverMode={serverMode}
          expandedEvidence={expandedEvidence}
          onToggleEvidence={setExpandedEvidence}
          renderEvidencePanel={renderEvidencePanel}
          renderSkeletonReview={renderSkeletonReview}
        />
          </div>{/* /va-col 검토 */}
        </div>{/* /va-layout */}

        {/* 5) 적용 이력 + 되돌리기 (전체폭) */}
        {(va.appliedInputs || []).length > 0 && (
          <AppliedHistory va={va} serverMode={serverMode} rollback={rollback} />
        )}
      </section>
    </div>
  );
}

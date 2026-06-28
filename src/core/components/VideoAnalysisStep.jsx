// [공유] 영상 분석 스텝 (6.0-3/6.0-4, mock-first). mock feature로 공정 정리 → 분석 →
// 제안 검토 → 적용/무시 → provenance/rollback 흐름. 인트라넷+synced 환자는 적용을
// 서버 경로(clip→job→apply, audit·영속화)로, 그 외는 로컬로 처리한다(§8.2/§8.12).
// 실제 추론은 M2에서 서버 셸에 연결된다.
import { useMemo, useState, useRef, useEffect } from 'react';
import { generateMockFeatures, REPETITION_FEATURE_KEYS, REPETITION_PROFILES, HAND_WRIST_FEATURE_KEYS } from '../services/videoMock';
import { gateFeaturesByViewpoint } from '../services/videoViewpointConfig';
import { aggregateProcessFeatures, getAggregationMethod } from '../services/videoAggregate';
import {
  getModuleSuggestions,
  getModuleCandidates,
  collectCandidateFeatures,
  applyFeatureToModule,
  rollbackAppliedInput,
} from '../services/videoProvenance';
import { DEFAULT_CONFIDENCE_THRESHOLDS } from '../services/videoConfidenceConfig';
import { isVideoAnalysisSupported, createClip, uploadClip, sampleDetectClip, selectTarget, fetchSampleFrame, fetchOverlay, closeReview } from '../services/videoAnalysisClient';
import { applyVideoFeatureViaServer } from '../services/videoServerApply';
import { runServerAnalysis } from '../services/videoAnalysisRun';
import { TargetPicker } from './TargetPicker';
import { SkeletonOverlay } from './SkeletonOverlay';
import { getModule } from '../moduleRegistry';
import { VIDEO_FEATURE_TARGETS, resolveAnalysisJobIds, buildAppliedRecipe } from '@contracts/index';

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
 * 상태바 표시용 파생 수치(새 React state 없음 — 렌더 시점 계산). 표시 전용이라 결정적 정의:
 * - suggestionCount: 직업단위(jobFeatures×jobScopeModules) + 작업단위(processFeatures×taskScopeModules) getModuleSuggestions 합.
 *   candidate 제외. "제안 N" 라벨(actionable 여부—참고만·대상작업 미선택·미동기화—는 세지 않음).
 * - warningCount: 점유율 합 ≠100 직업 수 + missingActiveTime에서 누락 feature가 실제 있는 공정 수(빈 배열 방어).
 */
export function buildVideoStatus(va, {
  shareTotals = {}, missingActiveTime = {}, jobScopeModules = [], taskScopeModules = [],
  analyzing = false, hasAnalysis = false,
} = {}) {
  let suggestionCount = 0;
  for (const jf of va.jobFeatures || []) {
    for (const m of jobScopeModules) suggestionCount += getModuleSuggestions(jf.features, m).length;
  }
  for (const pf of va.processFeatures || []) {
    for (const m of taskScopeModules) suggestionCount += getModuleSuggestions(pf.features, m).length;
  }
  const shareWarn = Object.values(shareTotals).filter((t) => t !== 100).length;
  const activeTimeWarn = Object.values(missingActiveTime).filter((a) => a && a.length > 0).length;
  return {
    processCount: (va.processes || []).length,
    clipCount: (va.clips || []).length,
    suggestionCount,
    warningCount: shareWarn + activeTimeWarn,
    analysisState: analyzing ? '분석 중' : (hasAnalysis ? '분석 완료' : '분석 전'),
  };
}

// 표시용 숫자 — 모든 지표를 소수점 1자리로 통일(정수·비숫자는 그대로). 부동소수 꼬리 제거.
export function fmtNum(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 10) / 10 : v;
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
        // 이 공정의 원본 분석 job(들) — fusion evidence 없는 contribution의 골격 검수 fallback(6.0-8).
        analysisJobIds: (pe.analysisJobIds || []).slice(),
        evidence: ev,
      });
      for (const jid of pe.analysisJobIds || []) {
        if (entry.analysisJobIds.indexOf(jid) < 0) entry.analysisJobIds.push(jid);
      }
    }
  }
  return byJob;
}

/**
 * task-scope(경추·척추): 공정별 근거를 공정(processId) 단위로 묶는다. 집계가 없으므로 contribution은
 * 공정 1개뿐 — buildJobEvidence와 같은 jobEv-like 형태라 renderEvidencePanel·resolveSourceJobs를 그대로 쓴다.
 * @returns {object} processEvidenceByProcessId[processId][featureKey] = { aggregationMethod, contributions, analysisJobIds }
 */
export function buildProcessEvidence(processes = [], processFeatures = [], processEvidence = []) {
  const featuresByProcess = {};
  for (const pf of processFeatures) featuresByProcess[pf.processId] = pf.features || {};
  const byProc = {};
  for (const pe of processEvidence) {
    const proc = processes.find((p) => p.id === pe.processId);
    if (!proc) continue;
    const jobIds = (pe.analysisJobIds || []).slice();
    const featMap = byProc[pe.processId] || (byProc[pe.processId] = {});
    for (const [featureKey, ev] of Object.entries(pe.evidenceByFeatureKey || {})) {
      featMap[featureKey] = {
        aggregationMethod: 'task(1:1)',
        analysisJobIds: jobIds.slice(),
        contributions: [{
          processId: proc.id,
          processName: proc.name,
          sharePercent: proc.shiftSharePercent,
          perDayValue: featuresByProcess[pe.processId]?.[featureKey]?.value,
          analysisJobIds: jobIds.slice(),
          evidence: ev,
        }],
      };
    }
  }
  return byProc;
}

const VIEWPOINT_LABEL = { sagittal: '측면', frontal: '정면', other: '기타' };

/**
 * feature 한 항목(jobEv)의 골격 검수 대상 source job 목록을 도출한다(6.0-8).
 * feature 값은 공정 합산·시점 융합으로 N개 job에서 오므로 단일 jobId를 붙이면 안 된다.
 * 우선순위: contribution.evidence.fusion.candidates(채택=adopted, 탈락=비교 시점) — 채택 job을 주 검수 대상으로,
 * 탈락 후보는 "비교 시점"으로 구분. fusion이 없으면(구 데이터) jobEv.analysisJobIds로 fallback.
 * @returns {Array<{jobId, processName, viewpoint, adopted}>} 채택 먼저 정렬, jobId 중복 제거.
 */
export function resolveSourceJobs(jobEv) {
  if (!jobEv) return [];
  const out = [];
  const seen = new Set();
  const pushJob = (jobId, processName, viewpoint, adopted) => {
    if (!jobId || seen.has(jobId)) return;
    seen.add(jobId);
    out.push({ jobId, processName: processName || null, viewpoint: viewpoint || null, adopted: !!adopted });
  };
  for (const c of jobEv.contributions || []) {
    const cands = c.evidence?.fusion?.candidates;
    if (Array.isArray(cands) && cands.length > 0) {
      for (const cand of cands) pushJob(cand?.jobId, c.processName, cand?.viewpoint, cand?.adopted);
    } else {
      // 이 contribution은 시점 융합 evidence가 없음(구/부분 evidence) → 공정 job으로 fallback(누락 방지).
      for (const jid of c.analysisJobIds || []) pushJob(jid, c.processName, null, true);
    }
  }
  // contribution이 전혀 없는 경우(구 데이터)만 feature 레벨 analysisJobIds로 최종 fallback.
  if (out.length === 0) {
    for (const jid of jobEv.analysisJobIds || []) pushJob(jid, null, null, true);
  }
  out.sort((a, b) => (b.adopted ? 1 : 0) - (a.adopted ? 1 : 0));
  return out;
}

// 골격 overlay(특정 source job)에 그 변수의 근거 구간(segments)을 매칭한다. evidence.segments는 채택(또는
// 단일) 클립 기준이라 그 job의 overlay일 때만 매칭 — 비교 시점 job은 구간 미보유라 빈 배열(하이라이트 없음).
export function segmentsForJob(jobEv, jobId) {
  if (!jobEv || !jobId) return [];
  for (const c of jobEv.contributions || []) {
    const ev = c.evidence || {};
    if (!Array.isArray(ev.segments) || ev.segments.length === 0) continue;
    const adoptedJobId = ev.fusion?.adopted?.jobId;
    const owns = adoptedJobId != null ? adoptedJobId === jobId : (c.analysisJobIds || []).indexOf(jobId) >= 0;
    if (owns) return ev.segments;
  }
  return [];
}

/**
 * task-scope 모듈의 적용 대상 task 후보(직업 기준). spine처럼 fallbackUnlinked면 매칭 task가 없을 때
 * 직업 미연결 레거시 task도 후보로 허용한다(모듈 extractFromModule fallback과 동일 규칙). cervical은 엄격.
 */
export function tasksForJob(moduleData, sharedJobId, { fallbackUnlinked = false } = {}) {
  const all = (moduleData && moduleData.tasks) || [];
  const linked = all.filter((t) => t.sharedJobId === sharedJobId);
  if (!linked.length && fallbackUnlinked) return all.filter((t) => !t.sharedJobId);
  return linked;
}

/**
 * 적용 대상 taskId 해석: 선택값(selectedTaskId)이 **현재 후보 목록에 실제 존재**할 때만 유효(stale 방어).
 * 없으면 후보가 1개일 때 자동 지정, 그 외 null(=대상 없음 → 적용 비활성).
 */
export function resolveTargetTaskId(tasks = [], selectedTaskId) {
  if (selectedTaskId != null && tasks.some((t) => String(t.id) === String(selectedTaskId))) return selectedTaskId;
  if (tasks.length === 1) return tasks[0].id;
  return null;
}

/**
 * candidate 비율(posture_ratio 0~1)을 공정 활동시간(분/일)으로 환산한 분/일. 활동시간 없으면 null.
 * 순수 함수(테스트 대상). 표시 전용 — candidate value 자체는 비율을 유지한다.
 */
export function candidateMinutesPerDay(ratio, activeMinutesPerDay) {
  if (activeMinutesPerDay == null || typeof ratio !== 'number') return null;
  return Math.round(ratio * activeMinutesPerDay);
}

/**
 * flat "참고 후보"에서 task-scope 모듈(경추·척추) candidate를 제외한다(작업 단위 섹션에서 표시하므로 중복 방지).
 * 렌더와 동일 경로를 테스트가 검증하도록 순수 함수로 분리.
 */
export function excludeTaskScopeCandidates(candidateFeatures = [], taskScopeModuleIds = []) {
  return candidateFeatures.filter((c) => !taskScopeModuleIds.includes(VIDEO_FEATURE_TARGETS[c.featureKey]?.moduleId));
}

/**
 * flat "참고 후보" 표시 라벨. 반복빈도(6.0-11)는 raw featureKey/value 대신 "어깨/팔꿈치 반복: 약 N 회/분"으로.
 * 알 수 없는 featureKey는 null 반환 → 호출측이 기존 generic 렌더(featureKey: value) 유지.
 */
export function flatCandidateLabel(c) {
  const n = Math.round((Number(c.value) || 0) * 10) / 10;
  if (REPETITION_FEATURE_KEYS.has(c.featureKey)) {
    const part = c.featureKey === 'shoulderRepetitionRate' ? '어깨' : '팔꿈치';
    return `${part} 반복: 약 ${n} 회/분`;
  }
  // 6.0-10 손목: 반복(회/분)·굴곡/편위(°).
  if (c.featureKey === 'wristRepetitionRate') return `손목 반복: 약 ${n} 회/분`;
  if (c.featureKey === 'wristFlexionPeakAngle') return `손목 굴곡(최대): 약 ${n}°`;
  if (c.featureKey === 'wristDeviationPeakAngle') return `손목 요/척측 편위(최대): 약 ${n}°`;
  return null;
}

// source job 버튼 라벨: "〈공정명〉 측면(채택)" 형태.
export function sourceJobLabel(sj) {
  const vp = sj.viewpoint ? (VIEWPOINT_LABEL[sj.viewpoint] || sj.viewpoint) : '';
  const tag = sj.adopted ? '채택' : '비교 시점';
  return `${sj.processName ? sj.processName + ' ' : ''}${vp ? vp + ' ' : ''}(${tag})`;
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
export function VideoAnalysisStep({ shared, updateShared, updatePatient, activePatient, activeModules = [], session, settings, fixtureMode = false, serverConfig = null, onServerApplied }) {
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
  // jobId → 서버 산출 recipe(§8.11, 6.0-9). 적용 시 source job들의 recipe로 entry recipe를 만든다(서버 검증 대조).
  const [analysisRecipes, setAnalysisRecipes] = useState({});
  // 제안 행별 수정 사유 메모(시범 운영 피드백, 정책 B). rowKey→text. 적용 시 appliedInputs.editReason으로 영속.
  const [applyNotes, setApplyNotes] = useState({});
  const [missingActiveTime, setMissingActiveTime] = useState({}); // { processId: featureKey[] }
  // 대상자 선택(§8.7, PR D2b): 클립별 { serverClipId, result, selectedId, clipKey }. 환자 JSONB 미저장(전송 X).
  const [detection, setDetection] = useState({}); // { [clipMetaId]: {...} }
  const [detecting, setDetecting] = useState(null); // 진행 중 clipMetaId
  // 실 업로드(M3-7a): 클립별 { serverClipId, fileName, progress, status }. UI 임시 상태(환자 JSONB·경로·Blob 미저장).
  const [uploads, setUploads] = useState({}); // { [clipMetaId]: {...} }
  // 근거 패널(B2 선행): "왜 이 값?" evidence. **transient만** — shared.videoAnalysis에 저장 안 함(영속화 차단).
  // 새로고침/환자전환/입력변경 시 사라짐(의도) → 부재 제안행은 fallback 안내.
  const [analysisEvidence, setAnalysisEvidence] = useState({ jobEvidenceBySharedJobId: {}, processEvidenceByProcessId: {}, suppressedCandidates: [], deviceByProcessId: {} });
  const [expandedEvidence, setExpandedEvidence] = useState(null); // 펼친 제안 키 `${sharedJobId}:${featureKey}`
  // 골격 검수 overlay(6.0-8): transient — overlay 데이터 캐시는 jobId→{loading,data,error,closed},
  // 펼친 패널은 row+job 복합키 1개(같은 job을 쓰는 여러 feature 행에서 패널 중복 노출 방지). 영속화 안 함.
  const [overlayByJob, setOverlayByJob] = useState({});
  const [expandedOverlay, setExpandedOverlay] = useState(null); // `${rowKey}::${jobId}` | null
  // task-scope 적용 대상 task: `${processId}:${moduleId}` → taskId. transient(같은 세션 내 적용용).
  // 직업에 그 모듈 task가 1개면 자동, 여러 개면 사용자가 선택. 환자 전환 시 reset.
  const [taskTargets, setTaskTargets] = useState({});
  const resetEvidence = () => {
    setAnalysisEvidence({ jobEvidenceBySharedJobId: {}, processEvidenceByProcessId: {}, suppressedCandidates: [], deviceByProcessId: {} });
    setExpandedEvidence(null);
    setOverlayByJob({});
    setExpandedOverlay(null);
    setTaskTargets({});
  };

  // 골격 검수 열기/닫기(토글). 패널은 클릭한 행(overlayKey)에만, 데이터는 jobId로 캐시 공유.
  // 처음 열 때 fetchOverlay로 적재(404=검수 자료 없음 → error 표시).
  const toggleOverlay = async (overlayKey, jobId) => {
    if (expandedOverlay === overlayKey) { setExpandedOverlay(null); return; }
    setExpandedOverlay(overlayKey);
    const cur = overlayByJob[jobId];
    if (cur && (cur.data || cur.loading || cur.closed)) return; // 이미 적재/로딩/종료됨
    setOverlayByJob((m) => ({ ...m, [jobId]: { loading: true } }));
    try {
      const payload = await fetchOverlay(jobId, { session, settings });
      setOverlayByJob((m) => ({ ...m, [jobId]: payload ? { data: payload } : { error: '검수 자료가 없습니다(다시 분석 필요).' } }));
    } catch (e) {
      setOverlayByJob((m) => ({ ...m, [jobId]: { error: e?.message || '검수 자료를 불러오지 못했습니다.' } }));
    }
  };

  // 검수 종료(6.0-8, job 단위): 서버 200(실제 회수)일 때만 closed 처리(다른 job 보존). 실패면 패널 유지+오류.
  const endReview = async (jobId) => {
    try {
      await closeReview(jobId, { session, settings }); // 성공(2xx)만 아래로 진행
    } catch (e) {
      // requestJson 에러는 e.status·e.data만 갖는다(e.code 아님). 서버가 실제로 안 지웠으므로 닫지 않는다.
      const code = e?.data?.code || e?.data?.error?.code;
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
  const clipKeyOf = (clipMeta) => clipMeta.fixtureClipName || uploads[clipMeta.id]?.serverClipId || null;
  // detection이 현재 클립 출처와 일치할 때만 유효(fixture명/업로드 변경·clip 삭제 시 stale → 무시). 무효화-at-use.
  const validDetection = (clipMeta) => {
    const d = detection[clipMeta.id];
    return d && d.clipKey === clipKeyOf(clipMeta) ? d : null;
  };

  const jobScopeModules = activeModules.filter((m) => getModule(m)?.videoMappingConfig?.scope === 'job');
  // task-scope(경추·척추): 공정≈task 1:1 → 집계 없이 공정별로 렌더하고 task에 직접 적용한다(§8.6.2).
  // 경추·척추는 작업 갯수·이름이 서로 달라 묶지 않고 모듈별로 독립 처리한다.
  const taskScopeModules = activeModules.filter((m) => getModule(m)?.videoMappingConfig?.scope === 'task');
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
    const candidateFeatures = processFeatures.flatMap((pf) => {
      const cands = collectCandidateFeatures(pf.features, { processIds: [pf.processId] });
      // 반복빈도(어깨/팔꿈치)는 상지반복/손목 profile에서만, 손목(반복+각도)은 손목 profile에서만 노출
      // (저fps·비-wholebody profile은 미신뢰). 6.0-11/6.0-10.
      const profile = (va.processes.find((p) => p.id === pf.processId) || {}).analysisProfile;
      return cands.filter((c) => {
        if (REPETITION_FEATURE_KEYS.has(c.featureKey)) return REPETITION_PROFILES.has(profile);
        if (HAND_WRIST_FEATURE_KEYS.has(c.featureKey)) return profile === 'hand-wrist';
        return true;
      });
    });
    updateVA((v) => ({ ...v, processFeatures, jobFeatures, candidateFeatures }));
    // evidence는 transient state(영속화 차단). job-scope=직업단위, task-scope=공정단위 lookup map.
    const jobEvidenceBySharedJobId = buildJobEvidence(va.processes, processFeatures, processEvidence);
    const processEvidenceByProcessId = buildProcessEvidence(va.processes, processFeatures, processEvidence);
    // 시점 하드 게이트로 드롭된 손목 각도 안내(process-level → flat 집계, featureKey 중복 제거). transient.
    const suppressedCandidates = [];
    const seenSuppressed = new Set();
    // 6.0-12: 공정별 실제 실행 디바이스(검토 UI 배지). transient.
    const deviceByProcessId = {};
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
      const processFeatures = [];
      const processEvidence = [];
      for (const p of va.processes) {
        const raw = generateMockFeatures(requested, p.analysisProfile);
        const viewpoints = (va.clips || []).filter((c) => c.processId === p.id).map((c) => c.viewpoint);
        const { features, suppressedCandidates } = gateFeaturesByViewpoint(raw, viewpoints);
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
      const { processFeatures, processEvidence, missingActiveTime: missing, bundleVersion, recipesByJobId, errors } =
        await runServerAnalysis(activePatient, va, { activeModules, session, settings, detections, serverConfig });
      setAnalysisBundle(bundleVersion || MOCK_BUNDLE);
      setAnalysisRecipes(recipesByJobId || {}); // 적용 시 source job recipe 대조용(§8.11).
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
  const applySuggestion = async (moduleId, ctx, s, processIds, analysisProfile, editReason) => {
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
      updatePatient((d) => applyFeatureToModule({ data: d }, {
        moduleId, ctx, featureKey: s.featureKey,
        suggestedValue: s.suggestedValue, confidence: s.confidence,
        processIds: processIds || [], analysisJobIds, analysisBundleVersion: bundleForApply, recipe: appliedRecipe, editReason, appliedBy,
      }).patient.data);
      return;
    }
    setBusy(true);
    setApplyError('');
    try {
      const serverPatient = await applyVideoFeatureViaServer(
        activePatient,
        { moduleId, ctx, featureKey: s.featureKey, suggestedValue: s.suggestedValue, confidence: s.confidence, processIds: processIds || [], analysisJobIds, analysisBundleVersion: bundleForApply, recipe: appliedRecipe, editReason, analysisProfile },
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

  // 한 contribution(공정)의 환산식 문자열(자세비율 × 활동시간). ratio metric만 표시. 단위별 분기.
  const contribFormula = (ev, perDayValue, unit) => {
    if (!ev || ev.intrinsicMetric !== 'posture_ratio' || ev.activeMinutesPerDay == null) return null;
    const ratio = fmtNum(ev.intrinsicValue);
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
        <div className="muted" style={{ fontSize: 12 }}>
          근거 정보는 현재 분석 세션에서만 표시됩니다. 다시 분석하면 확인할 수 있습니다.
        </div>
      );
    }
    return (
      <div style={{ fontSize: 12 }}>
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
              {ev.warnings?.length > 0 && <div style={{ color: 'var(--color-warning)' }}>· 경고: {ev.warnings.join(', ')}</div>}
            </div>
          );
        })}
        <div className="muted" style={{ marginTop: 4, fontStyle: 'italic' }}>
          ※ 신뢰도·경고는 실험값입니다(자동제안 차단 임계값은 검증 전까지 비활성). 값은 전문의가 확정합니다.
        </div>
      </div>
    );
  };

  // 골격 검수 sub-block(suggestion·candidate 행 공용). 행(rowKey) 소속 source job별 overlay 토글.
  const renderSkeletonReview = (rowKey, jobEv) => {
    const sourceJobs = serverMode ? resolveSourceJobs(jobEv) : []; // 서버 artifact 필요
    if (sourceJobs.length === 0) return null;
    const openSj = sourceJobs.find((sj) => expandedOverlay === `${rowKey}::${sj.jobId}`);
    const openOv = openSj ? (overlayByJob[openSj.jobId] || {}) : null;
    return (
      <div style={{ marginTop: 4 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sourceJobs.map((sj) => {
            const ov = overlayByJob[sj.jobId] || {};
            const open = expandedOverlay === `${rowKey}::${sj.jobId}`;
            return (
              <button key={sj.jobId} type="button" className="btn btn-secondary btn-xs"
                onClick={() => toggleOverlay(`${rowKey}::${sj.jobId}`, sj.jobId)} disabled={ov.closed}
                title={ov.closed ? '검수 자료 회수됨' : '중립 배경 골격으로 검수'}>
                {open ? '골격 닫기' : `골격 검수: ${sourceJobLabel(sj)}`}{ov.closed ? ' (회수됨)' : ''}
              </button>
            );
          })}
        </div>
        {openSj && (
          <div style={{ marginTop: 6 }}>
            {openOv.loading && <p className="muted" style={{ fontSize: 12 }}>골격 불러오는 중…</p>}
            {openOv.error && <p className="muted" style={{ fontSize: 12, color: 'var(--color-warning)' }}>{openOv.error}</p>}
            {openOv.data && (
              <>
                <SkeletonOverlay overlay={openOv.data} activeSegments={segmentsForJob(jobEv, openSj.jobId)} session={session} settings={settings} />
                <div style={{ marginTop: 4 }}>
                  <button type="button" className="btn btn-secondary btn-xs"
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

  // 제안 1건 행(job-scope·task-scope 공용). rowKey로 근거/overlay 패널을 행마다 고유하게 키잉.
  // ctx=적용 컨텍스트({sharedJobId} | {taskId}), applyDisabled=대상 task 없음 등 추가 비활성.
  const renderSuggestionRow = (s, { moduleId, ctx, processIds, analysisProfile, jobEv, rowKey, applyDisabled = false, applyDisabledTitle }) => {
    const refOnly = s.autoSuggestAllowed === false; // 저신뢰 게이팅(§8.8 D3a) — 자동제안 금지·적용 비활성
    const expanded = expandedEvidence === rowKey;
    const skeleton = renderSkeletonReview(rowKey, jobEv);
    return (
      <li key={rowKey} className="va-suggest-card">
        <div className="va-suggest-head">
          <code className="va-suggest-key">{s.featureKey}</code>
          <span className="va-suggest-value">→ {String(fmtNum(s.suggestedValue))} {s.unit || ''}</span>
          <span className={`va-flag-pill ${s.confidence >= 0.8 ? 'tone-positive' : 'tone-warning'}`}>신뢰도 {Math.round(s.confidence * 100)}%</span>
          {refOnly && <span className="va-flag-pill tone-warning" title="저신뢰 — 수기 확인 필요">참고만</span>}
          {s.requiresManualReview && <span className="va-flag-pill tone-info">수기확인</span>}
        </div>
        <div className="va-suggest-actions">
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => setExpandedEvidence(expanded ? null : rowKey)}>
            {expanded ? '근거 닫기' : '왜 이 값?'}
          </button>
          {/* 시범 운영(정책 B): 적용 시 선택 메모 → provenance editReason. 제안이 어긋날 때 사유 축적(B2 신호). */}
          {!refOnly && !applyDisabled && (
            <input type="text" className="va-note-input" placeholder="수정 사유(선택)"
              value={applyNotes[rowKey] || ''}
              onChange={(e) => setApplyNotes((m) => ({ ...m, [rowKey]: e.target.value }))}
              style={{ fontSize: 12, padding: '2px 6px', minWidth: 140, flex: '1 1 140px' }} />
          )}
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || applyBlocked || refOnly || applyDisabled}
            title={applyDisabled ? applyDisabledTitle : undefined}
            onClick={() => applySuggestion(moduleId, ctx, s, processIds, analysisProfile, (applyNotes[rowKey] || '').trim() || undefined)}>
            {serverMode ? '서버 적용' : '적용'}
          </button>
        </div>
        {(expanded || skeleton) && (
          <div className="va-suggest-details">
            {expanded && renderEvidencePanel(jobEv, s.unit)}
            {skeleton}
          </div>
        )}
      </li>
    );
  };

  // candidate(관찰값) 행 — apply 없음. featureKey별 formatter(원값+unit 출력 금지). 작업 단위 표시.
  const renderCandidateRow = (c, { activeMinutesPerDay, jobEv, rowKey }) => {
    const expanded = expandedEvidence === rowKey;
    let label;
    let displayJobEv = jobEv;
    if (c.featureKey === 'trunkFlexionOver45Duration') {
      const pct = Math.round((Number(c.value) || 0) * 100);
      const mins = candidateMinutesPerDay(c.value, activeMinutesPerDay);
      label = <>척추 45°↑ 굴곡: 클립의 {pct}%{mins != null ? ` · 약 ${mins} 분/일` : <span className="muted"> (활동시간 입력 시 분/일 표시)</span>}</>;
      // 근거 패널 contribFormula가 ratio를 분/일로 오표시하지 않도록 perDayValue를 computed minutes로 패치
      // (원본 transient state 변형 금지 — shallow clone).
      if (jobEv && mins != null) {
        displayJobEv = { ...jobEv, contributions: (jobEv.contributions || []).map((ct) => ({ ...ct, perDayValue: mins })) };
      }
    } else {
      // generic candidate(trunkPostureG·neckCombinedFlexRot 등): 원값 + (evidence.intrinsicUnit) 표시.
      const unit = jobEv?.contributions?.[0]?.evidence?.intrinsicUnit || '';
      label = <>{c.reason ? `${c.reason}: ` : ''}{String(fmtNum(c.value))}{unit ? ` ${unit}` : ''}</>;
    }
    const skeleton = renderSkeletonReview(rowKey, jobEv);
    return (
      <li key={rowKey} className="va-suggest-card">
        <div className="va-suggest-head">
          <code className="va-suggest-key">{c.featureKey}</code>
          <span className="va-suggest-value">{label}</span>
          <span className="va-flag-pill tone-warning" title="관찰값 — 자동입력 안 함">참고만</span>
          {typeof c.confidence === 'number' && (
            <span className={`va-flag-pill ${c.confidence >= 0.8 ? 'tone-positive' : 'tone-neutral'}`}>신뢰도 {Math.round(c.confidence * 100)}%</span>
          )}
        </div>
        <div className="va-suggest-actions">
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => setExpandedEvidence(expanded ? null : rowKey)}>
            {expanded ? '근거 닫기' : '왜 이 값?'}
          </button>
        </div>
        {(expanded || skeleton) && (
          <div className="va-suggest-details">
            {expanded && renderEvidencePanel(displayJobEv, c.featureKey === 'trunkFlexionOver45Duration' ? 'minutes_per_day' : null)}
            {skeleton}
          </div>
        )}
      </li>
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
            ⚠ <b>시범 운영</b> — 영상 분석값은 정확도 검증(6.0-B2) 전입니다. 모든 값은 <b>참고용</b>이며,
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
            ⚠ 일부 공정의 활동시간(분/일)이 비어 있어 per-day 제안을 만들지 못했습니다. 공정 "활동시간"을 입력 후 다시 분석하세요.
          </p>
        )}

        <div className="va-layout">
          {/* 왼쪽: 공정·클립 셋업 */}
          <div className="va-col">
            <div className="va-col-title">셋업 — 공정·클립</div>
            {va.processes.length === 0 && <p className="evaluation-empty-state">공정을 추가하세요. 공정 구조·시간 점유율은 조사 서류 기반 수기 입력입니다.</p>}
            {va.processes.map((p) => {
              const clips = va.clips.filter((c) => c.processId === p.id);
              const total = shareTotals[p.sharedJobId] || 0;
              return (
                <div key={p.id} className="va-process-card">
                  <div className="va-process-fields">
                    <div className="form-group"><label>공정명</label>
                      <input value={p.name} onChange={(e) => editProcess(p.id, { name: e.target.value })} placeholder="공정명" /></div>
                    <div className="form-group"><label>직업</label>
                      <select value={p.sharedJobId} onChange={(e) => editProcess(p.id, { sharedJobId: e.target.value })}>
                        {jobs.map((j) => <option key={j.id} value={j.id}>{j.jobName || '(직업 미지정)'}</option>)}
                      </select></div>
                    <div className="form-group"><label>점유율(%)</label>
                      <input type="number" min="0" max="100" value={p.shiftSharePercent}
                        onChange={(e) => editProcess(p.id, { shiftSharePercent: Number(e.target.value) })} /></div>
                    <div className="form-group"><label title="공정활동분/일(수기). 비우면 모름(적용 불가).">활동시간(분/일)</label>
                      <input type="number" min="0" max="1440" placeholder="분/일" value={p.activeMinutesPerDay ?? ''}
                        onChange={(e) => editProcess(p.id, { activeMinutesPerDay: e.target.value === '' ? null : Number(e.target.value) })} /></div>
                    <div className="form-group"><label>분석 프로필</label>
                      {/* 손목·손(고프레임)은 wholebody 추론이 무거워(처리 느림·서버 부하) 손목 모듈 활성 시에만 노출.
                          단, 이미 그 프로필로 저장된 공정은 폴백으로 옵션 유지(선택 보존). 6.0-10. */}
                      <select value={p.analysisProfile} onChange={(e) => editProcess(p.id, { analysisProfile: e.target.value })}>
                        {PROFILES.filter((pr) => pr.value !== 'hand-wrist'
                          || activeModules.includes('wrist') || p.analysisProfile === 'hand-wrist')
                          .map((pr) => <option key={pr.value} value={pr.value}>{pr.label}</option>)}
                      </select>
                      {p.analysisProfile === 'hand-wrist' && (
                        <p className="muted" style={{ fontSize: 11, marginTop: 2, color: 'var(--color-warning)' }}>
                          ⚠ 고부담(처리 느림·서버 부하) — 손목·손 분석이 필요한 공정에만 사용
                        </p>
                      )}</div>
                    <div className="form-group"><label>&nbsp;</label>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeProcess(p.id)}>공정 삭제</button></div>
                  </div>
                  {/* 6.0-12: 실제 실행된 추론 디바이스 배지(분석 후). auto에서 cuda→cpu 폴백 시 사유 tooltip. */}
                  {(() => {
                    const dev = analysisEvidence.deviceByProcessId[p.id];
                    if (!dev) return null;
                    const label = dev.used === 'cuda' ? 'GPU(CUDA)' : (dev.fallback ? 'CPU(폴백)' : 'CPU');
                    return (
                      <p className="muted" style={{ fontSize: 11, marginTop: 4 }} title={dev.reason || ''}>
                        실행: <b>{label}</b>
                      </p>
                    );
                  })()}
                  {total !== 100 && <p className="muted" style={{ color: 'var(--color-warning)', marginTop: 6 }}>⚠ "{jobName(p.sharedJobId)}" 공정 점유율 합 {total}% (100% 권장)</p>}
                  <div className="va-process-clips">
                    {clips.map((c) => {
                      const up = uploads[c.id];
                      const canDetect = canDetectClip({ serverMode, fixtureMode, clip: c, upload: up });
                      const det = canDetect ? validDetection(c) : null;
                      return (
                        <div key={c.id} className="va-clip-row">
                          <select value={c.viewpoint} onChange={(e) => editClip(c.id, { viewpoint: e.target.value })}>
                            {VIEWPOINTS.map((vp) => <option key={vp.value} value={vp.value}>{vp.label}</option>)}
                          </select>
                          {fixtureMode && (
                            <input type="text" placeholder="fixture 파일명(dev)" value={c.fixtureClipName || ''}
                              onChange={(e) => editClip(c.id, { fixtureClipName: e.target.value })} style={{ width: 150 }} />
                          )}
                          {serverMode && !c.fixtureClipName && (
                            <>
                              <input type="file" accept="video/*" disabled={up?.status === 'uploading'}
                                onChange={(e) => uploadClipFile(c, p.id, e.target.files && e.target.files[0])} />
                              {up?.status === 'uploading' && <span className="muted" style={{ fontSize: 12 }}>업로드 {Math.round((up.progress || 0) * 100)}%</span>}
                              {up?.status === 'done' && <span className="va-flag-pill tone-positive">업로드 완료</span>}
                              {up?.status === 'error' && <span className="va-flag-pill tone-warning">업로드 실패</span>}
                            </>
                          )}
                          {canDetect && (
                            <button type="button" className="btn btn-secondary btn-sm" disabled={detecting === c.id} onClick={() => detectTarget(c, p.id)}>
                              {detecting === c.id ? '탐지 중…' : (det ? '재탐지' : '대상자 탐지')}
                            </button>
                          )}
                          <button type="button" className="btn btn-secondary btn-xs" onClick={() => removeClip(c.id)}>×</button>
                          {det && (
                            <div className="va-clip-detect">
                              <TargetPicker result={det.result} selectedId={det.selectedId} frameUrl={det.frameUrl} onSelect={(id) => chooseTarget(c, id)} />
                              <p className="muted" style={{ fontSize: 12 }}>
                                {det.selectedId ? `대상자: ${det.selectedId}` : '박스를 클릭해 대상 작업자를 선택하세요(미선택 시 자동=주요 인물).'}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => addClip(p.id)}>+ 클립</button>
                      {clips.length === 0 && <span className="muted"> 클립(시점) 미태깅</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addProcess}>+ 공정 추가</button>
              <button type="button" className="btn btn-primary" onClick={runAnalysis} disabled={va.processes.length === 0 || analyzing}>
                {analyzing ? '분석 중…' : (serverMode ? '분석 실행' : 'mock 분석 실행')}
              </button>
            </div>

            {/* 파이프라인 진행바(coarse) */}
            <div className="va-pipeline">
              {PIPELINE_STEPS.map((label, i) => {
                const done = i < pipelineIndex;
                const active = i === pipelineIndex;
                return (
                  <span key={label} className={`va-pipeline-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}`}>
                    {done ? '✓ ' : (active ? '▶ ' : '')}{label}
                  </span>
                );
              })}
            </div>
          </div>

          {/* 오른쪽: 제안 검토 */}
          <div className="va-col">
            <div className="va-col-title">검토 — 제안{!hasAnalysis && <small>분석 실행 후 표시됩니다</small>}</div>
            {!hasAnalysis && <p className="evaluation-empty-state">공정·클립을 정리하고 <b>분석 실행</b>을 누르면 제안이 여기에 표시됩니다.</p>}

        {/* 3) 제안 검토 (job-scope) */}
        {hasAnalysis && (
          <div className="va-suggest-group">
            <div className="va-suggest-group-title">직업 단위 (무릎·어깨)</div>
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
                    <ul key={moduleId} className="va-suggest-list">
                      {suggestions.map((s) => renderSuggestionRow(s, {
                        moduleId,
                        ctx: { sharedJobId: jf.sharedJobId },
                        processIds: procIds,
                        analysisProfile,
                        jobEv: analysisEvidence.jobEvidenceBySharedJobId[jf.sharedJobId]?.[s.featureKey],
                        rowKey: `${jf.sharedJobId}:${s.featureKey}`,
                      }))}
                    </ul>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* 3-task) 제안 검토 (task-scope — 경추·척추, 공정≈task 1:1). 모듈별 독립 + 대상 task 선택. */}
        {hasAnalysis && taskScopeModules.length > 0 && (
          <div className="va-suggest-group">
            <div className="va-suggest-group-title">작업 단위 (척추·경추)</div>
            {va.processes.map((p) => {
              const pf = (va.processFeatures || []).find((f) => f.processId === p.id);
              if (!pf) return null;
              const blocks = taskScopeModules.map((moduleId) => {
                const suggestions = getModuleSuggestions(pf.features, moduleId);
                const candidates = getModuleCandidates(pf.features, moduleId); // 관찰값(apply 없음)
                if (suggestions.length === 0 && candidates.length === 0) return null; // candidate만 있어도 표시
                const mod = getModule(moduleId);
                const procEv = analysisEvidence.processEvidenceByProcessId[p.id] || {};
                // 이 직업의 해당 모듈 task 목록(적용 대상). 경추·척추는 작업 갯수·이름이 달라 모듈별로 독립.
                // spine은 미연결 레거시 task fallback 허용(taskFallbackUnlinked).
                const tasks = tasksForJob(activePatient?.data?.modules?.[moduleId], p.sharedJobId,
                  { fallbackUnlinked: !!mod?.videoMappingConfig?.taskFallbackUnlinked });
                const targetKey = `${p.id}:${moduleId}`;
                // 선택값이 현재 후보에 실제 존재할 때만 유효(stale 선택 → 적용 잘못 활성 방지).
                const targetTaskId = resolveTargetTaskId(tasks, taskTargets[targetKey]);
                const noTarget = !targetTaskId;
                return (
                  <ul key={moduleId} style={{ listStyle: 'none', paddingLeft: 12 }}>
                    {/* 대상 작업 선택은 apply가 있는 auto 제안에만 의미 — candidate만 있는 블록엔 경고/선택 생략 */}
                    {suggestions.length > 0 && (
                      <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
                        <b>{mod?.name || moduleId}</b> 대상 작업:{' '}
                        {tasks.length === 0 ? <span style={{ color: 'var(--color-warning)' }}>없음 — {mod?.name} 탭에서 작업을 추가한 뒤 적용 가능</span>
                          : tasks.length === 1 ? (tasks[0].name || '작업')
                            : (
                              <select value={targetTaskId || ''} onChange={(e) => setTaskTargets((m) => ({ ...m, [targetKey]: e.target.value }))}>
                                <option value="">(작업 선택)</option>
                                {tasks.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                              </select>
                            )}
                      </div>
                    )}
                    {suggestions.length === 0 && candidates.length > 0 && (
                      <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}><b>{mod?.name || moduleId}</b> 관찰값</div>
                    )}
                    {suggestions.map((s) => renderSuggestionRow(s, {
                      moduleId,
                      ctx: { taskId: targetTaskId },
                      processIds: [p.id],
                      analysisProfile: p.analysisProfile,
                      jobEv: procEv[s.featureKey],
                      rowKey: `${p.id}:${moduleId}:${s.featureKey}`,
                      applyDisabled: noTarget,
                      applyDisabledTitle: '적용할 대상 작업을 먼저 선택하세요',
                    }))}
                    {candidates.map((c) => renderCandidateRow(c, {
                      activeMinutesPerDay: p.activeMinutesPerDay,
                      jobEv: procEv[c.featureKey],
                      rowKey: `${p.id}:${moduleId}:cand:${c.featureKey}`,
                    }))}
                  </ul>
                );
              });
              if (blocks.every((b) => b === null)) return null;
              return (
                <div key={p.id} style={{ marginBottom: 10 }}>
                  <b>{p.name}</b> <span className="muted">({jobName(p.sharedJobId)})</span>
                  {blocks}
                </div>
              );
            })}
          </div>
        )}

        {/* 4) candidate (참고만) — task-scope 모듈(경추·척추) candidate는 위 "작업 단위"에서 표시하므로 제외 */}
        {(() => {
          const flatCandidates = excludeTaskScopeCandidates(va.candidateFeatures || [], taskScopeModules);
          const suppressed = analysisEvidence.suppressedCandidates || [];
          return (flatCandidates.length > 0 || suppressed.length > 0) && (
          <div className="va-suggest-group">
            <div className="va-suggest-group-title">참고 후보 (자동입력 금지)</div>
            {flatCandidates.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {flatCandidates.map((c, i) => {
                const label = flatCandidateLabel(c);
                return (
                  <li key={`${c.featureKey}-${i}`}>
                    {label !== null
                      ? <>{label} — <span className="muted">{c.reason}</span></>
                      : <><code>{c.featureKey}</code>: {String(c.value)} — <span className="muted">{c.reason}</span></>}
                  </li>
                );
              })}
            </ul>
            )}
            {/* 시점 하드 게이트 안내(6.0-10): 손목 굴곡/편위는 같은 2D 값이라 시점별로만 노출 */}
            {suppressed.length > 0 && (
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                손목 각도는 측면 클립에서 굴곡만, 정면 클립에서 편위만 표시됩니다 — 해당 시점 클립이 없어 일부 후보는 숨겨졌습니다.
              </p>
            )}
          </div>
          );
        })()}
          </div>{/* /va-col 검토 */}
        </div>{/* /va-layout */}

        {/* 5) 적용 이력 + 되돌리기 (전체폭) */}
        {(va.appliedInputs || []).length > 0 && (
          <div className="va-history">
            <div className="va-col-title">적용 이력 (provenance)</div>
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
                    <button type="button" className="btn btn-secondary btn-xs" style={{ marginLeft: 8 }} onClick={() => rollback(e)}>되돌리기</button>
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

// 영상 분석 화면의 근거·집계 순수 헬퍼(P2-75c, Phase 2 C9 구간 D) — 직업 단위 집계, "왜 이 값?" 근거 lookup, 골격 검수 대상 job,
// 환산식 문자열, 상태바 수치, 표시용 숫자(fmtNum). 본문은 VideoAnalysisStep에 있던 그대로다.
import { aggregateProcessFeatures, getAggregationMethod } from './videoAggregate';
import { getModuleSuggestions } from './videoProvenance';
import type { VideoAnalysisData, AggregationMode, VideoProcess, ProcessFeatures, JobFeatures, VideoFeatureMap, ProcessEvidence, EvidenceByFeatureKey, FeatureEvidence, SourceJob, ContributionEvidence, FeatureScalar, EvidenceSegment } from './videoStepTypes';

/**
 * 상태바 표시용 파생 수치(새 React state 없음 — 렌더 시점 계산). 표시 전용이라 결정적 정의:
 * - suggestionCount: 직업단위(jobFeatures×jobScopeModules) + 작업단위(processFeatures×taskScopeModules) getModuleSuggestions 합.
 *   candidate 제외. "제안 N" 라벨(actionable 여부—참고만·대상작업 미선택·미동기화—는 세지 않음).
 * - warningCount: 점유율 합 ≠100 직업 수 + missingActiveTime에서 누락 feature가 실제 있는 공정 수(빈 배열 방어).
 */
export function buildVideoStatus(va: VideoAnalysisData, {
  shareTotals = {}, missingActiveTime = {}, jobScopeModules = [], taskScopeModules = [],
  analyzing = false, hasAnalysis = false,
}: {
  shareTotals?: Record<string, number>; missingActiveTime?: Record<string, string[]>;
  jobScopeModules?: string[]; taskScopeModules?: string[]; analyzing?: boolean; hasAnalysis?: boolean;
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
export function fmtNum<T>(v: T): T | number {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 10) / 10 : v;
}

/**
 * 공정의 effective share(%)를 결정한다 — job-scope 집계(buildJobFeatures)와 공정별 서브행 기여값
 * (renderJobScopeSuggestions)이 항상 같은 값을 쓰도록 단일화(6.0-17, 재구현 금지).
 * @param {'shareWeighted'|'absolutePerDay'} mode - processFeatureAggregationMode.
 *   absolutePerDay: 서버 실분석 값은 ratio×activeMinutesPerDay로 이미 절대 per-day이므로 share로
 *   재가중하지 않고 100%로 취급(이중 차감 방지). shareWeighted(mock 기본): 공정 점유율 그대로.
 */
export function effectiveShare(mode: AggregationMode | undefined, shiftSharePercent: number): number {
  return mode === 'absolutePerDay' ? 100 : shiftSharePercent;
}

/**
 * 공정별 feature를 직업(sharedJobId) 단위로 묶어 집계한다(job-scope).
 * @param {'shareWeighted'|'absolutePerDay'} [processFeatureAggregationMode] - effectiveShare 참고.
 */
export function buildJobFeatures(
  processes: VideoProcess[] = [], processFeatures: ProcessFeatures[] = [],
  { processFeatureAggregationMode = 'shareWeighted' }: { processFeatureAggregationMode?: AggregationMode } = {},
): JobFeatures[] {
  const byJob: Record<string, Array<{ share: number; features: VideoFeatureMap }>> = {};
  for (const pf of processFeatures) {
    const proc = processes.find((p) => p.id === pf.processId);
    if (!proc) continue;
    (byJob[proc.sharedJobId] = byJob[proc.sharedJobId] || []).push({
      share: effectiveShare(processFeatureAggregationMode, proc.shiftSharePercent),
      features: pf.features,
    });
  }
  return Object.keys(byJob).map((sharedJobId) => ({
    sharedJobId,
    features: aggregateProcessFeatures(byJob[sharedJobId]) as VideoFeatureMap,
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
export function buildJobEvidence(
  processes: VideoProcess[] = [], processFeatures: ProcessFeatures[] = [], processEvidence: ProcessEvidence[] = [],
): Record<string, EvidenceByFeatureKey> {
  const featuresByProcess: Record<string, VideoFeatureMap> = {};
  for (const pf of processFeatures) featuresByProcess[pf.processId] = pf.features || {};
  const byJob: Record<string, EvidenceByFeatureKey> = {};
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
export function buildProcessEvidence(
  processes: VideoProcess[] = [], processFeatures: ProcessFeatures[] = [], processEvidence: ProcessEvidence[] = [],
): Record<string, EvidenceByFeatureKey> {
  const featuresByProcess: Record<string, VideoFeatureMap> = {};
  for (const pf of processFeatures) featuresByProcess[pf.processId] = pf.features || {};
  const byProc: Record<string, EvidenceByFeatureKey> = {};
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

const VIEWPOINT_LABEL: Record<string, string> = { sagittal: '측면', frontal: '정면', other: '기타' };

/**
 * feature 한 항목(jobEv)의 골격 검수 대상 source job 목록을 도출한다(6.0-8).
 * feature 값은 공정 합산·시점 융합으로 N개 job에서 오므로 단일 jobId를 붙이면 안 된다.
 * 우선순위: contribution.evidence.fusion.candidates(채택=adopted, 탈락=비교 시점) — 채택 job을 주 검수 대상으로,
 * 탈락 후보는 "비교 시점"으로 구분. fusion이 없으면(구 데이터) jobEv.analysisJobIds로 fallback.
 * @returns {Array<{jobId, processName, viewpoint, adopted}>} 채택 먼저 정렬, jobId 중복 제거.
 */
export function resolveSourceJobs(jobEv: FeatureEvidence | null | undefined): SourceJob[] {
  if (!jobEv) return [];
  const out: SourceJob[] = [];
  const seen = new Set();
  const pushJob = (jobId: string | null | undefined, processName: string | null | undefined, viewpoint: string | null | undefined, adopted: boolean | undefined) => {
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
export function segmentsForJob(jobEv: FeatureEvidence | null | undefined, jobId: string | null | undefined): EvidenceSegment[] {
  if (!jobEv || !jobId) return [];
  for (const c of jobEv.contributions || []) {
    const ev = (c.evidence || {}) as ContributionEvidence;
    if (!Array.isArray(ev.segments) || ev.segments.length === 0) continue;
    const adoptedJobId = ev.fusion?.adopted?.jobId;
    const owns = adoptedJobId != null ? adoptedJobId === jobId : (c.analysisJobIds || []).indexOf(jobId) >= 0;
    if (owns) return ev.segments;
  }
  return [];
}

// 한 contribution(공정)의 환산식 문자열(자세비율 × 활동시간). ratio metric만 표시. 단위별 분기.
export function contribFormula(ev: ContributionEvidence | null | undefined, perDayValue: FeatureScalar, unit: string | null | undefined): string | null {
  if (!ev || ev.intrinsicMetric !== 'posture_ratio' || ev.activeMinutesPerDay == null) return null;
  const ratio = fmtNum(ev.intrinsicValue);
  const pd = typeof perDayValue === 'number' ? Math.round(perDayValue * 10) / 10 : perDayValue;
  const pdStr = pd == null ? '?' : pd;
  const am = ev.activeMinutesPerDay;
  if (unit === 'hours_per_day') return `${pdStr} 시간/일 = 자세비율 ${ratio} × 활동 ${am}분/일 ÷ 60`;
  if (unit === 'minutes_per_day') return `${pdStr} 분/일 = 자세비율 ${ratio} × 활동 ${am}분/일`;
  return `${pdStr} ${unit || ''} = 자세비율 ${ratio} × 활동 ${am}분/일`;
}

// source job 버튼 라벨: "〈공정명〉 측면(채택)" 형태.
export function sourceJobLabel(sj: SourceJob): string {
  const vp = sj.viewpoint ? (VIEWPOINT_LABEL[sj.viewpoint] || sj.viewpoint) : '';
  const tag = sj.adopted ? '채택' : '비교 시점';
  return `${sj.processName ? sj.processName + ' ' : ''}${vp ? vp + ' ' : ''}(${tag})`;
}

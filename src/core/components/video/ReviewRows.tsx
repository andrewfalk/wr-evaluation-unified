// 영상 분석 화면 검토 열의 행 컴포넌트(P2-75f, Phase 2 C9 구간 D) — 본체의 렌더 함수 renderSuggestionRow·renderCandidateRow·
// renderJobScopeProcessBreakdown을 컴포넌트로 옮긴 것이다. 본문은 그대로이고, `<li key>`의 key만 호출부로 옮겼다(같은 값·같은 순서).
// 본체 상태를 읽던 값(펼친 근거·수정 사유·처리 중·적용 핸들러·근거/골격 렌더 함수)은 review 묶음으로 받는다.
import type { ReactNode } from 'react';
import { displayCandidateReason } from '../../services/videoMock';
import { contributionValue } from '../../services/videoAggregate';
import { fmtNum, effectiveShare } from '../../services/videoStepEvidence';
import { candidateMinutesPerDay } from '../../services/videoStepCandidates';
import type { VideoAnalysisData, VideoProcess } from '../../services/videoStepTypes';
import type { CandidateRowProps, SuggestionRowProps } from './types';

// 제안 1건 행(job-scope·task-scope 공용). rowKey로 근거/overlay 패널을 행마다 고유하게 키잉.
// ctx=적용 컨텍스트({sharedJobId} | {taskId}), applyDisabled=대상 task 없음 등 추가 비활성.
export function SuggestionRow({
  s, moduleId, ctx, processIds, analysisProfile, jobEv, rowKey, applyDisabled = false, applyDisabledTitle, review,
}: SuggestionRowProps) {
  const {
    expandedEvidence, setExpandedEvidence, applyNotes, setApplyNotes, busy, applyBlocked, applySuggestion, renderEvidencePanel,
    renderSkeletonReview,
  } = review;
  const refOnly = s.autoSuggestAllowed === false; // 저신뢰 게이팅(§8.8 D3a) — 자동제안 금지·적용 비활성
  const expanded = expandedEvidence === rowKey;
  const skeleton = renderSkeletonReview(rowKey, jobEv);
  return (
    <li className="va-suggest-card">
      <div className="va-suggest-head">
        <code className="va-suggest-key">{s.featureKey}</code>
        <span className="va-suggest-value">→ {String(fmtNum(s.suggestedValue))} {s.unit || ''}</span>
        <span className={`va-flag-pill ${s.confidence >= 0.8 ? 'tone-positive' : 'tone-warning'}`}>신뢰도 {Math.round(s.confidence * 100)}%</span>
        {refOnly && <span className="va-flag-pill tone-warning" title="저신뢰 — 수기 확인 필요">참고만</span>}
        {s.requiresManualReview && <span className="va-flag-pill tone-info">수기확인</span>}
      </div>
      <div className="va-suggest-actions">
        <button type="button" className="btn btn-secondary btn-sm"
          data-readonly-allow
          onClick={() => setExpandedEvidence(expanded ? null : rowKey)}>
          {expanded ? '근거 닫기' : '왜 이 값?'}
        </button>
        {/* 시범 운영(정책 B): 적용 시 선택 메모 → provenance editReason. 제안이 어긋날 때 사유 축적(B2 신호). */}
        {!refOnly && !applyDisabled && (
          <input type="text" className="va-note-input" placeholder="수정 사유(선택)"
            value={applyNotes[rowKey] || ''}
            onChange={(e) => setApplyNotes((m) => ({ ...m, [rowKey]: e.target.value }))} />
        )}
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || applyBlocked || refOnly || applyDisabled}
          title={applyDisabled ? applyDisabledTitle : undefined}
          onClick={() => applySuggestion(moduleId, ctx, s, processIds, analysisProfile, (applyNotes[rowKey] || '').trim() || undefined)}>
          적용
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
}

// candidate(관찰값) 행 — apply 없음. featureKey별 formatter(원값+unit 출력 금지). 작업 단위 표시.
export function CandidateRow({ c, activeMinutesPerDay, jobEv, rowKey, review }: CandidateRowProps) {
  const { expandedEvidence, setExpandedEvidence, renderEvidencePanel, renderSkeletonReview } = review;
  const expanded = expandedEvidence === rowKey;
  let label: ReactNode;
  let displayJobEv = jobEv;
  if (c.featureKey === 'trunkFlexionOver45Duration') {
    const pct = Math.round((Number(c.value) || 0) * 100);
    const mins = candidateMinutesPerDay(c.value, activeMinutesPerDay);
    label = <>척추 45°↑ 굴곡: 클립의 {pct}%{mins != null ? ` · 약 ${mins} 분/일` : <span className="va-hint"> (활동시간 입력 시 분/일 표시)</span>}</>;
    // 근거 패널 contribFormula가 ratio를 분/일로 오표시하지 않도록 perDayValue를 computed minutes로 패치
    // (원본 transient state 변형 금지 — shallow clone).
    if (jobEv && mins != null) {
      displayJobEv = { ...jobEv, contributions: (jobEv.contributions || []).map((ct) => ({ ...ct, perDayValue: mins })) };
    }
  } else {
    // generic candidate(trunkPostureG·neckCombinedFlexRot 등): 원값 + (evidence.intrinsicUnit) 표시.
    const unit = jobEv?.contributions?.[0]?.evidence?.intrinsicUnit || '';
    label = <>{c.reason ? `${displayCandidateReason(c.reason)}: ` : ''}{String(fmtNum(c.value))}{unit ? ` ${unit}` : ''}</>;
  }
  const skeleton = renderSkeletonReview(rowKey, jobEv);
  return (
    <li className="va-suggest-card">
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
          data-readonly-allow
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
}

// 6.0-17: job-scope 제안(직업 합계) 아래 공정별 분해 서브행 — 적용 없는 읽기 전용 표시.
// 기여값 = contributionValue(집계와 동일 산식, 재구현 금지). va.processFeatureAggregationMode가
// 없는 구 데이터는 기여값 계산을 생략(fail-safe)하고 원값만 표시 + fallback 안내.
export function JobScopeProcessBreakdown({ s, jobProcesses, va }: {
  s: SuggestionRowProps['s']; jobProcesses: VideoProcess[]; va: VideoAnalysisData;
}) {
  const mode = va.processFeatureAggregationMode;
  const rows = jobProcesses.map((p) => {
    const pf = (va.processFeatures || []).find((f) => f.processId === p.id);
    const raw = pf?.features?.[s.featureKey]?.value;
    if (raw == null) return null;
    const contrib = mode ? contributionValue(s.featureKey, raw as number, effectiveShare(mode, p.shiftSharePercent)) : null;
    return (
      <div key={p.id} className="va-subrow">
        {p.name}: {contrib != null
          ? <>{fmtNum(contrib)} {s.unit || ''} <span className="va-hint">(원값 {fmtNum(raw)} {s.unit || ''})</span></>
          : <>{fmtNum(raw)} {s.unit || ''}</>}
      </div>
    );
  }).filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <li className="va-suggest-breakdown">
      {!mode && <div className="va-hint">이전 분석은 공정 기여값 정보 없음 — 재분석 시 표시</div>}
      {rows}
    </li>
  );
}

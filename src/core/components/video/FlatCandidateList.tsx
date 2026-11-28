// 영상 분석 화면의 flat "참고 후보" 목록(P2-75d, Phase 2 C9 구간 D) — VideoAnalysisStep에 있던 그대로다.
import type { ReactNode } from 'react';
import { displayCandidateReason } from '../../services/videoMock';
import { VIDEO_FEATURE_TARGETS } from '@wr/contracts/index';
import type { FeatureKey } from '@wr/contracts/index';
import type { CandidateFeature, VideoProcess, EvidenceByFeatureKey, SuppressedCandidate, FeatureEvidence } from '../../services/videoStepTypes';
import { flatCandidateLabel, flatCandidateRowRef, RATIO_HOURS_CANDIDATE_KEYS, candidateHoursPerDay, formatCandidateSubValue, hasAnyFlatEvidence } from '../../services/videoStepCandidates';

/**
 * flat "참고 후보" 리스트(6.0-17 그룹핑 + 6.0-18 골격 검수·근거 배선). `renderEvidencePanel`·
 * `renderSkeletonReview`는 VideoAnalysisStep의 state 클로저(expandedOverlay·session 등)라 재구현하지
 * 않고 render prop으로 주입한다 — 이 컴포넌트는 표시 로직만 갖고, jsdom 렌더 테스트(flatCandidateList.test.jsx)로
 * JSX 배선 누락(이번 버그의 본체 — 순수 함수 테스트만으로는 검출 불가)을 검증한다.
 *
 * mock 모드는 서버 artifact가 원천적으로 없어 골격 검수가 불가능하고, 근거 패널을 열어도 "다시 분석하면
 * 확인할 수 있습니다"라는 사실과 다른 안내만 나온다 → 버튼·상세 영역·안내 문구 전부 `serverMode` 전용.
 * task-scope 후보행(renderCandidateRow)은 mock에서도 "왜 이 값?"이 뜨는 기존 동작을 유지하므로, 이 비대칭은
 * 의도된 것이다(flat 행은 골격 검수와 짝을 이루는 서버 전용 검수 도구로 취급).
 */
export function FlatCandidateList({
  candidates,
  processes,
  processEvidenceByProcessId,
  suppressedCandidates,
  serverMode,
  expandedEvidence,
  onToggleEvidence,
  renderEvidencePanel,
  renderSkeletonReview,
}: {
  candidates: CandidateFeature[];
  processes: VideoProcess[];
  processEvidenceByProcessId: Record<string, EvidenceByFeatureKey>;
  suppressedCandidates: SuppressedCandidate[];
  serverMode: boolean;
  expandedEvidence: string | null;
  onToggleEvidence: (key: string | null) => void;
  renderEvidencePanel: (jobEv: FeatureEvidence | null, unit: string | null) => ReactNode;
  renderSkeletonReview: (rowKey: string, jobEv: FeatureEvidence | null) => ReactNode;
}) {
  if (candidates.length === 0 && suppressedCandidates.length === 0) return null;
  // 6.0-17: featureKey별로 묶어 헤더 1개 + 공정별 값 서브행으로 표시(이전엔 공정마다 개별
  // 항목이라 여러 공정이 같은 후보를 내면 라벨이 중복 노출됨).
  const grouped = new Map<string, CandidateFeature[]>();
  for (const c of candidates) {
    ((grouped.get(c.featureKey) || grouped.set(c.featureKey, []).get(c.featureKey)) as CandidateFeature[]).push(c);
  }
  return (
    <div className="va-suggest-group">
      <div className="va-suggest-group-title">참고 후보 (자동입력 금지)</div>
      {candidates.length > 0 && (
        <ul className="va-suggest-list">
          {[...grouped.entries()].map(([featureKey, entries]) => {
            const first = entries[0];
            const label = flatCandidateLabel(first);
            return (
              <li key={featureKey} className="va-suggest-card">
                <div className="va-suggest-head">
                  <span className="va-suggest-value">
                    {label !== null
                      ? <>{label} — <span className="va-hint">{displayCandidateReason(first.reason)}</span></>
                      : <><code className="va-suggest-key">{featureKey}</code>: {String(first.value)} — <span className="va-hint">{displayCandidateReason(first.reason)}</span></>}
                  </span>
                  <span className="va-flag-pill tone-warning" title="관찰값 — 자동입력 안 함">참고만</span>
                </div>
                <ul className="va-subrows">
                  {entries.map((c, idx) => {
                    // 6.0-18: 골격 검수·근거 배선. jobEv는 (processId, featureKey) 1:1이라 서브행이 부착점
                    // (그룹 헤더는 여러 공정 jobEv 합성이 필요해 금지 — 계획 §1).
                    const { processId, rowKey, jobEv } = flatCandidateRowRef(c, processEvidenceByProcessId);
                    const p = processes.find((pp) => pp.id === processId);
                    const expanded = expandedEvidence === rowKey;
                    // serverMode 가드를 컴포넌트에서도 명시(renderSkeletonReview 내부 게이트와 이중). 부모
                    // state인 expandedEvidence는 모드 전환(환자 전환 등) 후에도 rowKey가 남을 수 있어
                    // 상세 영역까지 함께 막는다.
                    const skeleton = serverMode ? renderSkeletonReview(rowKey, jobEv) : null;
                    // Left/Right 4키는 candidate value가 raw ratio(convertClipFeaturesToPerDay가 그대로
                    // 보존)라 jobEv.contributions[].perDayValue도 ratio 그대로다. contribFormula는 그
                    // perDayValue를 "환산 완료값"으로 보고 그대로 찍어(예: "0.2 시간/일 = 자세비율 0.2 ×
                    // 활동 200분/일 ÷ 60") 미환산 비율을 환산값처럼 오표시한다(서브행은 formatCandidateSubValue로
                    // 이미 정상 환산 — 0.7 시간/일). renderCandidateRow의 trunkFlexionOver45Duration displayJobEv
                    // 패치(:1023-1032)와 동일하게, 근거 패널에 넘기기 직전에만 perDayValue를
                    // candidateHoursPerDay 결과로 보정한다(골격 검수는 원본 jobEv를 그대로 씀 — segments·fusion엔
                    // 영향 없음).
                    const displayJobEv = (RATIO_HOURS_CANDIDATE_KEYS.has(c.featureKey) && jobEv)
                      ? {
                          ...jobEv,
                          contributions: (jobEv.contributions || []).map((ct) => ({
                            ...ct, perDayValue: candidateHoursPerDay(c.value, p?.activeMinutesPerDay),
                          })),
                        }
                      : jobEv;
                    return (
                      <li key={processId || idx} className="va-subrow">
                        {p?.name || '(공정 미상)'}: {formatCandidateSubValue(c, p?.activeMinutesPerDay)}
                        {serverMode && (
                          <button type="button" className="btn btn-secondary btn-sm va-subrow-btn" data-readonly-allow
                            onClick={() => onToggleEvidence(expanded ? null : rowKey)}>
                            {expanded ? '근거 닫기' : '왜 이 값?'}
                          </button>
                        )}
                        {serverMode && (expanded || skeleton) && (
                          <div className="va-suggest-details">
                            {expanded && renderEvidencePanel(displayJobEv, VIDEO_FEATURE_TARGETS[c.featureKey as FeatureKey]?.unit || null)}
                            {skeleton}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {/* evidence는 transient(영속화 안 함) — 새로고침·환자 재진입 후에는 골격·근거가 사라진다. 그 상황을
          버그로 오인하지 않도록 블록당 한 번만 안내(서버 모드 한정 — mock은 원래 검수 대상 아님). 6.0-18. */}
      {serverMode && candidates.length > 0
        && !hasAnyFlatEvidence(candidates, processEvidenceByProcessId) && (
        <p className="va-hint va-hint-block">
          ※ 골격 검수·근거는 현재 분석 세션에서만 제공됩니다 — 다시 분석하면 표시됩니다.
        </p>
      )}
      {/* 시점 하드 게이트 안내(6.0-10): 손목 굴곡/편위는 같은 2D 값이라 시점별로만 노출 */}
      {suppressedCandidates.length > 0 && (
        <p className="va-hint va-hint-block">
          손목 각도는 측면 클립에서 굴곡만, 정면 클립에서 편위만 표시됩니다 — 해당 시점 클립이 없어 일부 후보는 숨겨졌습니다.
        </p>
      )}
    </div>
  );
}

// 영상 분석 화면의 참고 후보(candidate) 순수 헬퍼(P2-75c, Phase 2 C9 구간 D) — 비율의 분/일·시간/일 환산, flat 후보 라벨·서브행 값·근거 연결,
// 작업 단위 후보 제외. fmtNum만 근거 헬퍼(videoStepEvidence)에서 가져온다. 본문은 VideoAnalysisStep에 있던 그대로다.
import { REPETITION_FEATURE_KEYS } from './videoFeatureProfiles';
import { VIDEO_FEATURE_TARGETS } from '@wr/contracts/index';
import type { FeatureKey } from '@wr/contracts/index';
import type { CandidateFeature, EvidenceByFeatureKey, FeatureEvidence } from './videoStepTypes';
import { fmtNum } from './videoStepEvidence';

/**
 * candidate 비율(posture_ratio 0~1)을 공정 활동시간(분/일)으로 환산한 분/일. 활동시간 없으면 null.
 * 순수 함수(테스트 대상). 표시 전용 — candidate value 자체는 비율을 유지한다.
 */
export function candidateMinutesPerDay(ratio: unknown, activeMinutesPerDay: number | null | undefined): number | null {
  if (activeMinutesPerDay == null || typeof ratio !== 'number') return null;
  return Math.round(ratio * activeMinutesPerDay);
}

/**
 * candidate 비율(posture_ratio 0~1)을 공정 활동시간(분/일)으로 환산한 **시간/일**(candidateMinutesPerDay의
 * 시간 단위 버전, 6.0-17). unit이 hours_per_day인 candidate(예: repetitiveMedium/FastHoursLeft/Right)에
 * 사용 — candidate는 raw ratio를 보존하므로(convertClipFeaturesToPerDay) 표시 시점에 환산한다.
 */
export function candidateHoursPerDay(ratio: unknown, activeMinutesPerDay: number | null | undefined): number | null {
  const minutes = candidateMinutesPerDay(ratio, activeMinutesPerDay);
  return minutes == null ? null : Math.round((minutes / 60) * 10) / 10;
}

// 6.0-16 Left/Right 4키만 raw ratio(posture_ratio, convertClipFeaturesToPerDay가 그대로 보존)라
// candidateHoursPerDay 환산 대상. vibrationToolUseDurationCandidate도 unit은 같은 hours_per_day지만
// Python 계산 블록 자체가 없는 mock 전용 placeholder라 value가 ratio가 아님(리뷰 반영) — unit만으로
// 분기하면 이 값이 ratio×활동시간/60으로 잘못 부풀려진다. 그래서 unit이 아니라 featureKey로 명시 분기.
export const RATIO_HOURS_CANDIDATE_KEYS = new Set([
  'repetitiveMediumHoursLeft', 'repetitiveMediumHoursRight',
  'repetitiveFastHoursLeft', 'repetitiveFastHoursRight',
]);

/**
 * flat 참고 후보의 공정별 서브행 값 문자열(6.0-17). RATIO_HOURS_CANDIDATE_KEYS(신규 Left/Right 4키)만
 * candidateHoursPerDay로 시간/일 환산, cycles_per_minute·degrees는 기존처럼 원값+단위, 그 외
 * (vibrationToolUseDurationCandidate·categorical·boolean 등)는 원값 그대로(환산 없음).
 */
export function formatCandidateSubValue(c: CandidateFeature, activeMinutesPerDay: number | null | undefined): string {
  if (RATIO_HOURS_CANDIDATE_KEYS.has(c.featureKey)) {
    const h = candidateHoursPerDay(c.value, activeMinutesPerDay);
    return h != null ? `약 ${h} 시간/일` : '(활동시간 입력 시 시간/일 표시)';
  }
  const unit = VIDEO_FEATURE_TARGETS[c.featureKey as FeatureKey]?.unit;
  const n = Math.round((Number(c.value) || 0) * 10) / 10;
  if (unit === 'cycles_per_minute') return `약 ${n} 회/분`;
  if (unit === 'degrees') return `약 ${n}°`;
  return String(fmtNum(c.value));
}

/**
 * flat "참고 후보" 서브행 → { processId, rowKey, jobEv } (6.0-18: flat 골격 검수 배선).
 * jobEv는 (processId, featureKey) 2단 키(buildProcessEvidence 산출물)라 서브행이 1:1 대응.
 * evidence는 transient(영속화 안 함) → mock·리로드·공정삭제 시 null로 떨어지고 호출측(renderSkeletonReview)이
 * 자연히 버튼을 숨긴다(fail-safe). 렌더와 동일 경로를 테스트가 검증하도록 분리.
 */
export function flatCandidateRowRef(
  c: CandidateFeature, processEvidenceByProcessId: Record<string, EvidenceByFeatureKey> = {},
): { processId: string | null; rowKey: string; jobEv: FeatureEvidence | null } {
  const processId = (c.processIds || [])[0] || null;
  const featMap = (processId && processEvidenceByProcessId[processId]) || null;
  const jobEv = (featMap && featMap[c.featureKey]) || null;
  return { processId, rowKey: `flat:${processId || 'noproc'}:${c.featureKey}`, jobEv };
}

/** flat 후보 중 하나라도 evidence가 있는가 — 없으면 "세션 한정" 안내를 띄운다(6.0-18). */
export function hasAnyFlatEvidence(entries: CandidateFeature[] = [], processEvidenceByProcessId: Record<string, EvidenceByFeatureKey> = {}): boolean {
  return entries.some((c) => flatCandidateRowRef(c, processEvidenceByProcessId).jobEv != null);
}

/**
 * flat "참고 후보"에서 task-scope 모듈(경추·척추) candidate를 제외한다(작업 단위 섹션에서 표시하므로 중복 방지).
 * 렌더와 동일 경로를 테스트가 검증하도록 순수 함수로 분리.
 */
export function excludeTaskScopeCandidates(candidateFeatures: CandidateFeature[] = [], taskScopeModuleIds: string[] = []): CandidateFeature[] {
  return candidateFeatures.filter((c) => !taskScopeModuleIds.includes(VIDEO_FEATURE_TARGETS[c.featureKey as FeatureKey]?.moduleId));
}

/**
 * flat "참고 후보" 표시 라벨. 반복빈도(6.0-11)는 raw featureKey/value 대신 "어깨/팔꿈치 반복: 약 N 회/분"으로.
 * 알 수 없는 featureKey는 null 반환 → 호출측이 기존 generic 렌더(featureKey: value) 유지.
 */
// 6.0-17: 어깨 반복 밴드별 시간합 Left/Right — raw ratio라 값은 공정별 서브행(candidateHoursPerDay)에서
// 표시하고, 여기 라벨은 값 없는 카테고리명만(단일 숫자로 대표할 수 없음 — 공정마다 다름).
const BAND_SIDE_LABEL: Record<string, string> = {
  repetitiveMediumHoursLeft: '어깨 반복(중간속도, 좌측)',
  repetitiveMediumHoursRight: '어깨 반복(중간속도, 우측)',
  repetitiveFastHoursLeft: '어깨 반복(빠른속도, 좌측)',
  repetitiveFastHoursRight: '어깨 반복(빠른속도, 우측)',
};

export function flatCandidateLabel(c: CandidateFeature): string | null {
  const n = Math.round((Number(c.value) || 0) * 10) / 10;
  if (REPETITION_FEATURE_KEYS.has(c.featureKey)) {
    const part = c.featureKey === 'shoulderRepetitionRate' ? '어깨' : '팔꿈치';
    return `${part} 반복: 약 ${n} 회/분`;
  }
  // 6.0-10 손목: 반복(회/분)·굴곡/편위(°).
  if (c.featureKey === 'wristRepetitionRate') return `손목 반복: 약 ${n} 회/분`;
  if (c.featureKey === 'wristFlexionPeakAngle') return `손목 굴곡(최대): 약 ${n}°`;
  if (c.featureKey === 'wristDeviationPeakAngle') return `손목 요/척측 편위(최대): 약 ${n}°`;
  if (BAND_SIDE_LABEL[c.featureKey]) return BAND_SIDE_LABEL[c.featureKey];
  return null;
}

// Mock feature 생성기 (§8.16 6.0-2). 실제 RTMPose 추론 없이 매핑/적용/provenance
// 세로조각을 검증하기 위한 임시 구현 — M2(6.0-5/6.0-6)에서 실제 계산기로 교체된다.
// 계약(VideoFeatureValue/VIDEO_FEATURE_TARGETS)은 동일하게 유지하므로 교체 시 소비측 무변경.
import { VIDEO_FEATURE_TARGETS } from '@contracts/index';
import {
  REPETITION_FEATURE_KEYS, REPETITION_PROFILES, HAND_WRIST_FEATURE_KEYS, REPETITION_BAND_FEATURE_KEYS,
} from './videoFeatureProfiles';

// featureKey별 대표 mock 값(결정적 — 테스트 안정성). 단위·종류는 VIDEO_FEATURE_TARGETS 기준.
const MOCK_VALUES = {
  squatDuration: 180, // minutes/day
  overheadHours: 1.8, // hours/day
  repetitiveMediumHours: 2.0,
  repetitiveFastHours: 0.5,
  // 6.0-16: candidate는 raw ratio(0~1) 보존(trunkFlexionOver45Duration과 동일 패턴) — 분/일이 아니라
  // 클립 내 밴드 시간 비율. 좌/우 상이 값으로 UI에서 좌우 분리 확인 용이하게.
  repetitiveMediumHoursLeft: 0.12,
  repetitiveMediumHoursRight: 0.18,
  repetitiveFastHoursLeft: 0.07,
  repetitiveFastHoursRight: 0.03,
  cyclesPerDay: 1200,
  cycleSeconds: 6,
  neckFlexionOver20HoursPerDay: 1.2,
  neckForcedFlexion: 'forward_flexion', // categorical (forced_neck_posture 굴곡 성분)
  // candidate (모듈 자동입력 금지)
  trunkPostureG: 'G3',
  trunkFlexionOver45Duration: 0.32, // 비율(클립 내 45°↑ 시간) — 분/일은 클라가 활동시간으로 환산
  neckCombinedFlexRot: 'flexion_rotation',
  vibrationToolUseDurationCandidate: 1.0,
  suspectedKneeTwist: true,
  shoulderRepetitionRate: 14, // cycles/min (6.0-11 candidate)
  elbowRepetitionRate: 22, // cycles/min
  // 6.0-10 손목(wholebody=hand-wrist profile만). 굴곡/편위는 시점이 라벨 결정 → 보기용 다른 값.
  wristRepetitionRate: 28, // cycles/min
  wristFlexionPeakAngle: 42, // degrees (sagittal 클립에서만 노출)
  wristDeviationPeakAngle: 18, // degrees (frontal 클립에서만 노출)
};

// 신뢰도: auto(높음) / auto-review(중간) / candidate(낮음). 결정적 placeholder —
// 실제 임계값은 6.0-B2 검증으로 확정(§8.9).
const CONFIDENCE_BY_MODE = { auto: 0.82, 'auto-review': 0.7, candidate: 0.5 };

export const CANDIDATE_REASONS = {
  suspectedKneeTwist: '무릎 비틀림은 2D 영상에서 저신뢰 — 수기 확인 필요',
  vibrationToolUseDurationCandidate: '공구 사용시간 후보만 — 진동 가속도 측정 불가',
  trunkPostureG: 'G1~G11은 하중 위치·작업유형 반영 — 수기 확인 필수',
  trunkFlexionOver45Duration: '척추 45°↑ 굴곡 시간은 관찰값 — 작업 부담 판정은 수기 확인',
  neckCombinedFlexRot: '회전·복합자세는 2D 저신뢰 — 임계 미만 제안 금지',
  shoulderRepetitionRate: '어깨 상완거상 반복 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증',
  elbowRepetitionRate: '팔꿈치 굴곡 반복 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증',
  wristRepetitionRate: '손목 굽힘 반복 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증',
  wristFlexionPeakAngle: '손목 굴곡 peak 추정(참고용·측면 클립) — 자동입력 금지, 임계 6.0-B2 미검증',
  wristDeviationPeakAngle: '손목 요/척측 편위 peak 추정(참고용·정면 클립) — 자동입력 금지, 임계 6.0-B2 미검증',
  repetitiveMediumHoursLeft: '어깨 상완거상 반복(중간속도, 좌측) 시간 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증',
  repetitiveMediumHoursRight: '어깨 상완거상 반복(중간속도, 우측) 시간 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증',
  repetitiveFastHoursLeft: '어깨 상완거상 반복(빠른속도, 좌측) 시간 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증',
  repetitiveFastHoursRight: '어깨 상완거상 반복(빠른속도, 우측) 시간 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증',
};

function buildFeatureValue(featureKey) {
  const target = VIDEO_FEATURE_TARGETS[featureKey];
  if (!target) return null;
  const raw = MOCK_VALUES[featureKey];
  const confidence = CONFIDENCE_BY_MODE[target.mode] ?? 0.6;

  if (target.mode === 'candidate') {
    return {
      kind: 'candidate',
      value: raw,
      reason: CANDIDATE_REASONS[featureKey] || '자동입력 금지 후보',
      confidence,
      autoSuggestAllowed: false,
      requiresManualReview: true,
      warnings: [],
    };
  }

  const base = {
    confidence,
    // candidate가 아닌 feature는 자동제안 대상. auto-review는 제안하되 수기확인 강제.
    autoSuggestAllowed: true,
    requiresManualReview: target.mode === 'auto-review',
    warnings: [],
  };

  if (target.unit !== null) {
    return { ...base, kind: 'numeric', value: raw, unit: target.unit };
  }
  // unit 없고 candidate 아님 → categorical (예: forced_neck_posture)
  return { ...base, kind: 'categorical', value: String(raw) };
}

/**
 * 한 클립/공정에 대해 요청된 feature들의 mock VideoFeatureMap을 생성한다.
 * @param {string[]} requestedFeatures - FeatureKey 배열
 * @param {string} [profile] - analysisProfile. 반복빈도 feature(6.0-11)는 repetition-upper-limb/
 *   hand-wrist profile에서만 산출한다(REPETITION_PROFILES). 어깨 반복 밴드별 시간합(6.0-16)은
 *   repetition-upper-limb에서만(REPETITION_BAND_FEATURE_KEYS). 그 외 feature는 profile 무관.
 * @returns {Object} VideoFeatureMap (featureKey → VideoFeatureValue)
 */
export function generateMockFeatures(requestedFeatures = [], profile = 'posture-basic') {
  const repOk = REPETITION_PROFILES.has(profile); // 반복(어깨/팔꿈치)은 상지반복/손목 profile에서만
  const handWristOk = profile === 'hand-wrist';   // 손목(wholebody)은 hand-wrist profile에서만(6.0-10)
  const bandOk = profile === 'repetition-upper-limb'; // 6.0-16: 밴드별 시간합은 상지반복 profile에서만
  const map = {};
  for (const key of requestedFeatures) {
    if (REPETITION_FEATURE_KEYS.has(key) && !repOk) continue;
    if (HAND_WRIST_FEATURE_KEYS.has(key) && !handWristOk) continue;
    if (REPETITION_BAND_FEATURE_KEYS.has(key) && !bandOk) continue;
    const value = buildFeatureValue(key);
    if (value) map[key] = value;
  }
  return map;
}

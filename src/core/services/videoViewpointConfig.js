// 시점 융합 정책 — 클라 번들 단일 source (6.0-6b, PR D3b, §8.6.1).
//
// 융합은 클라(videoAnalysisRun)에서 돌므로 정책도 번들 가능한 이 파일에 둔다(Python feature_config 아님 —
// 브라우저가 런타임에 읽을 수 없음, confidence threshold와 동일 이유). 각도→관절 인덱스 같은 '측정' 정의만
// Python feature_config가 갖는다(역할 분리).
//
// preferredViewpoint·viewpoint 성분(1.0/0.5)은 threshold가 아니라 **결정적 매핑**(평면 적합성 상대비교용).
// conflictThreshold만 수치 임계값이라 기본 비활성(검증 전 경고 차단, 실값 6.0-B2).

export const VIDEO_VIEWPOINT_CONFIG_VERSION = 'vvc-0.0.0';

// featureKey → 가장 잘 보이는 평면(§8.6.1: 측면=체간전굴·무릎·목굴곡 / 정면=어깨외전·목회전·비틀림).
// 미선언 = 시점 선호 없음(융합은 confidence로만, viewpoint 성분 미부여).
export const PREFERRED_VIEWPOINT = {
  squatDuration: 'sagittal',
  trunkPostureG: 'sagittal',
  neckFlexionOver20HoursPerDay: 'sagittal',
  neckForcedFlexion: 'sagittal',
  overheadHours: 'frontal',
  neckCombinedFlexRot: 'frontal',
  suspectedKneeTwist: 'frontal',
};

// featureKey별 INTER_VIEW_CONFLICT 임계값(같은 featureKey 두 시점 값 차이). 기본 전부 비활성(null).
// 실값은 6.0-B2 검증으로 확정 — 검증 전 추측값으로 경고/저신뢰 처리하지 않는다.
export const DEFAULT_CONFLICT_THRESHOLDS = {
  // 6.0-B2에서 채움. (예) trunkPostureG: 15  // degrees
};

const KNOWN_PLANES = ['sagittal', 'frontal'];

/**
 * 시점 적합성 confidence 성분(결정적 매핑, threshold 아님).
 * preferred=1.0, known-non-preferred=0.5, other/unknown 또는 선호없음 = null(overall min 제외 — 맹목 페널티 회피).
 */
export function viewpointComponent(viewpoint, featureKey) {
  const pref = PREFERRED_VIEWPOINT[featureKey];
  if (!pref) return null;
  if (viewpoint === pref) return 1.0;
  if (KNOWN_PLANES.indexOf(viewpoint) >= 0) return 0.5;
  return null;
}

/**
 * 경쟁 tier(높을수록 우선): preferred(2) > known-non-preferred(1) > other/unknown(0).
 * `other`/unknown이 overall min에서 빠져도 known preferred를 이기지 못하게 1차 정렬키로 쓴다.
 * 선호 없는 feature는 known 평면 모두 1(동급) — confidence로만 정렬.
 */
export function viewpointTier(viewpoint, featureKey) {
  const pref = PREFERRED_VIEWPOINT[featureKey];
  if (!pref) return KNOWN_PLANES.indexOf(viewpoint) >= 0 ? 1 : 0;
  if (viewpoint === pref) return 2;
  if (KNOWN_PLANES.indexOf(viewpoint) >= 0) return 1;
  return 0;
}

/** 이 featureKey를 이 시점에서 읽으면 non-preferred인가(선호가 정의돼 있고 일치하지 않음). */
export function isNonPreferred(viewpoint, featureKey) {
  const pref = PREFERRED_VIEWPOINT[featureKey];
  return !!pref && viewpoint !== pref;
}

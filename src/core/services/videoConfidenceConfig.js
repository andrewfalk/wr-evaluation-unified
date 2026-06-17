// confidence 게이팅 정책 — 클라 번들 단일 source (6.0-6b, PR D3a, §8.8).
//
// 역할 분리: Python feature_calc는 측정(confidenceBreakdown)만 내고, "저신뢰 → 자동제안 금지"
// 판단(threshold)은 여기서 한다. services/pose-inference/feature_config.json은 Python 측정
// 파라미터 전용이라 브라우저가 런타임에 읽을 수 없으므로, 게이팅 정책은 번들 가능한 이 파일에 둔다.
//
// 기본은 전부 비활성(threshold 없음) → 게이팅 없음(autoSuggestAllowed 기본값 유지).
// 실제 임계값은 6.0-B2 검증(수기 annotation 대비 오차)으로 확정한다 — 검증 전에 추측한 값으로
// 자동제안을 막지 않는다(§8.9). 테스트는 thresholds를 명시 주입해 메커니즘만 검증한다.

export const VIDEO_CONFIDENCE_CONFIG_VERSION = 'vcc-0.0.0-disabled';

// feature별 confidence threshold. 미선언/빈 객체 = 비활성.
// 활성 시 형태(예시, 값은 6.0-B2): { overall: 0.70, visibility: 0.65, keypoint, tracking, viewpoint }
// usableFrameRatio는 게이팅 입력이 아니다(정보용) — 여기서 받지 않는다.
export const DEFAULT_CONFIDENCE_THRESHOLDS = {
  // 6.0-B2에서 채움. (예) squatDuration: { overall: 0.70, visibility: 0.65 }
};

// 게이팅에 쓰는 confidence 성분(usableFrameRatio 제외 — §8.8 D3a).
const GATED_COMPONENTS = ['overall', 'keypoint', 'visibility', 'tracking', 'viewpoint'];

/**
 * feature 하나의 저신뢰 게이팅 판정.
 * threshold가 없거나 baseFlags가 이미 자동제안 불가면 그대로 통과(게이팅 없음).
 * 임계 미만 성분이 있으면 autoSuggestAllowed=false + LOW_CONFIDENCE_<성분> 사유(warnings로 운반).
 *
 * @param {string} featureKey
 * @param {{confidence:number, confidenceBreakdown?:object}} cf - overall(=confidence) + 세분 지표
 * @param {{autoSuggestAllowed:boolean, requiresManualReview:boolean}} baseFlags
 * @param {object} [thresholds] - featureKey → {성분:임계값}. 기본 DEFAULT_CONFIDENCE_THRESHOLDS(비활성).
 * @returns {{autoSuggestAllowed:boolean, gateWarnings:string[]}}
 */
export function resolveAutoSuggest(featureKey, cf, baseFlags, thresholds) {
  const table = thresholds || DEFAULT_CONFIDENCE_THRESHOLDS;
  const th = table && table[featureKey];
  if (!th || !baseFlags.autoSuggestAllowed) {
    return { autoSuggestAllowed: baseFlags.autoSuggestAllowed, gateWarnings: [] };
  }
  const breakdown = cf.confidenceBreakdown || null;
  const gateWarnings = [];
  let blocked = false;
  for (const comp of GATED_COMPONENTS) {
    if (th[comp] == null) continue;
    const v = comp === 'overall' ? cf.confidence : (breakdown ? breakdown[comp] : undefined);
    if (v != null && v < th[comp]) {
      blocked = true;
      gateWarnings.push('LOW_CONFIDENCE_' + comp.toUpperCase());
    }
  }
  return { autoSuggestAllowed: blocked ? false : baseFlags.autoSuggestAllowed, gateWarnings };
}

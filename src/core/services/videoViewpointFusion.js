// 시점 융합 (클립 → 공정), §8.6.1, PR D3b. 한 공정의 다중 시점 클립이 산출한 intrinsic
// ClipFeatureSet들을 featureKey별로 "가장 잘 보이는 평면"에서 읽어 하나로 조립한다(3D 융합 아님).
//
// 융합은 per-day 환산 **전**(intrinsic 단계)에 한다 — 한 공정의 다중 시점 클립은 동일 activeMinutesPerDay를
// 공유하므로 융합 후 1회 환산하면 되고, confidenceBreakdown 보존이 깔끔하다.
import {
  viewpointComponent, viewpointTier, isNonPreferred, DEFAULT_CONFLICT_THRESHOLDS,
} from './videoViewpointConfig';

export const NON_PREFERRED_WARNING = 'NON_PREFERRED_VIEWPOINT';
export const CONFLICT_WARNING = 'INTER_VIEW_CONFLICT';

// 한 feature를 시점 보정: overall = min(측정 confidence, viewpoint 성분). vp=null이면 보정 없음.
function adjusted(viewpoint, featureKey, cf) {
  const vp = viewpointComponent(viewpoint, featureKey);
  const confidence = vp == null ? cf.confidence : Math.min(cf.confidence, vp);
  return { viewpoint, cf, vp, confidence, tier: viewpointTier(viewpoint, featureKey) };
}

// 융합된 feature 값 1개: 승리 contribution(1차 tier, 2차 보정 overall) 기준 + viewpoint breakdown + 경고.
function fuseFeature(featureKey, cands, conflictThreshold) {
  const winner = cands.reduce((a, b) => {
    if (b.tier !== a.tier) return b.tier > a.tier ? b : a;          // 1차: 시점 tier(other가 preferred 못 이김)
    if (b.confidence !== a.confidence) return b.confidence > a.confidence ? b : a; // 2차: 보정 overall
    return a;                                                        // 안정(선행 우선)
  });
  const warnings = [...(winner.cf.warnings || [])];
  // non-preferred 시점에서 채택 → 경고만(차단 아님).
  if (isNonPreferred(winner.viewpoint, featureKey) && warnings.indexOf(NON_PREFERRED_WARNING) < 0) {
    warnings.push(NON_PREFERRED_WARNING);
  }
  // INTER_VIEW_CONFLICT: 임계값 설정(기본 비활성) + numeric + 두 시점 값 차이 >= 임계.
  if (cands.length >= 2 && conflictThreshold != null && winner.cf.kind === 'numeric') {
    const nums = cands.filter((c) => c.cf.kind === 'numeric').map((c) => Number(c.cf.value));
    if (nums.length >= 2 && (Math.max(...nums) - Math.min(...nums)) >= conflictThreshold
        && warnings.indexOf(CONFLICT_WARNING) < 0) {
      warnings.push(CONFLICT_WARNING);
    }
  }
  const fused = { ...winner.cf, confidence: winner.confidence, warnings };
  // viewpoint 성분을 breakdown에 채운다(D3a에서 omit했던 부분). 단, 기존 breakdown(keypoint/visibility)이
  // 있을 때만 — 없는 출력(mock/구 producer)에 viewpoint만 넣으면 필수 성분 누락으로 계약 위반.
  if (winner.vp != null && winner.cf.confidenceBreakdown) {
    fused.confidenceBreakdown = { ...winner.cf.confidenceBreakdown, viewpoint: winner.vp };
  }
  return fused;
}

/**
 * 공정 내 다중 시점 클립의 ClipFeatureSet들을 시점 융합해 하나로(§8.6.1).
 * @param {Array<{viewpoint:string, clipFeatureSet:object}>} entries - 시점별 intrinsic ClipFeatureSet
 * @param {object} [opts]
 * @param {object} [opts.conflictThresholds] - featureKey→임계값. 기본 비활성(6.0-B2 전 경고 없음).
 * @returns {object|null} 융합 ClipFeatureSet(ClipFeatureSetSchema 호환). entries 비면 null.
 */
export function fuseClipFeatureSets(entries, { conflictThresholds = DEFAULT_CONFLICT_THRESHOLDS } = {}) {
  const valid = (entries || []).filter((e) => e && e.clipFeatureSet);
  if (valid.length === 0) return null;

  // featureKey별 후보 수집(시점 보정).
  const byKey = {};
  for (const e of valid) {
    for (const [key, cf] of Object.entries(e.clipFeatureSet.features || {})) {
      (byKey[key] || (byKey[key] = [])).push(adjusted(e.viewpoint, key, cf));
    }
  }
  const features = {};
  for (const [key, cands] of Object.entries(byKey)) {
    features[key] = fuseFeature(key, cands, conflictThresholds[key]);
  }

  // 메타: 단일이면 원본 보존(tracking/quality 유지), 다중이면 합성(tracking/quality는 시점간 모호 → 생략).
  const base = valid[0].clipFeatureSet;
  if (valid.length === 1) return { ...base, features };
  return {
    schemaVersion: 1,
    featureConfigVersion: base.featureConfigVersion,
    clipRef: valid.map((e) => e.clipFeatureSet.clipRef).join('+'),
    clipDurationMs: Math.max(...valid.map((e) => e.clipFeatureSet.clipDurationMs)),
    analyzedFrames: valid.reduce((a, e) => a + e.clipFeatureSet.analyzedFrames, 0),
    features,
  };
}

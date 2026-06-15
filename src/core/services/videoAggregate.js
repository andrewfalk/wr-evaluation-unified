// 공정 집계 (공정 → 직업), §8.6.2. job-scope 모듈(무릎·어깨)에서 여러 공정의
// feature를 직업 단위 하나로 합친다. tasks[] 모듈(척추·경추)은 공정≈task 1:1이라
// 집계 없이 공정별 task로 직접 매핑하므로 이 함수를 쓰지 않는다.
import { VIDEO_FEATURE_TARGETS } from '@contracts/index';

// featureKey별 집계 방식.
//  - weightedSum: 누적형(시간·횟수) = Σ(value × share/100)
//  - weightedAvg: 빈도/속도형(1회 소요시간) = Σ(value × share) / Σ(share)
//  - max: 최댓값형(피크 각도 등)
//  - or: boolean OR
//  - pick: 대표 1개(categorical/candidate) — 최고 신뢰도 채택
const AGG = {
  squatDuration: 'weightedSum',
  overheadHours: 'weightedSum',
  repetitiveMediumHours: 'weightedSum',
  repetitiveFastHours: 'weightedSum',
  cyclesPerDay: 'weightedSum',
  neckFlexionOver20HoursPerDay: 'weightedSum',
  cycleSeconds: 'weightedAvg',
  suspectedKneeTwist: 'or',
  trunkPostureG: 'pick',
  neckForcedFlexion: 'pick',
  neckCombinedFlexRot: 'pick',
  vibrationToolUseDurationCandidate: 'pick',
};

const aggMethod = (featureKey) => AGG[featureKey] || 'pick';

// share(0~100) 정규화: 음수·비정상은 0으로. 비율(0~1)로 변환은 호출부에서 /100.
const shareFraction = (share) => (Number.isFinite(share) ? Math.max(0, share) : 0) / 100;

function aggregateOne(featureKey, contributions) {
  // contributions: [{ value: VideoFeatureValue|null, share: number(0~100) }]
  const method = aggMethod(featureKey);
  const present = contributions.filter((c) => c.value != null);
  if (present.length === 0) return null;

  // 신뢰도는 보수적으로 최솟값(가장 약한 공정 기준).
  const minConfidence = Math.min(...present.map((c) => c.value.confidence ?? 0));
  const warnings = [...new Set(present.flatMap((c) => c.value.warnings || []))];
  const sample = present[0].value;

  if (method === 'or') {
    const value = present.some((c) => c.value.value === true);
    return { ...sample, value, confidence: minConfidence, warnings };
  }
  if (method === 'pick') {
    const best = present.reduce((a, b) => (b.value.confidence > a.value.confidence ? b : a));
    return { ...best.value, warnings };
  }
  if (method === 'max') {
    const value = Math.max(...present.map((c) => Number(c.value.value) || 0));
    return { ...sample, value, confidence: minConfidence, warnings };
  }
  if (method === 'weightedSum') {
    // 누적형: Σ(value × share/100). 시간점유율이 100% 미만이면 그만큼만 누적.
    const value = present.reduce(
      (acc, c) => acc + (Number(c.value.value) || 0) * shareFraction(c.share), 0
    );
    return { ...sample, value, confidence: minConfidence, warnings };
  }
  // weightedAvg: 빈도/1회시간 — Σ(value × w)/Σw. 가중치 합 0이면 단순 평균으로 폴백.
  let num = 0;
  let den = 0;
  for (const c of present) {
    const w = shareFraction(c.share);
    num += (Number(c.value.value) || 0) * w;
    den += w;
  }
  const value = den > 0
    ? num / den
    : present.reduce((a, c) => a + (Number(c.value.value) || 0), 0) / present.length;
  return { ...sample, value, confidence: minConfidence, warnings };
}

/**
 * 공정별 VideoFeatureMap을 직업 단위 하나로 집계한다(job-scope).
 * @param {Array<{share:number, features:Object}>} entries - 공정별 {시간점유율(%), VideoFeatureMap}
 * @returns {Object} 집계된 VideoFeatureMap
 */
export function aggregateProcessFeatures(entries = []) {
  if (entries.length === 0) return {};

  // 등장하는 모든 featureKey 수집
  const keys = new Set();
  for (const e of entries) for (const k of Object.keys(e.features || {})) keys.add(k);

  const result = {};
  for (const key of keys) {
    const contributions = entries.map((e) => ({ value: e.features?.[key] ?? null, share: e.share }));
    const agg = aggregateOne(key, contributions);
    if (agg) result[key] = agg;
  }
  return result;
}

/** featureKey의 집계 방식 조회(테스트/UI용). */
export function getAggregationMethod(featureKey) {
  return aggMethod(featureKey);
}

/** 해당 featureKey가 어느 모듈/scope로 가는지(VIDEO_FEATURE_TARGETS 기반). */
export function getFeatureTarget(featureKey) {
  return VIDEO_FEATURE_TARGETS[featureKey] || null;
}

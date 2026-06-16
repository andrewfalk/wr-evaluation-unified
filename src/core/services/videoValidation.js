// 검증 오차 계산기 (§8.9, 6.0-3.5). 영상 추출값(VideoFeatureMap)과 gold-standard
// annotation을 비교해 변수별 오차를 산출한다. 순수 함수 — 추론 의존성 없음.
// 실제 검증셋·임계값 확정은 6.0-B2(M3); 여기서는 계산 토대만 제공한다.

// 단위 → 오차 지표 종류. 각도=절대오차(MAE), 시간·1회시간=오차율, 횟수=오차율.
export function metricKind(unit) {
  switch (unit) {
    case 'degrees':
      return 'angle';
    case 'minutes_per_day':
    case 'hours_per_day':
    case 'seconds_per_cycle':
      return 'time';
    case 'cycles_per_day':
    case 'cycles_per_minute':
      return 'count';
    case 'ratio':
      return 'ratio';
    default:
      return 'other';
  }
}

export function numericError(extracted, gold) {
  const absError = Math.abs(extracted - gold);
  const errorRate = gold !== 0 ? absError / Math.abs(gold) : (absError === 0 ? 0 : Infinity);
  return { absError, errorRate };
}

// 단일 feature 비교. 누락/타입불일치는 status로 표시(집계에서 제외).
export function compareFeature(featureKey, extractedValue, goldValue) {
  if (goldValue == null && extractedValue == null) return null;
  if (goldValue == null) return { featureKey, status: 'no_gold' };
  if (extractedValue == null) return { featureKey, status: 'missing_extracted' };

  if (goldValue.kind === 'numeric') {
    if (extractedValue.kind !== 'numeric') return { featureKey, status: 'type_mismatch' };
    // 단위 불일치는 비교 자체가 무의미 → 실패 처리(시/분 혼동 등 방지).
    if (extractedValue.unit !== goldValue.unit) {
      return { featureKey, status: 'unit_mismatch', extractedUnit: extractedValue.unit, goldUnit: goldValue.unit };
    }
    const { absError, errorRate } = numericError(extractedValue.value, goldValue.value);
    return {
      featureKey, kind: 'numeric', metric: metricKind(goldValue.unit), unit: goldValue.unit,
      extracted: extractedValue.value, gold: goldValue.value, absError, errorRate,
    };
  }
  if (goldValue.kind === 'boolean') {
    // kind까지 일치해야 한다 — candidate/numeric 등이 boolean 정답으로 새는 것 방지.
    if (extractedValue.kind !== 'boolean') return { featureKey, status: 'type_mismatch' };
    return { featureKey, kind: 'boolean', extracted: extractedValue.value, gold: goldValue.value, agree: extractedValue.value === goldValue.value };
  }
  // categorical — kind 일치 요구.
  if (extractedValue.kind !== 'categorical') return { featureKey, status: 'type_mismatch' };
  const ev = String(extractedValue.value);
  const gv = String(goldValue.value);
  return { featureKey, kind: 'categorical', extracted: ev, gold: gv, agree: ev === gv };
}

// VideoFeatureMap ↔ AnnotationFeatureMap 비교 → 비교결과 배열.
export function compareFeatureMap(featureMap = {}, annotationFeatures = {}) {
  const keys = new Set([...Object.keys(featureMap), ...Object.keys(annotationFeatures)]);
  const out = [];
  for (const k of keys) {
    const c = compareFeature(k, featureMap[k], annotationFeatures[k]);
    if (c) out.push(c);
  }
  return out;
}

// 여러 비교결과(여러 영상)를 featureKey별로 집계. numeric=MAE+평균오차율, bool/categorical=일치율.
export function summarizeErrors(comparisons = []) {
  const acc = {};
  for (const c of comparisons) {
    if (c.status) continue; // 누락/불일치 제외
    const e = acc[c.featureKey] || (acc[c.featureKey] = { featureKey: c.featureKey, kind: c.kind, n: 0, _abs: 0, _rate: 0, _agree: 0 });
    e.n += 1;
    if (c.kind === 'numeric') {
      e._abs += c.absError;
      // 비유한 오차율(gold=0 등)을 0으로 숨기지 않는다 — 평균이 Infinity가 되어
      // withinTolerance가 정확히 실패하도록(검증 하네스 false positive 방지).
      e._rate += c.errorRate;
      e.metric = c.metric;
    } else {
      e._agree += c.agree ? 1 : 0;
    }
  }
  return Object.values(acc).map((e) =>
    e.kind === 'numeric'
      ? { featureKey: e.featureKey, kind: 'numeric', metric: e.metric, n: e.n, mae: e._abs / e.n, meanErrorRate: e._rate / e.n }
      : { featureKey: e.featureKey, kind: e.kind, n: e.n, agreement: e._agree / e.n }
  );
}

// 위험 역치 초과 여부의 이진 분류 지표(§8.9): sensitivity/specificity.
export function binaryMetrics(pairs = []) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const p of pairs) {
    const pred = !!p.predicted;
    const act = !!p.actual;
    if (pred && act) tp += 1;
    else if (pred && !act) fp += 1;
    else if (!pred && act) fn += 1;
    else tn += 1;
  }
  return {
    tp, fp, tn, fn,
    sensitivity: tp + fn > 0 ? tp / (tp + fn) : null,
    specificity: tn + fp > 0 ? tn / (tn + fp) : null,
  };
}

// §8.9 예시 허용오차 — placeholder. 실제 변수별 임계값은 6.0-B2 검증으로 확정.
export const EXAMPLE_TOLERANCES = {
  angleMaeDegrees: 12.5, // ±10~15°
  timeErrorRate: 0.20,   // ±20%
  countErrorRate: 0.175, // ±15~20%
};

// summarizeErrors 결과 한 건이 허용오차 내인지. numeric만 판정(그 외 null).
export function withinTolerance(summary, tol = EXAMPLE_TOLERANCES) {
  if (!summary || summary.kind !== 'numeric') return null;
  if (summary.metric === 'angle') return summary.mae <= tol.angleMaeDegrees;
  if (summary.metric === 'time') return summary.meanErrorRate <= tol.timeErrorRate;
  if (summary.metric === 'count') return summary.meanErrorRate <= tol.countErrorRate;
  return null;
}

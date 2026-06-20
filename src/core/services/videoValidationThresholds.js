// 검증(6.0-B2) 전용 임계값·정규화 — **하네스 전용, 앱 런타임 미참조**.
//
// 이 파일은 confidence 게이팅(videoConfidenceConfig.js)과 성격이 다르다:
//  - 게이팅 임계값 = "저신뢰 → 자동제안 금지" 정책(런타임 영향).
//  - 여기 두 표 = 오프라인 검증 리포트(scripts/videoValidateReport.mjs)에서만 쓰는 보조 규칙.
// 섞이면 오해가 생기므로 분리한다(코덱스 리뷰). 앱 코드(videoPerDayConversion 등)는 이 파일을
// import하지 않는다 — 가드 테스트로 단언.

// ---------------------------------------------------------------------------
// 1) 검증 전용 candidate 정규화 표
//
// 문제: convertClipFeaturesToPerDay의 candidate 분기는 kind:'candidate'·unit 없음으로 둔다.
// videoValidation.js compareFeature는 gold가 numeric이면 extracted도 numeric이라야 비교한다
// → candidate를 gold(각도/시간)와 비교하면 type_mismatch. VIDEO_FEATURE_TARGETS[key].unit도
// trunkPostureG는 null이라 generic 규칙으로 못 푼다.
//
// 해결: **검증 가능한 candidate만** 명시 규칙으로 비교가능 numeric으로 환산한다(앱 출력은 불변,
// 비교 직전 하네스 안에서만). 미선언 candidate는 not_comparable_candidate(비교 제외·리포트 명시).
//
// rule:
//  - 'ratio_x_active_minutes': evidence.intrinsicValue(0~1 비율) × activeMinutesPerDay → minutes_per_day.
//    targetUnit='hours_per_day'이면 ÷60. activeMinutesPerDay 없으면 비교 불가(no_active_time).
//  - 'raw_angle': evidence.intrinsicUnit === 'degrees' 확인 후 raw value → numeric degrees.
export const VALIDATION_NORMALIZATION_TABLE = {
  // 척추 45°↑ 굴곡 시간: 클립 측정은 비율(posture_ratio), gold는 분/일 → 비율×활동분.
  trunkFlexionOver45Duration: { rule: 'ratio_x_active_minutes', targetUnit: 'minutes_per_day' },
  // 체간 전굴 peak 각도 후보: raw 각도값을 degrees로 직접 비교.
  trunkPostureG: { rule: 'raw_angle' },
  // (6.0-B2) 검증 가능한 다른 candidate가 확인되면 여기 추가. 미선언 candidate는 비교 제외.
};

/**
 * VideoFeatureValue(앱 출력) + evidence sidecar → 비교가능 형태.
 * - non-candidate(numeric/boolean/categorical)는 그대로 통과(compareFeature가 처리).
 * - candidate는 표에 선언된 것만 numeric으로 환산, 나머지는 not_comparable_candidate.
 *
 * @param {string} featureKey
 * @param {{kind:string, value:any, unit?:string}} featureValue - convertClipFeaturesToPerDay features[key]
 * @param {{intrinsicValue?:number, intrinsicUnit?:string|null, activeMinutesPerDay?:number|null}} [evidence]
 * @returns {{kind:string, value:any, unit?:string} | {status:string}}
 */
export function normalizeForComparison(featureKey, featureValue, evidence = {}) {
  if (!featureValue) return { status: 'missing_extracted' };
  if (featureValue.kind !== 'candidate') return featureValue; // 비교 로직이 직접 처리

  const rule = VALIDATION_NORMALIZATION_TABLE[featureKey];
  if (!rule) return { status: 'not_comparable_candidate' };

  if (rule.rule === 'ratio_x_active_minutes') {
    const ratio = evidence.intrinsicValue;
    const activeMin = evidence.activeMinutesPerDay;
    if (typeof ratio !== 'number' || activeMin == null) return { status: 'no_active_time' };
    const minutes = ratio * activeMin;
    const value = rule.targetUnit === 'hours_per_day' ? minutes / 60 : minutes;
    return { kind: 'numeric', value, unit: rule.targetUnit || 'minutes_per_day' };
  }

  if (rule.rule === 'raw_angle') {
    // 각도 단위가 명시적으로 degrees일 때만(단위 추정 금지 — 시/분 혼동처럼 각도 오비교 방지).
    if (evidence.intrinsicUnit !== 'degrees') return { status: 'not_comparable_candidate' };
    const value = typeof evidence.intrinsicValue === 'number' ? evidence.intrinsicValue : featureValue.value;
    if (typeof value !== 'number') return { status: 'not_comparable_candidate' };
    return { kind: 'numeric', value, unit: 'degrees' };
  }

  return { status: 'not_comparable_candidate' };
}

// ---------------------------------------------------------------------------
// 2) 위험 역치 결정 임계값(§8.9 "위험 역치 초과 여부" sensitivity/specificity용)
//
// videoValidation.js binaryMetrics는 predicted/actual boolean pair가 필요하다. 시간·각도 numeric을
// 양성/음성으로 이진화할 feature별 컷오프가 필요 — 이는 confidence 임계값과 **다른 개념**이다.
// 컷오프는 추측 금지(§8.9): 검증/도메인 합의로 6.0-B2에서 채운다. 미선언 feature는 sensitivity 계산
// 자체를 건너뛴다(false 지표 방지).
//
// 형태: { featureKey: { cutoff: number, unit: string, direction: 'gte'|'lte' } }
//   direction 'gte'(기본): 정규화 numeric value >= cutoff → 위험(true).
export const CANDIDATE_RISK_DECISION_THRESHOLDS = {
  // 6.0-B2에서 채움. (예) squatDuration: { cutoff: 60, unit: 'minutes_per_day', direction: 'gte' }
};

/**
 * 정규화된 numeric 값을 위험 양성/음성으로 이진화. 컷오프 미선언/단위 불일치/비numeric → null(skip).
 * @returns {boolean|null}
 */
export function riskBinarize(featureKey, normalized, thresholds = CANDIDATE_RISK_DECISION_THRESHOLDS) {
  const th = thresholds && thresholds[featureKey];
  if (!th || !normalized || normalized.kind !== 'numeric') return null;
  if (th.unit && normalized.unit !== th.unit) return null; // 단위 불일치 시 비교 무의미
  if (typeof normalized.value !== 'number' || typeof th.cutoff !== 'number') return null;
  return th.direction === 'lte' ? normalized.value <= th.cutoff : normalized.value >= th.cutoff;
}

// 결과 패널(ResultPanel)만 쓰는 라벨·방법 묶음 — P2-78b에서 본체 머리의 표를 그대로 옮겼다.
// 레시피 패널과 문구까지 같던 METHOD_LABELS·GROUPING_TYPES는 ../labels.ts. 키가 같아도 문구가 다른 표는 합치지 않는다.

export const NULL_REASON_LABELS: Record<string, string> = {
  insufficient_data: '자료 부족',
  undefined_zero_variance: '분산 0(정의 불가)',
  non_finite_result: '유한하지 않은 값',
  constant_variable: '값이 전부 동일(정의 불가)',
  insufficient_group_data: '그룹 자료 부족',
};

// PR4-B2 — computePredictionNonEstimableReason(1~10) + 엔진(NOT_CONVERGED, 11번).
// 사유별로 다르게 쓴다(회귀와 동일 원칙 — "데이터 구조 문제"로 뭉치지 않는다).
export const PREDICTION_NON_ESTIMABLE_LABELS: Record<string, string> = {
  OUTCOME_NOT_OBSERVED: '결과변수가 관측된 사례가 없습니다.',
  EVENT_LEVEL_NOT_OBSERVED: '선택한 사건 레벨이 관측된 사례가 없습니다.',
  NON_EVENT_LEVEL_NOT_OBSERVED: '비사건 레벨이 관측된 사례가 없습니다.',
  INSUFFICIENT_PERSONS: '표본(사람) 수가 부족합니다.',
  INSUFFICIENT_EVENT_PERSONS: '사건/비사건 인원 수가 부족합니다.',
  ZERO_VARIANCE_PREDICTOR: '값이 전부 동일한 설명변수가 있습니다.',
  TOO_MANY_LEVELS: '범주형 설명변수의 수준이 너무 많습니다.',
  TOO_MANY_COLUMNS: '설명변수(범주 포함)가 너무 많습니다.',
  TOO_MANY_PARAMETERS: '설명변수(범주 포함)가 너무 많아 자유도가 부족합니다.',
  INSUFFICIENT_EVENTS_PER_PARAMETER: '사건 수 대비 설명변수가 너무 많습니다(EPV 기준 미달).',
  FOLD_CLASS_MISSING: '교차검증 분할 중 한쪽 사건이 비는 분할이 있습니다.',
  NOT_CONVERGED: '계산이 수렴하지 않았습니다.',
};
// PR4-B2 — PredictionCaveatSchema(shared/contracts/stats.ts)와 동일 목록.
export const PREDICTION_CAVEAT_LABELS: Record<string, string> = {
  RESEARCH_INTERNAL_VALIDATION: '연구용 내부검증 결과입니다.',
  NOT_FOR_DEPLOYMENT: '실제 판정·배포에 쓰지 않습니다.',
  TEMPORAL_VALIDATION_NOT_PERFORMED: '시간분할(temporal holdout) 검증은 하지 않았습니다 — 후속 필수 과제입니다.',
  SUBGROUP_PERFORMANCE_NOT_PERFORMED: '하위집단별 성능 분석은 하지 않았습니다 — 후속 필수 과제입니다.',
  EXTERNAL_VALIDATION_NOT_PERFORMED: '외부(다른 기관·시점) 검증은 하지 않았습니다 — 별도 연구가 필요합니다.',
  SAME_ASSESSOR_FINDINGS: '선택한 설명변수 중 임상 판단값이 있어, 결과변수 판정과 같은 평가자가 매긴 값입니다.',
  LATEST_PAYLOAD_LEAKAGE_POSSIBLE: '설명변수는 현재 시점 기준 값입니다 — 판정 당시 시점의 값과 다를 수 있습니다.',
  RAW_EXPOSURE_FORMULA_INPUT: '일부 설명변수는 작업부담 공식의 원시 입력값입니다.',
  USER_MODEL_SELECTION_NOT_CORRECTED: '변수·모형 선택 과정의 다중비교 보정은 하지 않았습니다.',
};
export const PREDICTION_METRIC_LABELS: Record<string, string> = {
  roc_auc: 'AUC(ROC)', average_precision: '평균정밀도(AP)', brier: 'Brier score',
  calibration_intercept: '보정 절편', calibration_slope: '보정 기울기',
};
// PR4-A1 — inferenceWithheldReason별 안내 문구. 원인이 다른데 같은 문구로 뭉치면
// 사용자가 데이터 구조 문제로 오해한다(계획서 §5 "사유별로 다르게 쓴다").
export const REGRESSION_WITHHELD_LABELS: Record<string, string> = {
  TOO_FEW_CLUSTERS: '표본 구조상(한 사람이 여러 행) p값·신뢰구간을 표시하지 않습니다.',
  CLUSTER_IMBALANCE: '표본 구조상(한 사람이 여러 행) p값·신뢰구간을 표시하지 않습니다.',
  COVARIANCE_NOT_COMPUTABLE: '표준오차를 계산할 수 없어 p값·신뢰구간을 표시하지 않습니다.',
  DEGENERATE_COVARIANCE: '표준오차를 계산할 수 없어 p값·신뢰구간을 표시하지 않습니다.',
};
export const REGRESSION_NON_ESTIMABLE_LABELS: Record<string, string> = {
  INSUFFICIENT_COMPLETE_ROWS: '완전사례 수가 부족해 실행할 수 없습니다.',
  TOO_MANY_LEVELS: '범주형 설명변수의 수준이 너무 많습니다.',
  TOO_MANY_PARAMETERS: '설명변수(범주 포함)가 너무 많아 자유도가 부족합니다.',
  INSUFFICIENT_EVENTS_PER_PARAMETER: '사건 수 대비 설명변수가 너무 많습니다.',
  CONSTANT_OUTCOME: '결과변수 값이 전부 동일해 실행할 수 없습니다.',
  ZERO_VARIANCE_PREDICTOR: '값이 전부 동일한 설명변수가 있습니다.',
  RANK_DEFICIENT: '설명변수 사이에 완전한 상관(공선성)이 있습니다.',
  SEPARATION_DETECTED: '결과변수가 설명변수로 완전히 구분돼 계산할 수 없습니다.',
  SEPARATION_CHECK_FAILED: '분리 여부를 판정하지 못해 실행을 중단했습니다.',
  NOT_CONVERGED: '계산이 수렴하지 않았습니다.',
  // PR4-A2
  CATEGORICAL_OUTCOME_NOT_BINARY: '결과변수의 관측된 범주가 정확히 2개가 아닙니다.',
  SPLINE_INSUFFICIENT_UNIQUE_VALUES: '스플라인을 적용할 변수의 고유값이 부족하거나 분포가 편중돼 있습니다.',
};
export const GROUP_COMPARISON_METHODS = new Set<string | undefined>(['welch_t', 'mann_whitney', 'anova', 'kruskal_wallis', 'paired_t', 'wilcoxon_signed_rank']);
// [코드리뷰 2026-09-12 2차] η²(anova)·ε²(kruskal_wallis)는 부호 있는 "차이" 개념이
// 없다 — "뒤−앞" 방향 설명은 2-그룹 검정(welch_t/mann_whitney, 그리고 지금은 항상
// unsupported인 paired_t/wilcoxon_signed_rank)에만 의미가 있다.
export const DIRECTIONAL_GROUP_METHODS = new Set<string | undefined>(['welch_t', 'mann_whitney', 'paired_t', 'wilcoxon_signed_rank']);
export const CONTINGENCY_METHODS = new Set<string | undefined>(['chi_square', 'fisher_exact']);
export const REGRESSION_QUALITY_FLAG_LABELS: Record<string, string> = {
  reference_level_fallback: '지정한 기준 범주를 쓸 수 없어 자동으로 선택한 기준 범주를 사용했습니다.',
  event_level_fallback: '지정한 사건 수준을 쓸 수 없어 자동으로 선택한 수준을 사용했습니다.',
};

export const QUALITY_FLAG_LABELS: Record<string, string> = {
  low_expected_count: '일부 칸의 기대도수가 작아 근사의 타당성이 낮습니다.',
  haldane_anscombe_applied: '0이 포함된 셀이 있어 Haldane-Anscombe 보정(+0.5)을 적용했습니다.',
};

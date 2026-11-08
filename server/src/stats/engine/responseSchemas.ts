// Stats engine raw result schemas (zod) for the six request kinds, and their inferred types.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import { z } from 'zod';
import { ENGINE_PROTOCOL_VERSION } from './protocol';

const StatsEngineNullReasonSchema = z.enum(['insufficient_data', 'undefined_zero_variance', 'non_finite_result']);
// PR3-A — bivariate.py의 nullReasons는 기존 3종 + 이변량 전용 2종(계획서 §Python엔진).
const StatsEngineBivariateNullReasonSchema = z.enum([
  'insufficient_data', 'undefined_zero_variance', 'non_finite_result',
  'constant_variable', 'insufficient_group_data',
]);

// 7차 검토 필수 수정 — .finite()가 빠져 있으면 JSON.parse('1e400') 같은 값이 Infinity로
// 파싱돼 z.number()를 그대로 통과한다(typeof Infinity === 'number'). 이후 canonicalDigest가
// NaN/Infinity에서 throw하는데 그 지점이 실패 분류 try/catch 밖이라 감사·failed 기록이
// 누락되는 경로로 이어졌다 — 여기서 막아 정상적으로 RESULT_SCHEMA_INVALID로 분류되게 한다.
const finiteNullable = () => z.number().finite().nullable();

// PR3-B — 히스토그램/박스플롯(계획서 §2/§3). Python은 person을 모른 채 정직하게
// 전부 계산해 반환한다 — 소수셀 판정(person 단위)은 stats/disclosure/chartDisclosure.ts가
// 이 원시 결과를 받은 뒤 별도로 수행한다. n=0(계산 불가)이면 Python이 둘 다
// null로 반환하므로 nullable(optional 아님 — 키는 항상 존재).
// 히스토그램 끝 구간 병합 — Node는 이제 histogram을 쓰지 않는다(원본 bin의 기준
// 구현은 stats/disclosure/chartDisclosure.ts buildOriginalHistogram). 엔진 프로토콜은 그대로
// 두기 위해 스키마 검증만 유지하고, Python 쪽 출력 제거는 후속으로 분리한다.
const StatsEngineHistogramBinSchema = z.object({
  lower: z.number().finite(),
  upper: z.number().finite(),
  count: z.number().int().nonnegative(),
});
const StatsEngineHistogramSchema = z.object({
  bins: z.array(StatsEngineHistogramBinSchema),
});
const StatsEngineBoxplotSchema = z.object({
  q1: z.number().finite(),
  median: z.number().finite(),
  q3: z.number().finite(),
  lowerWhisker: z.number().finite(),
  upperWhisker: z.number().finite(),
  lowerFence: z.number().finite(),
  upperFence: z.number().finite(),
  outlierCount: z.number().int().nonnegative(),
  outlierValues: z.array(z.number().finite()),
});

const StatsEngineContinuousResultSchema = z.object({
  variableKey: z.string(),
  n: z.number().int().nonnegative(),
  mean: finiteNullable(),
  sd: finiteNullable(),
  median: finiteNullable(),
  q1: finiteNullable(),
  q3: finiteNullable(),
  iqr: finiteNullable(),
  skewness: finiteNullable(),
  kurtosis: finiteNullable(),
  min: finiteNullable(),
  max: finiteNullable(),
  nullReasons: z.record(z.string(), StatsEngineNullReasonSchema),
  histogram: StatsEngineHistogramSchema.nullable(),
  boxplot: StatsEngineBoxplotSchema.nullable(),
});

const StatsEngineDiscreteLevelSchema = z.object({
  level: z.union([z.string(), z.boolean()]),
  count: z.number().int().nonnegative(),
});

const StatsEngineDiscreteResultSchema = z.object({
  variableKey: z.string(),
  n: z.number().int().nonnegative(),
  levels: z.array(StatsEngineDiscreteLevelSchema),
});

export const StatsEngineRawResultSchema = z.object({
  protocolVersion: z.literal(ENGINE_PROTOCOL_VERSION),
  continuous: z.array(StatsEngineContinuousResultSchema),
  discrete: z.array(StatsEngineDiscreteResultSchema),
}).strict();

export type StatsEngineContinuousResult = z.infer<typeof StatsEngineContinuousResultSchema>;
export type StatsEngineDiscreteResult   = z.infer<typeof StatsEngineDiscreteResultSchema>;
export interface StatsEngineRawResult {
  continuous: StatsEngineContinuousResult[];
  discrete: StatsEngineDiscreteResult[];
}

// PR3-A — bivariate.py의 공통 envelope(계획서 §Python엔진 "공통 결과 envelope").
// 원시 x/y·caseId·personClusterKey 필드는 이 스키마 어디에도 선언하지 않는다 —
// Python이 실수로 그런 필드를 되돌려도 구조적으로 통과할 수 없다(defense-in-depth,
// 계획서 §"새 프로토콜의 입력상한·의미검증" "결과" 행).
const StatsEngineEffectSizeSchema = z.object({
  name: z.string(),
  value: z.number().finite().nullable(),
  ci: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
  ciUnavailableReason: z.enum(['not_supported_v1', 'undefined_at_n', 'perfect_correlation']).nullable(),
});

export const StatsEngineBivariateRawResultSchema = z.object({
  protocolVersion: z.literal(ENGINE_PROTOCOL_VERSION),
  bivariate: z.object({
    method: z.enum([
      'welch_t', 'mann_whitney', 'anova', 'kruskal_wallis',
      'chi_square', 'fisher_exact',
      'pearson_correlation', 'spearman_correlation',
    ]),
    n: z.number().int().nonnegative(),
    statistic: z.number().finite().nullable(),
    df: z.union([
      z.number().finite(),
      z.object({ numerator: z.number().finite(), denominator: z.number().finite() }).strict(),
    ]).nullable(),
    pValue: z.number().finite().nullable(),
    effectSizes: z.array(StatsEngineEffectSizeSchema),
    nullReasons: z.record(z.string(), StatsEngineBivariateNullReasonSchema),
    multipleTesting: z.object({
      method: z.literal('none'),
      adjustedP: z.number().finite().nullable(),
    }).strict(),
    qualityFlags: z.array(z.enum(['low_expected_count', 'haldane_anscombe_applied'])),
    extra: z.record(z.string(), StatsEngineEffectSizeSchema),
    // PR3-B — pearson_correlation/spearman_correlation만 이 키를 채운다(형제
    // 필드, extra 안이 아님 — extra는 효과크기 shape 전용). 다른 6개 method는
    // 이 키 자체를 안 만들므로 optional(부재 허용, .strict()와 충돌 안 함).
    regressionLine: z.object({
      slope: z.number().finite(),
      intercept: z.number().finite(),
    }).nullable().optional(),
    // PR3-B — 그룹비교 4개 method(welch_t/mann_whitney/anova/kruskal_wallis)만
    // 이 키를 채운다(계획서 §5). 억제 여부와 무관하게 Python은 항상 정직하게
    // 계산 — 노출은 stats/disclosure/bivariateSuppression.ts가 기존 그룹 게이트로 결정한다.
    groupBoxplots: z.array(z.object({
      label: z.union([z.string(), z.boolean()]),
      boxplot: StatsEngineBoxplotSchema.nullable(),
    })).optional(),
  }).strict(),
}).strict();

export type StatsEngineEffectSize = z.infer<typeof StatsEngineEffectSizeSchema>;
export type StatsEngineBivariateRawResult = z.infer<typeof StatsEngineBivariateRawResultSchema>['bivariate'];


// PR3-B — 상관행렬 결과(계획서 §4, 4차 코드리뷰로 단순화). r/pValue/adjustedP는
// Python이 계산 불가(상수·표본부족)면 null — 이 raw 스키마 단계에서는 아직
// disclosure(소수셀·§6.1 반복측정 게이트) 적용 전이다. stats/disclosure/correlationMatrixSuppression.ts
// 가 이 raw 결과를 받아 공개 여부를 최종 결정한다.
const StatsEngineCorrelationMatrixCellSchema = z.object({
  xKey: z.string(),
  yKey: z.string(),
  n: z.number().int().nonnegative(),
  r: z.number().finite().nullable(),
  pValue: z.number().finite().nullable(),
  adjustedP: z.number().finite().nullable(),
});
export const StatsEngineCorrelationMatrixRawResultSchema = z.object({
  protocolVersion: z.literal(ENGINE_PROTOCOL_VERSION),
  correlationMatrix: z.object({
    method: z.enum(['pearson_correlation', 'spearman_correlation']),
    cells: z.array(StatsEngineCorrelationMatrixCellSchema),
  }).strict(),
}).strict();

export type StatsEngineCorrelationMatrixCell = z.infer<typeof StatsEngineCorrelationMatrixCellSchema>;
export type StatsEngineCorrelationMatrixRawResult = z.infer<typeof StatsEngineCorrelationMatrixRawResultSchema>['correlationMatrix'];


// PR4-A1 — 회귀 결과(계획서 §3 "요청/응답" + §1 "raw 엔진 응답 검증 규칙").
// nonEstimableReason은 Python이 직접 판정하는 3종(분리·solver실패·비수렴)만
// 담는다 — 나머지 non_estimable 사유(TOO_MANY_LEVELS 등)는 Node가 ④ 단계에서
// Python 호출 전에 이미 걸러내므로 이 raw 스키마엔 나타날 수 없다.
const StatsEngineRegressionTermSchema = z.object({
  name: z.string(),
  estimate: z.number().finite(),
  se: z.number().finite().nullable(),
  statistic: z.number().finite().nullable(),
  pValue: z.number().finite().nullable(),
  ciLower: z.number().finite().nullable(),
  ciUpper: z.number().finite().nullable(),
  exponentiated: z.object({
    estimate: z.number().finite(),
    ciLower: z.number().finite().nullable(),
    ciUpper: z.number().finite().nullable(),
  }).strict().nullable(),
}).strict();

const StatsEngineRegressionFitSchema = z.object({
  r2: z.number().finite().nullable(),
  adjR2: z.number().finite().nullable(),
  logLik: z.number().finite().nullable(),
  aic: z.number().finite().nullable(),
  pseudoR2: z.number().finite().nullable(),
}).strict();

// PR4-A2 — VIF/condition number(집계, X만 있으면 계산). pointDiagnosticsSupported
// 는 추론 상태(estimation/inferenceIssue)와 완전히 독립적으로 (X,y,β)만으로
// 직접 판정된다(계획서 §3 "_evaluate_diagnostic_support" — 반례로 확정된 원칙).
// vif는 절편을 제외한 열별(length = columnNames.length - 1) 순서 배열이다.
const StatsEngineRegressionDiagnosticsSchema = z.object({
  conditionNumber: z.number().finite().nullable(),
  vif: z.array(z.number().finite().nullable()),
  pointDiagnosticsSupported: z.boolean(),
  pointDiagnosticsUnsupportedReason: z.enum([
    'QR_DECOMPOSITION_FAILED', 'NEAR_SINGULAR_LEVERAGE', 'INVALID_DIAGNOSTIC_SCALE',
  ]).nullable(),
}).strict();

const StatsEngineRegressionSplinePointSchema = z.object({
  deltaFromBaseline: z.number().finite().nullable(),
  ciLower: z.number().finite().nullable(),
  ciUpper: z.number().finite().nullable(),
  exponentiated: z.object({
    estimate: z.number().finite(),
    ciLower: z.number().finite().nullable(),
    ciUpper: z.number().finite().nullable(),
  }).strict().nullable(),
}).strict();

const StatsEngineRegressionSplinePartialEffectSchema = z.object({
  variableKey: z.string(),
  points: z.array(StatsEngineRegressionSplinePointSchema),
}).strict();

const StatsEngineRegressionResultSchema = z.object({
  estimation: z.enum(['ok', 'inference_withheld', 'non_estimable']),
  nonEstimableReason: z.enum(['SEPARATION_DETECTED', 'SEPARATION_CHECK_FAILED', 'NOT_CONVERGED']).nullable(),
  inferenceIssue: z.enum(['ok', 'COVARIANCE_NOT_COMPUTABLE', 'DEGENERATE_COVARIANCE']).nullable(),
  inferenceDistribution: z.enum(['t', 'normal']).nullable(),
  inferenceDf: z.number().finite().nullable(),
  clusterCount: z.number().int().nonnegative().nullable(),
  terms: z.array(StatsEngineRegressionTermSchema),
  fit: StatsEngineRegressionFitSchema.nullable(),
  converged: z.boolean(),
  qualityFlags: z.array(z.string()),
  diagnostics: StatsEngineRegressionDiagnosticsSchema.nullable(),
  splinePartialEffects: z.array(StatsEngineRegressionSplinePartialEffectSchema).nullable(),
}).strict();

export const StatsEngineRegressionRawResultSchema = z.object({
  protocolVersion: z.literal(ENGINE_PROTOCOL_VERSION),
  regression: StatsEngineRegressionResultSchema,
}).strict();

export type StatsEngineRegressionTerm = z.infer<typeof StatsEngineRegressionTermSchema>;
export type StatsEngineRegressionFit = z.infer<typeof StatsEngineRegressionFitSchema>;
export type StatsEngineRegressionDiagnostics = z.infer<typeof StatsEngineRegressionDiagnosticsSchema>;
export type StatsEngineRegressionSplinePartialEffect = z.infer<typeof StatsEngineRegressionSplinePartialEffectSchema>;
export type StatsEngineRegressionRawResult = z.infer<typeof StatsEngineRegressionRawResultSchema>['regression'];

// PR4-A2 — limited_row 진단 raw 응답. pointDiagnostics 배열은 Node가 보낸
// sampledRowIndices와 정확히 같은 개수·순서로 온다(아래 validate가 대조).
const StatsEngineRegressionDiagnosticsPointSchema = z.object({
  rowIndex: z.number().int(),
  fittedValue: z.number().finite(),
  residual: z.number().finite(),
  leverage: z.number().finite(),
  standardizedResidual: z.number().finite(),
  cooksDistance: z.number().finite(),
  theoreticalQuantile: z.number().finite(),
}).strict();

const StatsEngineRegressionDiagnosticsResultSchema = z.object({
  pointDiagnosticsSupported: z.boolean(),
  pointDiagnosticsUnsupportedReason: z.enum([
    'QR_DECOMPOSITION_FAILED', 'NEAR_SINGULAR_LEVERAGE', 'INVALID_DIAGNOSTIC_SCALE',
  ]).nullable(),
  points: z.array(StatsEngineRegressionDiagnosticsPointSchema),
}).strict();

export const StatsEngineRegressionDiagnosticsRawResultSchema = z.object({
  protocolVersion: z.literal(ENGINE_PROTOCOL_VERSION),
  regressionDiagnostics: StatsEngineRegressionDiagnosticsResultSchema,
}).strict();

export type StatsEngineRegressionDiagnosticsRawResult =
  z.infer<typeof StatsEngineRegressionDiagnosticsRawResultSchema>['regressionDiagnostics'];


// ---------------------------------------------------------------------------
// PR4-B2 — 예측(prediction) 엔진 요청/응답(계획서 §4/§5단계).
// ---------------------------------------------------------------------------
export const _PREDICTION_METRIC_NAMES = ['roc_auc', 'average_precision', 'brier', 'calibration_intercept', 'calibration_slope'] as const;

const StatsEnginePredictionCvSchema = z.object({
  status: z.enum(['ok', 'withheld']),
  validRepeats: z.number().int().nonnegative(),
  totalRepeats: z.number().int().nonnegative(),
  mean: z.number().finite().nullable(),
  min: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
}).strict();

const StatsEnginePredictionBootstrapSchema = z.object({
  status: z.enum(['ok', 'withheld']),
  validReplicates: z.number().int().nonnegative(),
  totalReplicates: z.number().int().nonnegative(),
  optimism: z.number().finite().nullable(),
  corrected: z.number().finite().nullable(),
}).strict();

const StatsEnginePredictionMetricSchema = z.object({
  apparent: z.number().finite().nullable(),
  representativeRepeat: z.number().finite().nullable(),
  cv: StatsEnginePredictionCvSchema,
  bootstrap: StatsEnginePredictionBootstrapSchema,
}).strict();

const StatsEnginePredictionAucCiSchema = z.object({
  target: z.literal('roc_auc_cv_mean'),
  lower: z.number().finite(),
  upper: z.number().finite(),
  method: z.literal('person_bootstrap_oof_conditional'),
  replicates: z.number().int().nonnegative(),
}).strict();

const StatsEnginePredictionOofPointSchema = z.object({
  row: z.number().int().nonnegative(),
  p: z.number().finite(),
}).strict();

// nonEstimableReason은 엔진 내부 사유만 나온다 — Node 쪽 비추정 사유 1~10
// (stats/dataset/predictionCohort.ts computePredictionNonEstimableReason)은 애초에 이
// 엔진을 호출하기 전에 걸러지므로, 여기 도달했다면 오직 NOT_CONVERGED뿐이다
// (3-4단계 순서표 11번, 계획서 §4단계 "실패 범위").
const StatsEnginePredictionResultSchema = z.object({
  estimation: z.enum(['ok', 'non_estimable']),
  nonEstimableReason: z.literal('NOT_CONVERGED').nullable(),
  lambdaSelected: z.number().finite().nullable(),
  metrics: z.record(z.enum(_PREDICTION_METRIC_NAMES), StatsEnginePredictionMetricSchema),
  aucCi: StatsEnginePredictionAucCiSchema.nullable(),
  oofRepresentative: z.array(StatsEnginePredictionOofPointSchema).nullable(),
  intercept: z.number().finite().nullable(),
  coefficients: z.array(z.number().finite()).nullable(),
  droppedColumnFoldCount: z.number().int().nonnegative().nullable(),
  flags: z.array(z.string()),
}).strict();

export const StatsEnginePredictionRawResultSchema = z.object({
  protocolVersion: z.literal(ENGINE_PROTOCOL_VERSION),
  prediction: StatsEnginePredictionResultSchema,
}).strict();

export type StatsEnginePredictionMetric = z.infer<typeof StatsEnginePredictionMetricSchema>;
export type StatsEnginePredictionAucCi = z.infer<typeof StatsEnginePredictionAucCiSchema>;
export type StatsEnginePredictionRawResult = z.infer<typeof StatsEnginePredictionRawResultSchema>['prediction'];

// PR1 §4.4 — execution_digest 조성. idempotency 캐시 키. PR1엔 아직 없는 정책 축
// (disclosure/method policy)도 상수로 고정해 digest 구조 안에 자리를 미리 만들어둔다 —
// PR3/PR5가 실제 값으로 상수만 교체하면 되게.
import { DETERMINISTIC_MIGRATION_VERSION } from '@wr/analytics-core/migration/deterministicMigrate';
import { canonicalDigest, SERIALIZER_VERSION } from './canonicalSerializer';
import {
  CHART_DISCLOSURE_POLICY_VERSION,
  CORRELATION_MATRIX_POLICY_VERSION,
  ESTIMABILITY_POLICY_VERSION,
  INFERENCE_GATE_POLICY_VERSION,
  REGRESSION_POLICY_VERSION,
  PREDICTION_POLICY,
} from './statsPolicy';
import { STATS_ENGINE_VERSION } from './statsRunManifest';
import { INTEGRATED_CATALOG_VERSION } from './statsCatalogVersion';

// §4.2 억제 규칙의 버전 — 규칙이 바뀌면(예: 부분억제→연결억제 전환처럼) 과거에 계산된
// 캐시 결과를 재사용하면 안 되므로 digest에 포함한다.
// PR3-A — 분할표/그룹비교 B-처리(그룹·셀 소수셀·값상수 → 결과 전체 연결억제)가
// 추가돼 규칙이 확장됐다(계획서 §버전 상수).
// PR3-B — 히스토그램/그리드 person 단위 전체연결억제 + 박스플롯 이상치 전용
// partition 게이트가 추가돼 규칙이 다시 확장됐다(계획서 §1/§3).
// B안 — 히스토그램이 all-or-nothing 즉시 포기 대신 적응형 해상도 축소(재분할)를
// 거치도록 규칙 자체가 바뀌어 다시 범프한다(server/src/statsChartDisclosure.ts의
// resolveDisclosableHistogram 참고).
export const SUPPRESSION_RULE_VERSION = 'v5-histogram-adaptive-resolution';
// PR1엔 aggregate 하나뿐 — PR5가 limited_row/phi를 도입할 때 실제 분기가 생긴다.
const DISCLOSURE_POLICY_VERSION = 'v0-aggregate-only';
// PR3-A — availableMethods(A-1/A-2) 계산 로직이 신설됐다. statsMethodCatalog.ts가
// 이 값을 AvailableMethod.methodPolicyVersion에 그대로 stamp한다(export 필요).
// PR4-A1 — 회귀 2종의 availableMethods 계산이 추가돼 범프.
// PR4-A2 — binary_logistic이 categorical(2레벨) outcome도 허용하도록 타입
// 정합성 판정이 바뀌어 다시 범프.
// PR4-B2 — computePredictionAvailableMethods(l2_logistic)가 추가돼 다시 범프.
export const METHOD_POLICY_VERSION = 'v4-prediction-l2-logistic';
// PR3-A — AnalyzeResult.bivariate 필드가 추가돼 결과 shape이 확장됐다.
// PR3-B — histogram/boxplot/scatter/regressionLine/correlationMatrix 필드가
// 추가돼 결과 shape이 다시 확장됐다.
// B안 — AnalyzeHistogramSchema.merged + AnalyzeContinuousRevealedSchema.
// histogramReasonCode 필드가 추가돼 결과 shape이 다시 확장됐다. 테스트(같은
// 모듈 안의 상수라 STATS_ENGINE_VERSION류의 vi.doMock 패턴이 안 통함, PR0-B4
// 관련 세션의 리뷰 지적)를 위해 export한다.
// PR4-A1 — AnalyzeResult.regression 필드가 추가돼 결과 shape이 다시 확장됐다.
// PR4-A2 — regression.diagnostics/standardizedPredictorKeys/standardization/
// splinePartialEffects 필드가 추가돼 결과 shape이 다시 확장됐다.
// PR4-B2 — AnalyzeResult.prediction 필드가 추가돼 결과 shape이 다시 확장됐다.
export const RESULT_SCHEMA_VERSION = 'v7-prediction';

export interface ComputeExecutionDigestInput {
  organizationId: string;
  requestedBy: string;
  recipeDigest: string;
  sourceDigest: string;
}

export function computeExecutionDigest(input: ComputeExecutionDigestInput): string {
  return canonicalDigest({
    organizationId: input.organizationId,
    requestedBy: input.requestedBy,
    recipeDigest: input.recipeDigest,
    sourceDigest: input.sourceDigest,
    engineVersion: STATS_ENGINE_VERSION,
    catalogVersion: INTEGRATED_CATALOG_VERSION,
    extractorVersion: INTEGRATED_CATALOG_VERSION,
    migrationVersion: DETERMINISTIC_MIGRATION_VERSION,
    serializerVersion: SERIALIZER_VERSION,
    formulaImplementationVersion: INTEGRATED_CATALOG_VERSION,
    disclosurePolicyVersion: DISCLOSURE_POLICY_VERSION,
    requestedDisclosureProfile: 'aggregate' as const,
    methodPolicyVersion: METHOD_POLICY_VERSION,
    estimabilityPolicyVersion: ESTIMABILITY_POLICY_VERSION,
    // PR3-A — §6.1 게이트 정책 버전. computeExecutionDigest()의 해시 입력에 직접
    // 추가해야 캐시가 무효화된다(manifest stamp만으로는 부족, 계획서 §버전 상수 이슈H-1).
    inferenceGatePolicyVersion: INFERENCE_GATE_POLICY_VERSION,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    suppressionRuleVersion: SUPPRESSION_RULE_VERSION,
    // PR3-B — 상관행렬 정책·차트 disclosure 정책 버전도 해시 입력에 직접
    // 추가한다(§6.1 게이트와 동일한 이유 — manifest stamp만으로는 캐시 무효화가
    // 안 된다).
    correlationMatrixPolicyVersion: CORRELATION_MATRIX_POLICY_VERSION,
    chartDisclosurePolicyVersion: CHART_DISCLOSURE_POLICY_VERSION,
    // PR4-A1 — 회귀 설계행렬 게이트 정책 버전. 같은 이유로 해시 입력에 직접
    // 추가한다(manifest stamp만으로는 캐시가 무효화되지 않는다).
    regressionPolicyVersion: REGRESSION_POLICY_VERSION,
    // PR4-B2 — PREDICTION_POLICY 전체(disclosure·samplerVersion 포함)를 해시해
    // 넣는다. 다른 정책처럼 손으로 관리하는 버전 문자열 하나에 기대지 않는다 —
    // λ 격자·fold 수·bootstrap 반복수처럼 결과에 직접 영향을 주는 상수가
    // version 문자열을 안 바꾸고도 조용히 바뀌면 캐시가 무효화되지 않는다.
    predictionPolicyDigest: canonicalDigest(PREDICTION_POLICY),
  });
}

// PR1 §4.4 — execution_digest 조성. idempotency 캐시 키. PR1엔 아직 없는 정책 축
// (disclosure/method policy)도 상수로 고정해 digest 구조 안에 자리를 미리 만들어둔다 —
// PR3/PR5가 실제 값으로 상수만 교체하면 되게.
import { CATALOG_VERSION } from '@wr/analytics-core/catalog';
import { DETERMINISTIC_MIGRATION_VERSION } from '@wr/analytics-core/migration/deterministicMigrate';
import { canonicalDigest, SERIALIZER_VERSION } from './canonicalSerializer';
import {
  CHART_DISCLOSURE_POLICY_VERSION,
  CORRELATION_MATRIX_POLICY_VERSION,
  ESTIMABILITY_POLICY_VERSION,
  INFERENCE_GATE_POLICY_VERSION,
} from './statsPolicy';
import { STATS_ENGINE_VERSION } from './statsRunManifest';

// §4.2 억제 규칙의 버전 — 규칙이 바뀌면(예: 부분억제→연결억제 전환처럼) 과거에 계산된
// 캐시 결과를 재사용하면 안 되므로 digest에 포함한다.
// PR3-A — 분할표/그룹비교 B-처리(그룹·셀 소수셀·값상수 → 결과 전체 연결억제)가
// 추가돼 규칙이 확장됐다(계획서 §버전 상수).
// PR3-B — 히스토그램/그리드 person 단위 전체연결억제 + 박스플롯 이상치 전용
// partition 게이트가 추가돼 규칙이 다시 확장됐다(계획서 §1/§3).
export const SUPPRESSION_RULE_VERSION = 'v4-chart-outlier-partition-gate';
// PR1엔 aggregate 하나뿐 — PR5가 limited_row/phi를 도입할 때 실제 분기가 생긴다.
const DISCLOSURE_POLICY_VERSION = 'v0-aggregate-only';
// PR3-A — availableMethods(A-1/A-2) 계산 로직이 신설됐다. statsMethodCatalog.ts가
// 이 값을 AvailableMethod.methodPolicyVersion에 그대로 stamp한다(export 필요).
export const METHOD_POLICY_VERSION = 'v1-bivariate';
// PR3-A — AnalyzeResult.bivariate 필드가 추가돼 결과 shape이 확장됐다.
// PR3-B — histogram/boxplot/scatter/regressionLine/correlationMatrix 필드가
// 추가돼 결과 shape이 다시 확장됐다.
const RESULT_SCHEMA_VERSION = 'v3-charts-correlation-matrix';

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
    catalogVersion: CATALOG_VERSION,
    extractorVersion: CATALOG_VERSION,
    migrationVersion: DETERMINISTIC_MIGRATION_VERSION,
    serializerVersion: SERIALIZER_VERSION,
    formulaImplementationVersion: CATALOG_VERSION,
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
  });
}

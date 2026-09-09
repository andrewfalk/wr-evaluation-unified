// PR1 §4.4 — execution_digest 조성. idempotency 캐시 키. PR1엔 아직 없는 정책 축
// (disclosure/method policy)도 상수로 고정해 digest 구조 안에 자리를 미리 만들어둔다 —
// PR3/PR5가 실제 값으로 상수만 교체하면 되게.
import { CATALOG_VERSION } from '@wr/analytics-core/catalog';
import { DETERMINISTIC_MIGRATION_VERSION } from '@wr/analytics-core/migration/deterministicMigrate';
import { canonicalDigest, SERIALIZER_VERSION } from './canonicalSerializer';
import { ESTIMABILITY_POLICY_VERSION } from './statsPolicy';
import { STATS_ENGINE_VERSION } from './statsRunManifest';

// §4.2 억제 규칙의 버전 — 규칙이 바뀌면(예: 부분억제→연결억제 전환처럼) 과거에 계산된
// 캐시 결과를 재사용하면 안 되므로 digest에 포함한다.
export const SUPPRESSION_RULE_VERSION = 'v2-linked-whole-variable';
// PR1엔 aggregate 하나뿐 — PR5가 limited_row/phi를 도입할 때 실제 분기가 생긴다.
const DISCLOSURE_POLICY_VERSION = 'v0-aggregate-only';
// PR3의 방법 카탈로그(availableMethods) 이전 — 지금은 기술통계 하나뿐이라 정책이랄 게 없다.
const METHOD_POLICY_VERSION = 'v0-descriptive-only';
const RESULT_SCHEMA_VERSION = 'v1-descriptive';

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
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    suppressionRuleVersion: SUPPRESSION_RULE_VERSION,
  });
}

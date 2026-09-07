// PR0-C §1.2/§E — run manifest 조립. 새 DB 테이블에 저장하지 않는다(§Context 확정사항 2) —
// 매 /preview 응답 본문에 이 전체를 stamp하고, 감사로그(audit_logs.extra)에도 provenance로
// 남긴다.
import { randomUUID } from 'crypto';
import { CATALOG_VERSION } from '@wr/analytics-core/catalog';
import { DETERMINISTIC_MIGRATION_VERSION } from '@wr/analytics-core/migration/deterministicMigrate';
import type { RunManifest } from '@wr/contracts';
import { SERIALIZER_VERSION } from './canonicalSerializer';
import { ESTIMABILITY_POLICY_VERSION } from './statsPolicy';

// Python worker(PR1)가 아직 없다는 사실을 manifest에 명시적으로 남긴다 — PR1이 실제 엔진
// 버전으로 이 값을 교체할 지점.
export const STATS_ENGINE_VERSION = 'v0-node-only';

export interface BuildRunManifestInput {
  recipeDigest: string;
  sourceDigest: string;
  resultDigest: string;
  snapshotAsOf: string;
  formulaPolicies: Record<string, string>;
}

export function buildRunManifest(input: BuildRunManifestInput): RunManifest {
  return {
    analysisRunId: randomUUID(),
    snapshotAsOf: input.snapshotAsOf,
    recipeDigest: input.recipeDigest,
    sourceDigest: input.sourceDigest,
    resultDigest: input.resultDigest,
    // catalogVersion/extractorVersion은 현재 같은 값을 재사용한다 — 카탈로그 정의와
    // extractor 구현이 1:1로 묶인 단일 단위이기 때문(§E). 필드는 독립적으로 유지해
    // 나중에 실제로 분리해야 하는 상황이 생겨도 이름을 안 바꿔도 되게 한다.
    catalogVersion: CATALOG_VERSION,
    extractorVersion: CATALOG_VERSION,
    migrationVersion: DETERMINISTIC_MIGRATION_VERSION,
    formulaPolicies: input.formulaPolicies,
    estimabilityPolicyVersion: ESTIMABILITY_POLICY_VERSION,
    engineVersion: STATS_ENGINE_VERSION,
    serializerVersion: SERIALIZER_VERSION,
  };
}

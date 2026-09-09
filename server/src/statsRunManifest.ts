// PR0-C §1.2/§E — run manifest 조립. 새 DB 테이블에 저장하지 않는다(§Context 확정사항 2) —
// 매 /preview 응답 본문에 이 전체를 stamp하고, 감사로그(audit_logs.extra)에도 provenance로
// 남긴다.
import { randomUUID } from 'crypto';
import { CATALOG_VERSION } from '@wr/analytics-core/catalog';
import { DETERMINISTIC_MIGRATION_VERSION } from '@wr/analytics-core/migration/deterministicMigrate';
import type { RunManifest, StatsRunManifestFailed, StatsRunManifestSucceeded } from '@wr/contracts';
import { SERIALIZER_VERSION } from './canonicalSerializer';
import { ESTIMABILITY_POLICY_VERSION } from './statsPolicy';

// PR1 — Python subprocess 기술통계 엔진이 실제로 붙었다(services/stats-engine/analyze.py).
export const STATS_ENGINE_VERSION = 'v1-python-descriptive';

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

// PR1 §4.5 — stats_runs.manifest 컬럼 저장용 discriminated union 헬퍼. 기존
// buildRunManifest()/RunManifestSchema는 그대로 두고(§4.5 — 이미 배포된 /preview·성공
// /analyze HTTP 계약을 약화시키지 않는다), 저장 계층에서만 outcome 태그를 씌운다.
export function toStatsRunManifestSucceeded(manifest: RunManifest): StatsRunManifestSucceeded {
  return { ...manifest, outcome: 'succeeded' };
}

export interface BuildFailedStatsRunManifestInput {
  recipeDigest: string;
  sourceDigest: string;
  snapshotAsOf: string;
  formulaPolicies: Record<string, string>;
}

// 실패 행의 manifest는 resultDigest 필드 자체가 없다(null이 아니라 생략) — 계산 결과가
// 없으므로 정의 불가능한 필드를 억지로 채우지 않는다.
export function buildFailedStatsRunManifest(input: BuildFailedStatsRunManifestInput): StatsRunManifestFailed {
  return {
    analysisRunId: randomUUID(),
    snapshotAsOf: input.snapshotAsOf,
    recipeDigest: input.recipeDigest,
    sourceDigest: input.sourceDigest,
    catalogVersion: CATALOG_VERSION,
    extractorVersion: CATALOG_VERSION,
    migrationVersion: DETERMINISTIC_MIGRATION_VERSION,
    formulaPolicies: input.formulaPolicies,
    estimabilityPolicyVersion: ESTIMABILITY_POLICY_VERSION,
    engineVersion: STATS_ENGINE_VERSION,
    serializerVersion: SERIALIZER_VERSION,
    outcome: 'failed',
  };
}

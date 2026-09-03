// 통계분석 워크벤치 공용 타입 — 계획서(fizzy-meandering-sedgewick.md) §5.2가 정의한 어휘를
// 그대로 옮긴 것. PR0-B2에서 다른 모듈의 extractor도 이 타입을 재사용한다.

export type MissingReason = 'not_entered' | 'not_assessed' | 'not_applicable' | 'structural_missing';

export type QualityFlag =
  | 'possibly_seeded_default'
  | 'invalid'
  | 'orphan_reference'
  | 'legacy_unknown'
  | 'inferred_link'
  | 'conflicting_common_field';

export interface ExtractedValue<T> {
  value: T | null;
  missing: MissingReason | null;
  qualityFlags: QualityFlag[];
}

// deterministicMigrate(§5)의 반환형 — 계층에 따라 다른 shape을 섞어 반환하지 않는다.
// migration은 항상 이 하나의 shape만 반환하고, ExtractedValue로의 해석은 항상 extractor 몫이다.
export interface MigrationIssue {
  code: 'unsupported_legacy_spine_jobs';
  detail?: string;
}

export interface MigrationResult<TPayload> {
  payload: TPayload;
  issues: MigrationIssue[];
}

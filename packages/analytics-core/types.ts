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

// PR0-B2: 6개 모듈이 전부 같은 카탈로그 변수 스키마를 쓰므로(§5 계획서) knee/metadata.ts의
// 로컬 정의를 여기로 옮겼다 — 모듈마다 인터페이스를 복제하면 스키마 변경(예: formulaVersionKey
// 추가)마다 6곳을 손대야 한다. 각 모듈의 metadata.ts는 이 타입을 import해서 쓴다.
export interface AnalyticsVariableMetadata {
  key: string;
  label: string;
  group: string;
  moduleId: string;
  grain: 'person' | 'case' | 'diagnosis_side' | 'job' | 'job_diagnosis' | 'task' | 'vibration_interval';
  type: 'continuous' | 'categorical' | 'ordinal' | 'date' | 'high_cardinality' | 'boolean';
  unit?: string;
  provenance: 'raw' | 'derived' | 'clinician_judgment';
  dependsOn: string[];
  availableAt: 'pre_assessment' | 'assessment' | 'post_decision';
  shownToAssessor: boolean;
  allowedAnalysisPurposes: Array<'association' | 'prediction' | 'formula_audit'>;
  sensitivity: 'non_sensitive' | 'clinical_sensitive' | 'quasi_identifier' | 'staff_identifier' | 'direct_identifier' | 'free_text';
  formulaFamily: string;
  supportedFormulaPolicies: Array<'recompute_recorded_version' | 'recompute_current' | 'stratify_by_version'>;
  // 4라운드 필수 보완: 마스터 계획서 §5 예시엔 있었으나 knee(formulaVersion 필드가 없는 모듈)
  // 이관 시 안 써도 돼서 빠졌다. spine.mddm부터 실제로 필요(§2.3, modules.spine.formulaVersion).
  formulaVersionKey?: string;
}

import { z } from 'zod';

// PR0-A: 통계 워크벤치 권한 계약. 이름을 `capabilities`/`Capabilities`로 짓지 않는다 —
// auth.ts의 CapabilitiesSchema({ aiEnabled, localFallbackAllowed })가 이미 그 이름을
// 배포모드 기능 플래그의 의미로 쓰고 있어 클라이언트 노출 시 혼동을 일으킨다.
export const StatsCapabilityKeySchema = z.enum([
  'stats.view',
  'stats.regression',
  'stats.export_results',
  'stats.export_limited_rows',
  'stats.export_phi',
]);

export const StatsCapabilityDefinitionSchema = z.object({
  key:               StatsCapabilityKeySchema,
  label:             z.string(),
  description:       z.string().nullable(),
  defaultAllRoles:   z.boolean(),
  requiresStepUp:    z.boolean(),
  requiresAdminRole: z.boolean(),
});

export const UserCapabilityGrantStatusSchema = z.enum(['active', 'expired', 'revoked']);

export const UserCapabilityGrantSchema = z.object({
  id:               z.string(),
  userId:           z.string(),
  userName:         z.string(),
  capability:       StatsCapabilityKeySchema,
  grantedBy:        z.string().nullable(),
  grantedByName:    z.string().nullable(),
  grantedAt:        z.string(),
  expiresAt:        z.string().nullable(),
  reason:           z.string(),
  revokedAt:        z.string().nullable(),
  revocationReason: z.string().nullable(),
  status:           UserCapabilityGrantStatusSchema,
});

export const CreateCapabilityGrantRequestSchema = z.object({
  userId:     z.string().uuid(),
  capability: StatsCapabilityKeySchema,
  // trim: 공백만 있는 사유가 grant_revocation_state 등 DB 감사 목적의 "사유"로 저장되면
  // 사실상 빈 값이다. max: reason은 audit_logs.extra(jsonb)에도 실리므로 과도한 길이를 막는다.
  reason:     z.string().trim().min(1).max(500),
  // ISO 8601 문자열만 허용 — 임의 문자열을 받으면 잘못된 날짜가 grant_ttl CHECK 위반으로
  // DB 500이 되거나(§7.2), 파싱 불가능한 값이 조용히 NaN Date로 저장될 수 있다.
  expiresAt:  z.string().datetime({ offset: true }).optional(),
});

export const RevokeCapabilityGrantRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export type StatsCapabilityKey            = z.infer<typeof StatsCapabilityKeySchema>;
export type StatsCapabilityDefinition     = z.infer<typeof StatsCapabilityDefinitionSchema>;
export type UserCapabilityGrantStatus     = z.infer<typeof UserCapabilityGrantStatusSchema>;
export type UserCapabilityGrant           = z.infer<typeof UserCapabilityGrantSchema>;
export type CreateCapabilityGrantRequest  = z.infer<typeof CreateCapabilityGrantRequestSchema>;
export type RevokeCapabilityGrantRequest  = z.infer<typeof RevokeCapabilityGrantRequestSchema>;

// ============================================================================
// PR0-C: snapshot dataset builder + GET /catalog + POST /preview 계약.
// 계획서(pr0-c-snapshot-dataset-builder-sharded-rivest.md) §2 참고.
// ============================================================================

export const StatsGrainSchema = z.enum([
  'person', 'case', 'diagnosis_side', 'job', 'job_diagnosis', 'task', 'vibration_interval',
]);

export const CatalogVariableSchema = z.object({
  key:                      z.string(),
  label:                    z.string(),
  group:                    z.string(),
  moduleId:                 z.string(),
  grain:                    StatsGrainSchema,
  type:                     z.enum(['continuous', 'categorical', 'ordinal', 'date', 'high_cardinality', 'boolean']),
  unit:                     z.string().nullable(),
  provenance:               z.enum(['raw', 'derived', 'clinician_judgment']),
  dependsOn:                z.array(z.string()),
  availableAt:              z.enum(['pre_assessment', 'assessment', 'post_decision']),
  shownToAssessor:          z.boolean(),
  allowedAnalysisPurposes:  z.array(z.enum(['association', 'prediction', 'formula_audit'])),
  sensitivity:              z.enum(['non_sensitive', 'clinical_sensitive', 'quasi_identifier', 'staff_identifier', 'direct_identifier', 'free_text']),
  formulaFamily:            z.string(),
  supportedFormulaPolicies: z.array(z.enum(['recompute_recorded_version', 'recompute_current', 'stratify_by_version'])),
  formulaVersionKey:        z.string().nullable(),
});

export const CatalogResponseSchema = z.object({
  catalogVersion:    z.string(),
  variables:         z.array(CatalogVariableSchema),
  // 이번 PR은 case grain만 실제로 지원한다(카탈로그 7개 변수 전부 case grain) — 나머지
  // 6종은 파이프라인이 지원하지 않는다는 사실 자체를 명시적으로 반환한다.
  supportedGrains:   z.array(StatsGrainSchema),
  unsupportedGrains: z.array(z.object({
    grain:      StatsGrainSchema,
    reasonCode: z.literal('GRAIN_NOT_YET_SUPPORTED'),
  })),
  minimumCohort: z.number().int().positive(),
});

export const StatsFilterOperatorSchema = z.enum([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'is_missing', 'not_missing',
]);

export const StatsFilterSchema = z.object({
  key:      z.string(),
  operator: StatsFilterOperatorSchema,
  // 타입-값 일치(변수 type별 허용 연산자·값 타입)·ordinal 순위 비교 연산자 제한·결측 취급은
  // zod가 아니라 server/src/statsRecipeValidation.ts가 카탈로그 메타데이터를 참조해 동적으로
  // 검사한다(정적 스키마로는 "이 key의 type에 따라 값 형태가 달라진다"를 표현할 수 없다).
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])).max(50),
  ]).optional(),
});

export const StatsAnalysisRecipeSchema = z.object({
  grain:           StatsGrainSchema,
  variableKeys:    z.array(z.string().min(1)).min(1).max(20),
  // 다중 필터는 AND로 결합된다(server/src/statsRecipeValidation.ts §A-7).
  filters:         z.array(StatsFilterSchema).max(10).default([]),
  analysisPurpose: z.enum(['association', 'prediction', 'formula_audit']),
  formulaPolicies: z.record(
    z.string(),
    z.enum(['recompute_recorded_version', 'recompute_current', 'stratify_by_version']),
  ).default({}),
  // encoding/options/rollups(마스터 계획서 §1)는 PR0-C 범위 밖 — .strict()로 보내면 400.
}).strict();

export const RunManifestSchema = z.object({
  analysisRunId: z.string().uuid(),
  snapshotAsOf:  z.string(),
  recipeDigest:  z.string(),
  sourceDigest:  z.string(),
  resultDigest:  z.string(),   // 억제 적용 후 실제 응답 payload의 digest(§E) — 억제 전
                                // 원값을 해시하면 무차별대입으로 역산될 수 있어 절대 안 씀.
  catalogVersion:            z.string(),
  extractorVersion:          z.string(),
  migrationVersion:          z.string(),
  formulaPolicies:           z.record(z.string(), z.string()),
  estimabilityPolicyVersion: z.string(),
  engineVersion:             z.string(),
  serializerVersion:         z.string(),
});

export const PreviewCountsSchema = z.object({
  personCount:      z.number().int().nullable(),
  caseCount:        z.number().int().nullable(),
  observationCount: z.number().int().nullable(),
  suppressed:       z.boolean(),
  minimumCohort:    z.number().int(),
  reasonCode:       z.enum(['MIN_COHORT_NOT_MET', 'DIFFERENCING_RATE_LIMIT']).nullable(),
});

export const EventNonEventEntrySchema = z.object({
  variableKey: z.string(),
  events:      z.number().int().nullable(),
  nonEvents:   z.number().int().nullable(),
  suppressed:  z.boolean(),
});

export const PreviewEstimabilitySchema = z.object({
  completeCaseN:                  z.number().int().nullable(),
  // 값 자체가 nullable — 소수 셀 억제 대상이면 그 키만 null(record/키 구조는 유지).
  missingRatesByVariable:         z.record(z.string(), z.number().nullable()),
  distinctAssignedDoctorClusters: z.number().int().nullable(),
  // outcome/predictor 구분이 레시피에 없어 정의 불가 — 이번 PR엔 항상 null.
  candidateParameterCount:        z.null(),
  eventNonEvent:                  z.array(EventNonEventEntrySchema),
  estimabilityPolicyVersion:      z.string(),
});

export const PreviewRequestSchema = StatsAnalysisRecipeSchema;

export const PreviewResponseSchema = z.object({
  runManifest:   RunManifestSchema,
  counts:        PreviewCountsSchema,
  estimability:  PreviewEstimabilitySchema,
  // PR3의 방법 카탈로그가 아직 없어 항상 빈 배열 — 지어내지 않는다.
  availableMethods:    z.array(z.never()).length(0),
  methodCatalogVersion: z.null(),
  differencing: z.object({
    queryFamilyDigest: z.string(),
    windowMinutes:     z.number(),
    remaining:         z.number().int(),
  }),
});

// ============================================================================
// PR1: Python subprocess worker + stats_runs + POST /analyze(동기) 계약.
// 계획서(pr1-giggly-treehouse.md) §4.5/§5 참고.
// ============================================================================

// stats_runs.manifest 컬럼 저장 전용 — 기존 RunManifestSchema(위, /preview·성공
// /analyze의 HTTP 응답 계약)는 손대지 않는다(§4.5). 성공 행은 RunManifest 그대로
// (resultDigest 필수 문자열), 실패 행은 resultDigest 필드 자체가 없다(생략, null 아님).
export const StatsRunManifestSucceededSchema = RunManifestSchema.extend({
  outcome: z.literal('succeeded'),
});
export const StatsRunManifestFailedSchema = RunManifestSchema.omit({ resultDigest: true }).extend({
  outcome: z.literal('failed'),
});
export const StatsRunManifestSchema = z.discriminatedUnion('outcome', [
  StatsRunManifestSucceededSchema,
  StatsRunManifestFailedSchema,
]);

export type StatsRunManifestSucceeded = z.infer<typeof StatsRunManifestSucceededSchema>;
export type StatsRunManifestFailed    = z.infer<typeof StatsRunManifestFailedSchema>;
export type StatsRunManifest          = z.infer<typeof StatsRunManifestSchema>;

// Python 엔진이 null로 만드는 이유 — 억제(§4.2)와는 다른 축(계산 불능 vs 정책적 은닉).
export const StatsNullReasonSchema = z.enum(['insufficient_data', 'undefined_zero_variance', 'non_finite_result']);

export const AnalyzeMissingPatternEntrySchema = z.object({
  reasonCode: z.enum(['not_entered', 'not_assessed', 'not_applicable', 'structural_missing']),
  count: z.number().int().nonnegative(),
});

// 억제된 변수는 이 두 필드 외에는 아무것도 담지 않는다(§4.2 — nullReasons 등 부가정보가
// 남으면 그 자체로 데이터 특성이 새어나간다는 1차 검토 지적 반영).
const AnalyzeContinuousSuppressedSchema = z.object({
  variableKey: z.string(),
  kind: z.literal('continuous'),
  suppressed: z.literal(true),
});
const AnalyzeContinuousRevealedSchema = z.object({
  variableKey: z.string(),
  kind: z.literal('continuous'),
  suppressed: z.literal(false),
  n: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  // reasonCode 중 하나라도 소수 셀이면 전체 생략(부분억제 금지, §4.2) — null이면 생략됐다는 뜻.
  missingPatterns: z.array(AnalyzeMissingPatternEntrySchema).nullable(),
  mean: z.number().nullable(),
  sd: z.number().nullable(),
  median: z.number().nullable(),
  q1: z.number().nullable(),
  q3: z.number().nullable(),
  iqr: z.number().nullable(),
  skewness: z.number().nullable(),
  kurtosis: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  nullReasons: z.record(z.string(), StatsNullReasonSchema),
});
export const AnalyzeContinuousResultSchema = z.discriminatedUnion('suppressed', [
  AnalyzeContinuousSuppressedSchema,
  AnalyzeContinuousRevealedSchema,
]);

const AnalyzeDiscreteSuppressedSchema = z.object({
  variableKey: z.string(),
  kind: z.literal('discrete'),
  suppressed: z.literal(true),
});
export const AnalyzeDiscreteLevelSchema = z.object({
  level: z.union([z.string(), z.boolean()]),
  count: z.number().int().nonnegative(),
  proportion: z.number(),
});
const AnalyzeDiscreteRevealedSchema = z.object({
  variableKey: z.string(),
  kind: z.literal('discrete'),
  suppressed: z.literal(false),
  n: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  missingPatterns: z.array(AnalyzeMissingPatternEntrySchema).nullable(),
  levels: z.array(AnalyzeDiscreteLevelSchema),
  mode: z.union([z.string(), z.boolean()]).nullable(),
});
export const AnalyzeDiscreteResultSchema = z.discriminatedUnion('suppressed', [
  AnalyzeDiscreteSuppressedSchema,
  AnalyzeDiscreteRevealedSchema,
]);

export const AnalyzeResultSchema = z.object({
  continuous: z.array(AnalyzeContinuousResultSchema),
  discrete:   z.array(AnalyzeDiscreteResultSchema),
});

export const AnalyzeRequestSchema = StatsAnalysisRecipeSchema;

export const AnalyzeResponseSchema = z.object({
  runManifest: RunManifestSchema,
  result:      AnalyzeResultSchema,
});

export type StatsNullReason               = z.infer<typeof StatsNullReasonSchema>;
export type AnalyzeMissingPatternEntry    = z.infer<typeof AnalyzeMissingPatternEntrySchema>;
export type AnalyzeContinuousResult       = z.infer<typeof AnalyzeContinuousResultSchema>;
export type AnalyzeDiscreteLevel          = z.infer<typeof AnalyzeDiscreteLevelSchema>;
export type AnalyzeDiscreteResult         = z.infer<typeof AnalyzeDiscreteResultSchema>;
export type AnalyzeResult                 = z.infer<typeof AnalyzeResultSchema>;
export type AnalyzeRequest                = z.infer<typeof AnalyzeRequestSchema>;
export type AnalyzeResponse               = z.infer<typeof AnalyzeResponseSchema>;

export type StatsGrain            = z.infer<typeof StatsGrainSchema>;
export type CatalogVariable          = z.infer<typeof CatalogVariableSchema>;
export type CatalogResponse          = z.infer<typeof CatalogResponseSchema>;
export type StatsFilterOperator   = z.infer<typeof StatsFilterOperatorSchema>;
export type StatsFilter           = z.infer<typeof StatsFilterSchema>;
export type StatsAnalysisRecipe           = z.infer<typeof StatsAnalysisRecipeSchema>;
export type RunManifest              = z.infer<typeof RunManifestSchema>;
export type PreviewCounts            = z.infer<typeof PreviewCountsSchema>;
export type EventNonEventEntry       = z.infer<typeof EventNonEventEntrySchema>;
export type PreviewEstimability      = z.infer<typeof PreviewEstimabilitySchema>;
export type PreviewRequest           = z.infer<typeof PreviewRequestSchema>;
export type PreviewResponse          = z.infer<typeof PreviewResponseSchema>;

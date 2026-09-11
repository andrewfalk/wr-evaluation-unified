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

// PR3-A — 이변량 검정 10종(실행 가능 8종 + 예약된 unsupported 2종, 계획서
// pr3-swift-waterfall.md § "실행 가능한 방법은 8종"). 대응검정 2종도 스키마
// enum에는 포함시킨다 — 그래야 zod가 generic INVALID_RECIPE로 뭉개지 않고
// statsMethodCatalog이 `PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING`라는 구체적
// reasonCode를 낼 수 있다.
export const StatsMethodIdSchema = z.enum([
  'welch_t', 'mann_whitney', 'anova', 'kruskal_wallis',
  'chi_square', 'fisher_exact',
  'pearson_correlation', 'spearman_correlation',
  'paired_t', 'wilcoxon_signed_rank',
]);

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
  // PR3-A — analysisMode 기본값 'descriptive'는 순수 additive: PR1/PR2가 이미 보내는
  // 요청(이 필드 자체가 없음)을 그대로 기술통계로 해석한다. requestedMethod는 완전
  // optional — /preview는 이 값의 유효성을 검사하지 않는다(계획서 § "preview는
  // 관대하다" — 방법을 아직 안 고른 최초 preview도 정상 응답해야 availableMethods를
  // 볼 수 있다). /analyze에서만 statsRecipeValidation.ts(context='analyze')가
  // 엄격하게 검사한다.
  analysisMode:    z.enum(['descriptive', 'bivariate']).default('descriptive'),
  requestedMethod: StatsMethodIdSchema.optional(),
  // encoding/options/rollups(마스터 계획서 §1)는 PR0-C 범위 밖 — .strict()로 보내면 400.
}).strict().superRefine((recipe, ctx) => {
  // 카탈로그 조회가 필요 없는 순수 구조검사만 여기서 한다(컨텍스트 무관 — preview·
  // analyze 둘 다 항상 참). 타입정합성·paired영구거부·method필수여부(컨텍스트별로
  // 다름)는 카탈로그가 필요해 statsRecipeValidation.ts(context 인자)가 담당한다.
  if (recipe.analysisMode !== 'bivariate') return;
  if (recipe.variableKeys.length !== 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'BIVARIATE_REQUIRES_EXACTLY_TWO_VARIABLES',
      path: ['variableKeys'],
    });
  } else if (recipe.variableKeys[0] === recipe.variableKeys[1]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SAME_VARIABLE_SELECTED_TWICE',
      path: ['variableKeys'],
    });
  }
});

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
  // PR3-A — 신규 필드는 전부 optional(구버전 stats_runs.manifest/result JSONB
  // 재파싱 호환, statsExportHandler.ts의 safeParse가 이 필드 없는 구행도 깨지지
  // 않아야 함). inferenceGatePolicyVersion은 §6.1 게이트 정책 버전, analysisMode는
  // CSV export 거부 판정의 단일 진실원(result.bivariate 존재 여부로 판정하지
  // 않는다 — 계획서 §"결과 계약 불변조건").
  inferenceGatePolicyVersion: z.string().optional(),
  analysisMode:               z.enum(['descriptive', 'bivariate']).optional(),
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

// PR3-A §6.9.1 — availableMethods[] 방법 카탈로그. A-1(항상 안전: 카탈로그
// 메타데이터·§6.1 게이트·쌍 전체 0건)과 A-2(그룹/표 브레이크다운이 소수셀 없이
// 깨끗할 때만 계산·노출 — 계획서 § "개수 정보도 소수셀 검사를 통과해야 노출
// 가능하다") 둘 다 이 스키마 하나로 표현한다. B(그룹/셀 소수셀·값상수·제외사유
// 소수셀)는 절대 별도 reasonCode를 만들지 않으므로 이 enum에 없다.
export const StatsMethodReasonCodeSchema = z.enum([
  'METHOD_TYPE_MISMATCH',
  'PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING',
  'REPEATED_MEASURES_NOT_ALIGNED',
  'INSUFFICIENT_DATA',
  'REQUIRES_EXACTLY_TWO_GROUPS',
  'REQUIRES_AT_LEAST_TWO_GROUPS',
  'REQUIRES_AT_LEAST_TWO_LEVELS',
  'TABLE_NOT_2X2',
  'LOW_EXPECTED_COUNT',
]);

export const AvailableMethodSchema = z.object({
  id:      StatsMethodIdSchema,
  label:   z.string(),
  purpose: z.enum(['association', 'prediction', 'formula_audit']),
  status:  z.enum(['available', 'conditional', 'unsupported']),
  reasonCode: StatsMethodReasonCodeSchema.nullable(),
  observed: z.object({
    personCount: z.number().int().nullable(),
    rowCount:    z.number().int().nullable(),
  }),
  required: z.object({ rule: z.string() }).nullable(),
  // "실제로 실행 가능할 때만" 채운다(§6.9.1) — 현재 유일한 remedy 경로는 chi_square
  // 기대도수 부족 시 fisher_exact 전환 제안(표가 이미 2×2일 때만).
  remedy:             z.string().nullable(),
  remedyRecipePatch:  z.object({ requestedMethod: StatsMethodIdSchema }).nullable(),
  methodPolicyVersion: z.string(),
});

export const PreviewResponseSchema = z.object({
  runManifest:   RunManifestSchema,
  counts:        PreviewCountsSchema,
  estimability:  PreviewEstimabilitySchema,
  // descriptive 모드거나 쌍이 억제 상태(§"통합 공개통제 게이트")면 빈 배열 — 지어내지 않는다.
  availableMethods:     z.array(AvailableMethodSchema),
  methodCatalogVersion: z.string().nullable(),
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
// PR3-A가 이변량 전용 2종(constant_variable/insufficient_group_data)을 추가했다
// (계획서 §Python엔진 공통 envelope) — 기존 기술통계 결과는 여전히 앞 3종만 쓴다.
export const StatsNullReasonSchema = z.enum([
  'insufficient_data', 'undefined_zero_variance', 'non_finite_result',
  'constant_variable', 'insufficient_group_data',
]);

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

// PR3-A — 이변량 결과. §"방법 가용성 판정" A/B 원칙을 그대로 반영: 억제 시
// {method, suppressed:true}뿐(수치·CI·제외상세 일절 없음, B-1 그룹/셀소수셀·값상수
// 전부 이 형태로 수렴). 공개 시에도 exclusions는 독립 판정(B-2, §"결과 계약
// 불변조건" — excludedCaseCount는 억제 여부와 무관하게 유지, exclusions 상세만
// 별도로 null일 수 있음).
export const StatsMethodEffectSizeSchema = z.object({
  name:  z.string(),
  value: z.number().nullable(),
  ci:    z.tuple([z.number(), z.number()]).nullable(),
  ciUnavailableReason: z.enum(['not_supported_v1', 'undefined_at_n', 'perfect_correlation']).nullable(),
});

export const AnalyzeBivariateExclusionEntrySchema = z.object({
  reasonCode: z.enum(['x_missing', 'y_missing', 'both_missing']),
  count: z.number().int().nonnegative(),
});

const AnalyzeBivariateSuppressedSchema = z.object({
  method: StatsMethodIdSchema,
  suppressed: z.literal(true),
});
const AnalyzeBivariateRevealedSchema = z.object({
  method: StatsMethodIdSchema,
  suppressed: z.literal(false),
  n: z.number().int().nonnegative(),
  statistic: z.number().nullable(),
  df: z.union([
    z.number(),
    z.object({ numerator: z.number(), denominator: z.number() }),
  ]).nullable(),
  pValue: z.number().nullable(),
  effectSizes: z.array(StatsMethodEffectSizeSchema),
  nullReasons: z.record(z.string(), StatsNullReasonSchema),
  multipleTesting: z.object({
    method: z.literal('none'),
    adjustedP: z.number().nullable(),
  }),
  qualityFlags: z.array(z.enum(['low_expected_count', 'haldane_anscombe_applied'])),
  extra: z.object({ cramersV: StatsMethodEffectSizeSchema.optional() }).default({}),
  // §"결과 계약 불변조건" — excludedCaseCount는 항상 공개(0 또는 ≥MINIMUM_COHORT임이
  // 이미 레이어1에서 보장됨), exclusions 상세는 사유별 소수셀이면 null(B-2, 독립 판정).
  excludedCaseCount: z.number().int().nonnegative(),
  exclusions: z.array(AnalyzeBivariateExclusionEntrySchema).nullable(),
});
export const AnalyzeBivariateResultSchema = z.discriminatedUnion('suppressed', [
  AnalyzeBivariateSuppressedSchema,
  AnalyzeBivariateRevealedSchema,
]);

export const AnalyzeResultSchema = z.object({
  continuous: z.array(AnalyzeContinuousResultSchema),
  discrete:   z.array(AnalyzeDiscreteResultSchema),
  // PR3-A — analysisMode==='bivariate'인 신규 실행 결과는 억제 여부와 무관하게
  // 항상 존재(계획서 §"결과 계약 불변조건"). optional인 이유는 구버전 저장 결과
  // (PR1/PR2가 만든, 이 필드 자체가 없는 stats_runs.result) 재파싱 호환뿐이다 —
  // "선택적 기능"이라는 뜻이 아니다.
  bivariate: AnalyzeBivariateResultSchema.optional(),
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
export type StatsMethodId                 = z.infer<typeof StatsMethodIdSchema>;
export type StatsMethodReasonCode         = z.infer<typeof StatsMethodReasonCodeSchema>;
export type AvailableMethod               = z.infer<typeof AvailableMethodSchema>;
export type StatsMethodEffectSize         = z.infer<typeof StatsMethodEffectSizeSchema>;
export type AnalyzeBivariateExclusionEntry = z.infer<typeof AnalyzeBivariateExclusionEntrySchema>;
export type AnalyzeBivariateResult        = z.infer<typeof AnalyzeBivariateResultSchema>;
export type AnalyzeResult                 = z.infer<typeof AnalyzeResultSchema>;
export type AnalyzeRequest                = z.infer<typeof AnalyzeRequestSchema>;
export type AnalyzeResponse               = z.infer<typeof AnalyzeResponseSchema>;

// ============================================================================
// PR2: 집계 결과 내보내기 계약. `stats_runs`에 이미 억제 적용 후 저장된 manifest/result를
// 그대로 CSV로 포맷할 뿐이라 recipe를 다시 받지 않는다 — analysisRunId 하나만 필요하다
// (계획서 §7 "aggregate export는 저장된 결과를 그대로 내보낸다").
// ============================================================================

export const ExportAggregateRequestSchema = z.object({
  analysisRunId: z.string().uuid(),
});

export type ExportAggregateRequest = z.infer<typeof ExportAggregateRequestSchema>;

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

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

export const StatsGrainSchema = z.enum(['case', 'disease', 'job']);

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
  // PR0-B3 Part C — 필터 전용 변수 계약(계획 "필터 전용 변수 계약" 절). .default()로 기존
  // 변수는 스키마 변경 없이 'analyzable'로 해석된다. 'filter_only'는 분석 변수 후보에서는
  // 빠지지만(CatalogPanel.jsx) 현재 grain 안에서는 여전히 필터로 선택 가능하다(RecipePanel.jsx
  // FilterEditor는 grain만 거르고 analysisRole은 보지 않음 — 등록일이 대표 사례).
  analysisRole:             z.enum(['analyzable', 'filter_only']).default('analyzable'),
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
  // PR4-A1 — 연관성 회귀 2종(계획서 §6.9.2). outcome 타입(continuous/boolean)이
  // 자동 결정하지만 requestedMethod로 명시도 가능(§6.5 인코딩 고정 원칙).
  'ols_linear', 'binary_logistic',
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
  // PR3-B — 'correlation_matrix' 추가(계획서 §4). variableKeys는 3개 이상 선택하는
  // 다중 변수 모드다("전부 continuous여야 한다"는 카탈로그 조회가 필요해 zod가 아니라
  // statsRecipeValidation.ts가 검사 — §7 "구조검증/의미검증 분리").
  // PR4-A1 — 'regression' 추가. requestedMethod는 다른 모드와 마찬가지로 여기서는
  // 계속 optional이다(리뷰 #1) — 방법 미선택 상태의 최초 preview도 정상 응답해야
  // availableMethods를 볼 수 있다. 필수 여부는 statsRecipeValidation.ts의
  // context==='analyze'에서만 강제한다.
  analysisMode:    z.enum(['descriptive', 'bivariate', 'correlation_matrix', 'regression']).default('descriptive'),
  requestedMethod: StatsMethodIdSchema.optional(),
  // PR4-A1 — 회귀 전용 서브객체. variableKeys는 그대로 재사용하고(진실원 하나만
  // 유지), predictors는 variableKeys에서 outcomeKey를 뺀 나머지(원래 순서 유지 —
  // forest plot 행 순서가 된다)로 파생한다. referenceLevels 값 검증(카탈로그 필요)은
  // statsRecipeValidation.ts가 담당한다.
  // PR4-A2 — eventLevel(categorical 2레벨 outcome 전용) · standardizePredictors ·
  // interactionTerms · splineKeys 추가. 이 넷의 타입/교차 제약 중 카탈로그가 필요
  // 없는 것(중복·자기자신 쌍·predictor 집합 소속)은 아래 superRefine에서, 카탈로그가
  // 필요한 것(spline은 continuous만·eventLevel은 categorical outcome에만)은
  // statsRecipeValidation.ts가 담당한다(계획서 §1 "이것만으로는 부족하다").
  regression: z.object({
    outcomeKey: z.string().min(1),
    referenceLevels: z.record(z.string(), z.string()).default({}),
    eventLevel: z.string().optional(),
    standardizePredictors: z.boolean().default(false),
    interactionTerms: z.array(z.tuple([z.string(), z.string()])).default([]),
    splineKeys: z.array(z.string()).default([]),
  }).strict().optional(),
  // encoding/options/rollups(마스터 계획서 §1)는 PR0-C 범위 밖 — .strict()로 보내면 400.
}).strict().superRefine((recipe, ctx) => {
  // 카탈로그 조회가 필요 없는 순수 구조검사만 여기서 한다(컨텍스트 무관 — preview·
  // analyze 둘 다 항상 참). 타입정합성·paired영구거부·method필수여부(컨텍스트별로
  // 다름)는 카탈로그가 필요해 statsRecipeValidation.ts(context 인자)가 담당한다.
  if (recipe.analysisMode === 'bivariate') {
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
    return;
  }
  if (recipe.analysisMode === 'correlation_matrix') {
    // PR3-B 계획서 §4/§7 — variableKeys 개수·중복만 여기서(구조), "전부
    // continuous"는 statsRecipeValidation.ts(의미, 카탈로그 필요).
    if (recipe.variableKeys.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CORRELATION_MATRIX_REQUIRES_AT_LEAST_THREE_VARIABLES',
        path: ['variableKeys'],
      });
    }
    if (new Set(recipe.variableKeys).size !== recipe.variableKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DUPLICATE_VARIABLE_SELECTED',
        path: ['variableKeys'],
      });
    }
    return;
  }
  if (recipe.analysisMode === 'regression') {
    // PR4-A1 — 카탈로그가 필요 없는 구조검사만(리뷰 #1 — requestedMethod 필수여부는
    // 여기서 검사하지 않는다). outcome 타입 정합성·predictor 타입 적격성·
    // referenceLevels 값 검증은 statsRecipeValidation.ts(context 인자, 카탈로그 필요).
    if (!recipe.regression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REGRESSION_REQUIRES_REGRESSION_OBJECT',
        path: ['regression'],
      });
      return;
    }
    if (recipe.variableKeys.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REGRESSION_REQUIRES_AT_LEAST_TWO_VARIABLES',
        path: ['variableKeys'],
      });
    }
    if (new Set(recipe.variableKeys).size !== recipe.variableKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DUPLICATE_VARIABLE_SELECTED',
        path: ['variableKeys'],
      });
    }
    if (!recipe.variableKeys.includes(recipe.regression.outcomeKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REGRESSION_OUTCOME_MUST_BE_IN_VARIABLE_KEYS',
        path: ['regression', 'outcomeKey'],
      });
    }

    // PR4-A2 §1 — interaction/spline 구조검사(카탈로그 불필요). predictor 집합은
    // variableKeys - outcomeKey(카탈로그 조회 없이도 알 수 있다).
    const predictorKeySet = new Set(
      recipe.variableKeys.filter((k) => k !== recipe.regression!.outcomeKey),
    );
    const seenInteractionPairs = new Set<string>();
    recipe.regression.interactionTerms.forEach(([a, b], index) => {
      if (a === b) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'INTERACTION_REQUIRES_TWO_DISTINCT_VARIABLES',
          path: ['regression', 'interactionTerms', index],
        });
        return;
      }
      // [A,B]와 [B,A]를 같은 쌍으로 정규화해서 비교한다.
      const normalized = [a, b].sort().join('\u0000');
      if (seenInteractionPairs.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DUPLICATE_INTERACTION_TERM',
          path: ['regression', 'interactionTerms', index],
        });
        return;
      }
      seenInteractionPairs.add(normalized);
      for (const key of [a, b]) {
        if (!predictorKeySet.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'INTERACTION_VARIABLE_MUST_BE_A_PREDICTOR',
            path: ['regression', 'interactionTerms', index],
          });
        }
      }
    });

    const splineKeySet = new Set<string>();
    recipe.regression.splineKeys.forEach((key, index) => {
      if (splineKeySet.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DUPLICATE_SPLINE_KEY',
          path: ['regression', 'splineKeys', index],
        });
        return;
      }
      splineKeySet.add(key);
      if (!predictorKeySet.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SPLINE_VARIABLE_MUST_BE_A_PREDICTOR',
          path: ['regression', 'splineKeys', index],
        });
      }
    });

    // spline predictor는 interaction에 전면 금지(v1) — 대비(contrast) 정의가
    // spline 블록에만 0이 아닌 값을 갖는다는 전제가 깨진다(계획서 §1/§3).
    recipe.regression.interactionTerms.forEach(([a, b], index) => {
      if (splineKeySet.has(a) || splineKeySet.has(b)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SPLINE_INTERACTION_NOT_SUPPORTED',
          path: ['regression', 'interactionTerms', index],
        });
      }
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
  // PR3-B — 'correlation_matrix' 추가. resultDigest는 여전히 stats_runs.result에
  // 저장되는(=캐시되는) aggregate-only 페이로드 전용이다 — limited_row 필드(boxplot
  // outlierValues·scatter 원시 points)가 응답시점에 merge된 뒤의 바이트와는 다를 수
  // 있다(계획서 §6/§9). 그 권한별 응답의 digest는 필요 시 감사로그의
  // deliveredResultDigest로만 남긴다(manifest에는 안 남김).
  // PR4-A1 — 'regression' 추가. 나머지 원칙은 그대로(구버전 재파싱 호환용 optional).
  analysisMode:               z.enum(['descriptive', 'bivariate', 'correlation_matrix', 'regression']).optional(),
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
  // PR4-A1 — outcome/predictor 구분이 회귀 레시피로 생겼으므로 실제 파라미터 수를
  // 계산할 수 있다(더미 확장 후 절편 제외). regression 모드가 아니거나 공개통제
  // (③)를 통과하지 못했으면 여전히 null — "미생성"이지 "생략"이 아니다(리뷰 #14).
  candidateParameterCount:        z.number().int().nullable(),
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
  // PR3-B — 상관행렬 방법 카탈로그 전용(계획서 §4). 상관행렬은 "선택 가능/불가능"
  // 까지만 판정하고 셀별 세부판정은 하지 않으므로 A-2급 reasonCode를 늘리지 않는다.
  'CORRELATION_MATRIX_REQUIRES_AT_LEAST_THREE_VARIABLES',
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
// PR4-B1 — pending(admission이 queued 행을 INSERT할 때 채우는 manifest — manifest
// 컬럼은 NOT NULL이라 뭔가는 있어야 함)과 cancelled(finishRun이 취소로 종결할 때)도
// failed와 같은 shape(resultDigest 없음)을 공유한다 — 셋 다 "계산 결과가 확정되지
// 않았거나 폐기됐다"는 점에서 동일. 4개 outcome 전부 admission이 발급한
// analysisRunId를 그대로 유지한다(buildXxxStatsRunManifest의 analysisRunId? 오버라이드
// 인자 — statsRunManifest.ts).
export const StatsRunManifestPendingSchema = RunManifestSchema.omit({ resultDigest: true }).extend({
  outcome: z.literal('pending'),
});
export const StatsRunManifestCancelledSchema = RunManifestSchema.omit({ resultDigest: true }).extend({
  outcome: z.literal('cancelled'),
});
export const StatsRunManifestSchema = z.discriminatedUnion('outcome', [
  StatsRunManifestSucceededSchema,
  StatsRunManifestFailedSchema,
  StatsRunManifestPendingSchema,
  StatsRunManifestCancelledSchema,
]);

export type StatsRunManifestSucceeded = z.infer<typeof StatsRunManifestSucceededSchema>;
export type StatsRunManifestFailed    = z.infer<typeof StatsRunManifestFailedSchema>;
export type StatsRunManifestPending   = z.infer<typeof StatsRunManifestPendingSchema>;
export type StatsRunManifestCancelled = z.infer<typeof StatsRunManifestCancelledSchema>;
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
// PR3-B — 히스토그램 bin(계획서 §2). disclosureClass=aggregate: person 소수셀이면
// (Node가 이 경계로 DatasetRow[]를 재순회해 판정, Python의 row-count가 아니라
// person count 기준) B안(적응형 해상도 축소)이 정해진 후보 해상도로 재분할해
// 공개 가능한 가장 세밀한 것을 채택한다 — 그마저 전부 실패해야 histogram 전체가
// 생략된다(AnalyzeContinuousRevealedSchema.histogramReasonCode 참고). 경계
// 포함규칙은 numpy.histogram과 동일 — 마지막 bin만 양끝 포함(right closed),
// 나머지는 왼쪽 포함/오른쪽 배제.
export const AnalyzeHistogramBinSchema = z.object({
  lower: z.number(),
  upper: z.number(),
  count: z.number().int().nonnegative(),
});
export const AnalyzeHistogramSchema = z.object({
  bins: z.array(AnalyzeHistogramBinSchema),
  // B안 — 원본(Python) bin보다 구간 수를 줄여 재분할했으면 true. 정확한 원본 bin
  // 개수는 일부러 넣지 않는다 — bin 개수 자체가 person_count 기반 공식과 조합되면
  // 지금 결과 어디에도 없는 presentPersonCount를 역산하는 실마리가 될 수 있다.
  merged: z.boolean().optional(),
});

// PR3-B — 박스플롯(계획서 §1/§3). q1/median/q3/lowerWhisker/upperWhisker는 이
// 스키마가 존재하면(=histogram과 같은 전체연결억제 게이트를 통과했으면) 항상 값이
// 있다 — 범위값 자체는 어느 집단 크기도 드러내지 않기 때문. outlierCount/
// outlierValues는 그와 **별개의** 독립 게이트(이상치·비이상치 양쪽 partition의
// person 고유 인원이 전부 0이거나 ≥MINIMUM_COHORT)를 추가로 통과해야 한다 — 이
// 필드 존재조건은 disclosureClass=aggregate/limited_row가 아니라 "소수셀 억제
// 면제"와는 무관하다는 뜻이다. outlierCount는 이상치로 분류된 "관측 건수"(건)이지
// 고유 인원수(명)가 아니다 — UI 라벨도 "건"으로 표기한다. outlierValues(정확한
// 좌표, limited_row)는 outlierCount가 있을 때만(그 역은 성립 안 함) 추가로
// stats.export_limited_rows 권한 + 응답 감사 성공까지 필요하다(계획서 §1/§9).
export const AnalyzeBoxplotSchema = z.object({
  q1: z.number(),
  median: z.number(),
  q3: z.number(),
  lowerWhisker: z.number(),
  upperWhisker: z.number(),
  outlierCount: z.number().int().nonnegative().optional(),
  outlierValues: z.array(z.number()).optional(),
}).superRefine((boxplot, ctx) => {
  if (boxplot.outlierValues !== undefined && boxplot.outlierCount === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'outlierValues는 outlierCount 없이 존재할 수 없다',
      path: ['outlierValues'],
    });
  }
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
  // PR3-B — n=0(계산 불가) 또는 히스토그램/박스플롯 자체가 전체연결억제로
  // 생략됐으면 null(필드는 존재, 값이 null — "이 변수 자체가 아예 없음"과 구분).
  histogram: AnalyzeHistogramSchema.nullable().optional(),
  // B안 — histogram이 null인 이유를 구분한다: n=0이라 애초에 히스토그램 자체가
  // 없던 경우엔 null(기존과 동일), B안의 폴백 후보를 전부 시도해도 공개 가능한
  // 해상도가 없던 경우에만 이 값이 채워진다(PreviewCountsSchema.reasonCode와
  // 동일한 네이밍 패턴).
  histogramReasonCode: z.enum(['INSUFFICIENT_DISCLOSABLE_RESOLUTION']).nullable().optional(),
  boxplot: AnalyzeBoxplotSchema.nullable().optional(),
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
  // [코드리뷰 2026-09-12] 억제(suppressed=false)에 도달했다는 것 자체가 이미
  // B-1(그룹/셀 소수셀) 사전검사를 통과했다는 뜻이므로, 그룹 라벨·그룹별 n·분할표
  // 셀 값을 공개해도 안전하다(전부 0 또는 ≥MINIMUM_COHORT) — §5 "분할표 전체연결
  // 억제"가 애초에 "억제 아니면 표를 포함해 공개"를 의도했는데 1차 구현에서 값
  // 자체를 응답에 담는 배선이 누락됐었다. groupBreakdown=그룹비교 전용(뒤-앞
  // 방향규칙과 같은 순서), contingencyTable=분할표 전용 — method에 따라 정확히
  // 하나만 채워진다(상관은 둘 다 없음).
  // PR3-B — 그룹별 박스플롯(계획서 §5/§9). 그룹 단위 게이트(isGroupBreakdownDisclosable,
  // A-2)를 이미 통과한 그룹이라도, 그 그룹 내부의 이상치·비이상치 partition은
  // AnalyzeBoxplotSchema와 동일한 독립 게이트를 별도로 적용해야 한다(그룹 전체
  // 인원만 보는 기존 게이트로는 그룹 내부 소수 이상치 집단을 못 막는다).
  groupBreakdown: z.array(z.object({
    label: z.union([z.string(), z.boolean()]),
    n: z.number().int().nonnegative(),
    boxplot: AnalyzeBoxplotSchema.optional(),
  })).optional(),
  contingencyTable: z.object({
    rowLabels: z.array(z.union([z.string(), z.boolean()])),
    colLabels: z.array(z.union([z.string(), z.boolean()])),
    cells: z.array(z.array(z.number().int().nonnegative())),
  }).optional(),
  // PR3-B — 상관 method(pearson/spearman) 전용, 형제 필드(extra 안이 아님 — extra는
  // 효과크기 shape 전용이라 {slope,intercept}를 담을 수 없다, statsEngine.ts의
  // StatsEngineEffectSizeSchema 확인). pearson만 값을 가지고, 계산 불가(상수·표본
  // 부족)거나 spearman이면 null.
  regressionLine: z.object({
    slope: z.number(),
    intercept: z.number(),
  }).nullable().optional(),
  // PR3-B — 산점도(계획서 §2/§6.8.1). points(원시 좌표)는 limited_row라
  // stats.export_limited_rows 권한 + 응답 감사 성공이 있을 때만 응답시점에
  // merge된다(§9, 캐시에는 절대 저장 안 함). grid는 aggregate — 단 그리드 전체가
  // person 소수셀이면 grid 자체가 없다(전체연결억제). displayedCount/totalCount로
  // "표시 중 n / 전체 n"을 구분(과밀 샘플링 시 §6.8.4). 회귀선·r·p값은 항상 전체
  // 유효 pairwise-complete 집합 기준 — 화면 표시가 샘플/그리드로 축소돼도 통계량
  // 자체는 축소되지 않는다.
  scatter: z.object({
    displayedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    points: z.array(z.tuple([z.number(), z.number()])).optional(),
    grid: z.object({
      xEdges: z.array(z.number()),
      yEdges: z.array(z.number()),
      cells: z.array(z.object({
        i: z.number().int().nonnegative(),
        j: z.number().int().nonnegative(),
        count: z.number().int().nonnegative(),
      })),
    }).optional(),
  }).optional(),
});
export const AnalyzeBivariateResultSchema = z.discriminatedUnion('suppressed', [
  AnalyzeBivariateSuppressedSchema,
  AnalyzeBivariateRevealedSchema,
]);

// PR3-B — 상관행렬(계획서 §4, 4차 코드리뷰로 단순화됨). 기존 단일쌍 이변량과
// 완전히 동일한 정책을 재사용한다 — 셀은 suppressed:true/false 2단뿐이고,
// suppressed:false는 항상 r/pValue/n이 실수(계산 불가·소수셀·§6.1 반복측정 게이트
// 실패 전부 동일하게 불투명 suppressed:true로 수렴, "revealed인데 null" 상태는
// 없다). cells는 항상 요청된 C(k,2)개 전부를 담는다(계산 가능 여부와 무관 —
// 절대 빈 배열이 되지 않는다). adjustedP는 suppressed:false 셀에서만 존재하고,
// 매트릭스 안에 suppressed:true 셀이 하나라도 있으면 전부 null로 덮이며
// adjustedPWithheld:true가 세팅된다(BH-FDR의 누적계산이 억제될 셀의 raw p값까지
// 반영해 계산되므로, 남은 adjustedP에 그 흔적이 묻어있을 수 있기 때문 — §4.1).
// 상관행렬 셀에는 limited_row 필드가 전혀 없다(r/pValue/n/adjustedP 전부 집계
// 통계량) — §9(캐시-권한 드리프트 방지)는 상관행렬에 적용되지 않는다.
const AnalyzeCorrelationMatrixCellSuppressedSchema = z.object({
  suppressed: z.literal(true),
  xKey: z.string(),
  yKey: z.string(),
});
const AnalyzeCorrelationMatrixCellRevealedSchema = z.object({
  suppressed: z.literal(false),
  xKey: z.string(),
  yKey: z.string(),
  n: z.number().int().nonnegative(),
  r: z.number(),
  pValue: z.number(),
  adjustedP: z.number().nullable(),
});
export const AnalyzeCorrelationMatrixCellSchema = z.discriminatedUnion('suppressed', [
  AnalyzeCorrelationMatrixCellSuppressedSchema,
  AnalyzeCorrelationMatrixCellRevealedSchema,
]);
export const AnalyzeCorrelationMatrixResultSchema = z.object({
  method: z.enum(['pearson_correlation', 'spearman_correlation']),
  variableKeys: z.array(z.string()),
  cells: z.array(AnalyzeCorrelationMatrixCellSchema),
  adjustedPWithheld: z.boolean(),
});

// ============================================================================
// PR4-A1: 연관성 회귀(OLS·이분 로지스틱) 결과 계약. 계획서(pr4-a-lexical-reddy.md)
// §1 "결과 스키마 — 상태 4종" 참고. 억제(suppressed)는 기존 3곳과 같은
// discriminated union 패턴이되, 안쪽에 estimation(ok/inference_withheld/
// non_estimable) 3단을 둔다 — §6.7(완전분리는 non_estimable로 종료)과
// §6.4(클러스터 부족 시 계수·SE만 표시하고 p·CI 차단)를 계약으로 고정한다.
// ============================================================================

export const RegressionNonEstimableReasonSchema = z.enum([
  'INSUFFICIENT_COMPLETE_ROWS',
  'TOO_MANY_LEVELS',
  'TOO_MANY_PARAMETERS',
  'INSUFFICIENT_EVENTS_PER_PARAMETER',
  'CONSTANT_OUTCOME',
  'ZERO_VARIANCE_PREDICTOR',
  'RANK_DEFICIENT',
  'SEPARATION_DETECTED',
  'SEPARATION_CHECK_FAILED',
  'NOT_CONVERGED',
  // PR4-A2 — categorical outcome 관측 레벨이 정확히 2개가 아님(공개통제 ③ 통과
  // 후에만 판정 — §2 ④ "categorical 2레벨 outcome").
  'CATEGORICAL_OUTCOME_NOT_BINARY',
  // PR4-A2 — spline predictor 고유값 수 < df+1(=5), 또는 내부 knot이 서로/경계
  // knot과 겹침(편중 분포). 적응형 축소 없이 거부(§2 "표준화·spline 기저").
  'SPLINE_INSUFFICIENT_UNIQUE_VALUES',
]);

export const RegressionInferenceWithheldReasonSchema = z.enum([
  'TOO_FEW_CLUSTERS',
  'CLUSTER_IMBALANCE',
  'COVARIANCE_NOT_COMPUTABLE',
  'DEGENERATE_COVARIANCE',
]);

// se===null은 오직 covariance 계산 자체가 불능(COVARIANCE_NOT_COMPUTABLE/
// DEGENERATE_COVARIANCE)일 때만 허용된다(아래 superRefine이 강제) — 그 외에는
// se가 유한하고 0보다 커야 한다(리뷰 #16/#19, se===0 완전적합을 허용하지 않는다).
export const RegressionTermSchema = z.object({
  name: z.string(),
  label: z.string(),
  variableKey: z.string().nullable(),
  level: z.string().nullable(),
  estimate: z.number(),
  se: z.number().nullable(),
  statistic: z.number().nullable(),
  pValue: z.number().nullable(),
  ciLower: z.number().nullable(),
  ciUpper: z.number().nullable(),
  // 로지스틱 전용(OR). estimate가 overflow 경계를 넘으면 null(계획 §3 "수치 안정성").
  exponentiated: z.object({
    estimate: z.number(),
    ciLower: z.number().nullable(),
    ciUpper: z.number().nullable(),
  }).nullable(),
  // PR4-A2 — spline 기저 항은 forest plot에서 묶어 빼고 부분효과 곡선으로 대체
  // 표시해야 한다(없으면 β_ns1..β_ns4가 해석 불가능한 채로 나열된다). interaction
  // 항은 interactionOf로 어느 두 predictor의 곱인지 알려준다.
  termType: z.enum(['main', 'interaction', 'spline_basis']).default('main'),
  interactionOf: z.tuple([z.string(), z.string()]).nullable().default(null),
}).strict();

// OLS는 r2/adjR2만, 로지스틱은 logLik/aic/pseudoR2만 채운다 — 모형 전체 검정
// (F·LR·Wald)은 A1에서 아예 내지 않는다(robust covariance와 정합하지 않고,
// 별도 추론이라 같은 차단 정책을 또 배선해야 한다 — 계획 §2 "⑥ 추론 공개 정책").
export const RegressionFitSchema = z.object({
  r2: z.number().nullable(),
  adjR2: z.number().nullable(),
  logLik: z.number().nullable(),
  aic: z.number().nullable(),
  pseudoR2: z.number().nullable(),
}).strict();

// PR4-A2 — 행 단위 진단(잔차·leverage·Cook's D). disclosureClass=limited_row라
// (계획서 §6.8.1) statsLimitedRowMerge.ts가 붙이기 전엔 배열 자체가 없다
// (scatter.points와 동일 원칙). pointDiagnosticsStatus==='available'일 때만 이
// 배열이 존재하고, 존재하면 아래 넷은 전부 non-null이다(모형 단위 판정을 이미
// 서버가 통과시켰으므로 — 행별 부분 결측은 v1에서 만들지 않는다).
export const RegressionPointDiagnosticSchema = z.object({
  rowIndex: z.number().int(),
  fittedValue: z.number().finite(),
  residual: z.number().finite(),
  leverage: z.number().finite(),
  standardizedResidual: z.number().finite(),
  cooksDistance: z.number().finite(),
  theoreticalQuantile: z.number().finite(),
}).strict();

// PR4-A2 — VIF/condition number(집계, 모든 사용자) + 행 단위 진단 게이트(limited_row).
// pointDiagnosticsSupported는 (X,y,β)만으로 직접 판정한다 — estimation/
// inferenceWithheldReason 문자열은 절대 참고하지 않는다(반례로 확인된 원칙, 계획서
// §3 "_evaluate_diagnostic_support"). pointDiagnosticsStatus는 권한·엔진호출까지
// 반영한 5단계 최종 표시 상태다.
export const RegressionDiagnosticsSchema = z.object({
  conditionNumber: z.number().finite().nullable(),
  vif: z.array(z.object({
    // interaction 항은 두 predictor에 걸쳐 있어 단일 variableKey가 없다
    // (RegressionTermSchema.interactionOf 참고) — null 허용.
    variableKey: z.string().nullable(),
    termName: z.string(),
    vif: z.number().finite().nullable(),
  })).nullable(),
  pointDiagnosticsSupported: z.boolean(),
  pointDiagnosticsUnsupportedReason: z.enum([
    'QR_DECOMPOSITION_FAILED', 'NEAR_SINGULAR_LEVERAGE', 'INVALID_DIAGNOSTIC_SCALE',
  ]).nullable(),
  pointDiagnosticsStatus: z.enum([
    'not_requested', 'unavailable_no_access', 'unavailable_model',
    'unavailable_computation_failed', 'available',
  ]),
  displayedPointCount: z.number().int().nullable(),
  totalPointCount: z.number().int().nullable(),
  pointDiagnostics: z.array(RegressionPointDiagnosticSchema).optional(),
}).strict();

// PR4-A2 — spline 부분효과: 기준점(그리드 최솟값) 대비 선형예측자 차이(§1 "delta"
// 방식, 계획서 §3 "spline 부분효과"). scale은 항상 linear_predictor — 로지스틱도
// 확률이 아니라 log-odds 대비값 + exponentiated(OR)만 제공한다(다른 predictor 값에
// 의존하는 절대 예측 확률은 "부분효과"라는 틀과 맞지 않는다).
export const RegressionSplinePartialEffectSchema = z.object({
  variableKey: z.string(),
  scale: z.enum(['linear_predictor']),
  points: z.array(z.object({
    x: z.number().finite(),
    deltaFromBaseline: z.number().finite().nullable(),
    ciLower: z.number().finite().nullable(),
    ciUpper: z.number().finite().nullable(),
    exponentiated: z.object({
      estimate: z.number().finite(),
      ciLower: z.number().finite().nullable(),
      ciUpper: z.number().finite().nullable(),
    }).nullable(),
  })),
}).strict();

const RegressionSuppressedSchema = z.object({
  suppressed: z.literal(true),
  // 공개통제 사유는 단 하나로 수렴한다(리뷰 §2 "③ 공개통제") — 레벨별/사유별
  // 세분화된 코드는 그 자체로 소수셀 정보가 된다.
  reasonCode: z.literal('MIN_COHORT_NOT_MET'),
}).strict();

const RegressionResultBodySchema = z.object({
  suppressed: z.literal(false),
  estimation: z.enum(['ok', 'inference_withheld', 'non_estimable']),
  method: z.enum(['ols_linear', 'binary_logistic']),
  outcomeKey: z.string(),
  eventLevel: z.string().nullable(),
  // 실제 적용된 기준 레벨(리뷰 #12) — recipe 지정값이 완전사례에 없어 폴백됐어도
  // 여기엔 항상 실제 사용값이 기록된다.
  referenceLevelsUsed: z.record(z.string(), z.string()),
  covariance: z.enum(['hc3', 'person_cluster_cr1']),
  // 리뷰 #5 — 분포와 자유도를 별도 필드로 분리(로지스틱+HC3는 normal, df=null).
  inferenceDistribution: z.enum(['t', 'normal']).nullable(),
  inferenceDf: z.number().nullable(),
  residualDf: z.number().int(),
  n: z.number().int(),
  personCount: z.number().int(),
  clusterCount: z.number().int().nullable(),
  maxClusterShare: z.number().nullable(),
  terms: z.array(RegressionTermSchema),
  fit: RegressionFitSchema.nullable(),
  nonEstimableReason: RegressionNonEstimableReasonSchema.nullable(),
  inferenceWithheldReason: RegressionInferenceWithheldReasonSchema.nullable(),
  // 사유별 분해는 내지 않는다(리뷰 #13) — 소수셀을 "기타"로 합쳐도 총계에서
  // 역산된다. 총 제외 건수만 공개.
  excludedRowCount: z.number().int().nonnegative(),
  qualityFlags: z.array(z.string()),
  // 리뷰 #7 — 행 단위 vs 개인 단위 해석 주의를 고정 문구로 싣는다.
  analysisUnitNote: z.string(),
  // PR4-A2 — estimation==='ok'|'inference_withheld'면 non-null(개별 집계값은
  // 계산 실패 시 null 허용), 'non_estimable'이면 null(아래 상태 불변식이 강제).
  diagnostics: RegressionDiagnosticsSchema.nullable(),
  standardizedPredictorKeys: z.array(z.string()),
  standardization: z.record(z.string(), z.object({ mean: z.number(), sd: z.number() })).nullable(),
  splinePartialEffects: z.array(RegressionSplinePartialEffectSchema).nullable(),
}).strict();

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isFinitePositive(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

// 상태 불변식(계획 §1 "상태 불변식" 표) — discriminatedUnion **바깥**에 붙인다.
// Zod 3에서 union 선택지 객체에 직접 .superRefine()을 붙이면 반환형이 ZodEffects가
// 되어 판별자를 읽지 못하고 스키마 생성 단계에서 터진다(리뷰 #15, 실행 재현됨).
function validateRegressionStateInvariants(
  result: z.infer<typeof RegressionSuppressedSchema> | z.infer<typeof RegressionResultBodySchema>,
  ctx: z.RefinementCtx,
): void {
  if (result.suppressed) return;

  if (result.estimation === 'non_estimable') {
    if (result.terms.length !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NON_ESTIMABLE_REQUIRES_EMPTY_TERMS', path: ['terms'] });
    }
    if (result.fit !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NON_ESTIMABLE_REQUIRES_NULL_FIT', path: ['fit'] });
    }
    if (result.nonEstimableReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NON_ESTIMABLE_REQUIRES_REASON', path: ['nonEstimableReason'] });
    }
    if (result.inferenceWithheldReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NON_ESTIMABLE_MUST_NOT_SET_INFERENCE_WITHHELD_REASON', path: ['inferenceWithheldReason'] });
    }
    // PR4-A2 — 계수 자체가 없으므로 진단·spline도 없다.
    if (result.diagnostics !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NON_ESTIMABLE_REQUIRES_NULL_DIAGNOSTICS', path: ['diagnostics'] });
    }
    if (result.splinePartialEffects !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NON_ESTIMABLE_REQUIRES_NULL_SPLINE_PARTIAL_EFFECTS', path: ['splinePartialEffects'] });
    }
    return;
  }

  // PR4-A2 — ok/inference_withheld는 β가 항상 존재하므로 diagnostics 객체 자체는
  // 항상 있다(개별 집계값의 계산 실패는 그 값만 null — 열별/항별 격리, 여기서는
  // 객체 존재만 강제한다). pointDiagnosticsSupported는 (X,y,β)로 직접 판정되며
  // estimation과 무관하다 — 그래서 이 자리에서 값 자체를 검사하지 않는다.
  if (result.diagnostics === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ESTIMATED_RESULT_REQUIRES_DIAGNOSTICS', path: ['diagnostics'] });
  }

  // PR4-A2 — inference_withheld(사유 불문)면 spline의 원 스케일 CI와 OR CI를 전부
  // null로 만든다(계수표의 nullifyInference와 동일 원칙 — estimate/exponentiated.
  // estimate는 유지, ciLower/ciUpper만 null). ok에서는 점별 실패 격리만 허용되고
  // 블록 전체를 강제로 null화하지 않는다.
  if (result.estimation === 'inference_withheld' && result.splinePartialEffects !== null) {
    result.splinePartialEffects.forEach((effect, effectIndex) => {
      effect.points.forEach((point, pointIndex) => {
        if (point.ciLower !== null || point.ciUpper !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'INFERENCE_WITHHELD_REQUIRES_NULL_SPLINE_CI',
            path: ['splinePartialEffects', effectIndex, 'points', pointIndex],
          });
        }
        if (point.exponentiated && (point.exponentiated.ciLower !== null || point.exponentiated.ciUpper !== null)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'INFERENCE_WITHHELD_REQUIRES_NULL_SPLINE_EXPONENTIATED_CI',
            path: ['splinePartialEffects', effectIndex, 'points', pointIndex, 'exponentiated'],
          });
        }
      });
    });
  }

  // ok | inference_withheld 공통 — 계수가 비어있으면 안 되고 fit은 항상 있다.
  if (result.terms.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ESTIMATED_RESULT_REQUIRES_NONEMPTY_TERMS', path: ['terms'] });
  }
  if (result.fit === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ESTIMATED_RESULT_REQUIRES_FIT', path: ['fit'] });
  }
  if (result.nonEstimableReason !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ESTIMATED_RESULT_MUST_NOT_SET_NON_ESTIMABLE_REASON', path: ['nonEstimableReason'] });
  }

  // se가 전부 null이어야 하는 경우는 covariance 계산 자체가 불능일 때뿐(리뷰 #17
  // 우선순위 — 클러스터 사유가 이 상태를 덮어쓰면 안 된다).
  const seMustBeNull = result.estimation === 'inference_withheld'
    && (result.inferenceWithheldReason === 'COVARIANCE_NOT_COMPUTABLE'
      || result.inferenceWithheldReason === 'DEGENERATE_COVARIANCE');

  result.terms.forEach((term, i) => {
    if (seMustBeNull) {
      if (term.se !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SE_MUST_BE_NULL_WHEN_COVARIANCE_NOT_COMPUTABLE', path: ['terms', i, 'se'] });
      }
    } else if (!isFinitePositive(term.se)) {
      // 리뷰 #16/#19 — se===0(완전적합)을 정상으로 통과시키지 않는다.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SE_MUST_BE_FINITE_AND_POSITIVE', path: ['terms', i, 'se'] });
    }

    if (result.estimation === 'ok') {
      if (!isFiniteNumber(term.pValue)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OK_REQUIRES_FINITE_PVALUE', path: ['terms', i, 'pValue'] });
      }
      if (!isFiniteNumber(term.statistic)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OK_REQUIRES_FINITE_STATISTIC', path: ['terms', i, 'statistic'] });
      }
      if (!isFiniteNumber(term.ciLower) || !isFiniteNumber(term.ciUpper)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OK_REQUIRES_FINITE_CI', path: ['terms', i, 'ciLower'] });
      }
    } else if (term.pValue !== null || term.ciLower !== null || term.ciUpper !== null || term.statistic !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INFERENCE_WITHHELD_REQUIRES_NULL_INFERENCE_FIELDS', path: ['terms', i] });
    }
  });

  if (result.estimation === 'inference_withheld' && result.inferenceWithheldReason === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INFERENCE_WITHHELD_REQUIRES_REASON', path: ['inferenceWithheldReason'] });
  }
  if (result.estimation === 'ok' && result.inferenceWithheldReason !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OK_MUST_NOT_SET_INFERENCE_WITHHELD_REASON', path: ['inferenceWithheldReason'] });
  }
}

export const AnalyzeRegressionResultSchema = z
  .discriminatedUnion('suppressed', [RegressionSuppressedSchema, RegressionResultBodySchema])
  .superRefine(validateRegressionStateInvariants);

export const AnalyzeResultSchema = z.object({
  continuous: z.array(AnalyzeContinuousResultSchema),
  discrete:   z.array(AnalyzeDiscreteResultSchema),
  // PR3-A — analysisMode==='bivariate'인 신규 실행 결과는 억제 여부와 무관하게
  // 항상 존재(계획서 §"결과 계약 불변조건"). optional인 이유는 구버전 저장 결과
  // (PR1/PR2가 만든, 이 필드 자체가 없는 stats_runs.result) 재파싱 호환뿐이다 —
  // "선택적 기능"이라는 뜻이 아니다.
  bivariate: AnalyzeBivariateResultSchema.optional(),
  // PR3-B — analysisMode==='correlation_matrix'인 신규 실행 결과는 위와 동일한
  // 원칙으로 항상 존재. optional인 이유도 동일(구버전 재파싱 호환뿐).
  correlationMatrix: AnalyzeCorrelationMatrixResultSchema.optional(),
  // PR4-A1 — analysisMode==='regression'인 신규 실행 결과도 동일 원칙(항상 존재,
  // optional은 구버전 재파싱 호환뿐). 리뷰 #14 — 이 필드를 빠뜨리면 클라이언트의
  // parseOrThrow가 zod strip으로 회귀 결과를 통째로 버린다.
  regression: AnalyzeRegressionResultSchema.optional(),
});

export const AnalyzeRequestSchema = StatsAnalysisRecipeSchema;

export const AnalyzeResponseSchema = z.object({
  runManifest: RunManifestSchema,
  result:      AnalyzeResultSchema,
});

// ============================================================================
// PR4-B1: 비동기 job 인프라. 계획서(pr4-b-virtual-pnueli.md) 11차 통합본 §계약 참고.
// ============================================================================

export const StatsRunErrorCodeSchema = z.enum([
  'TIMEOUT', 'PROCESS_ERROR', 'INVALID_OUTPUT', 'OUTPUT_TOO_LARGE', 'RESULT_SCHEMA_INVALID',
  // PR4-B1 신규 — claim 시점 13개 버전 상수 재계산 불일치 / queued 대기예산 초과.
  'EXECUTION_VERSION_DRIFTED', 'QUEUE_WAIT_EXCEEDED',
]);

// POST /analyze가 syncBudgetMs 안에 못 끝내면 202로 돌려주는 접수 응답. 합류(join)
// 시에는 이미 'running'일 수 있으므로 "queued만 허용"이 아니라 실제 현재 상태를
// 그대로 반영한다.
export const AnalyzeAcceptedResponseSchema = z.object({
  analysisRunId: z.string().uuid(),
  status: z.enum(['queued', 'running']),
});

// GET /api/stats/runs/:analysisRunId 응답.
export const RunStatusPendingSchema = z.object({
  analysisRunId: z.string().uuid(),
  status: z.enum(['queued', 'running']),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
});
export const RunStatusSucceededSchema = z.object({
  analysisRunId: z.string().uuid(),
  status: z.literal('succeeded'),
  runManifest: RunManifestSchema,
  result: AnalyzeResultSchema,
});
export const RunStatusFailedSchema = z.object({
  analysisRunId: z.string().uuid(),
  status: z.literal('failed'),
  errorCode: StatsRunErrorCodeSchema,
});
export const RunStatusCancelledSchema = z.object({
  analysisRunId: z.string().uuid(),
  status: z.literal('cancelled'),
  cancelledAt: z.string(),
});
export const RunStatusResponseSchema = z.union([
  RunStatusPendingSchema,
  RunStatusSucceededSchema,
  RunStatusFailedSchema,
  RunStatusCancelledSchema,
]);

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
export type AnalyzeHistogramBin           = z.infer<typeof AnalyzeHistogramBinSchema>;
export type AnalyzeHistogram              = z.infer<typeof AnalyzeHistogramSchema>;
export type AnalyzeBoxplot                = z.infer<typeof AnalyzeBoxplotSchema>;
export type AnalyzeCorrelationMatrixCell  = z.infer<typeof AnalyzeCorrelationMatrixCellSchema>;
export type AnalyzeCorrelationMatrixResult = z.infer<typeof AnalyzeCorrelationMatrixResultSchema>;
export type RegressionNonEstimableReason  = z.infer<typeof RegressionNonEstimableReasonSchema>;
export type RegressionInferenceWithheldReason = z.infer<typeof RegressionInferenceWithheldReasonSchema>;
export type RegressionTerm                = z.infer<typeof RegressionTermSchema>;
export type RegressionFit                 = z.infer<typeof RegressionFitSchema>;
export type RegressionPointDiagnostic     = z.infer<typeof RegressionPointDiagnosticSchema>;
export type RegressionDiagnostics         = z.infer<typeof RegressionDiagnosticsSchema>;
export type RegressionSplinePartialEffect = z.infer<typeof RegressionSplinePartialEffectSchema>;
export type AnalyzeRegressionResult       = z.infer<typeof AnalyzeRegressionResultSchema>;
export type AnalyzeResult                 = z.infer<typeof AnalyzeResultSchema>;
export type AnalyzeRequest                = z.infer<typeof AnalyzeRequestSchema>;
export type AnalyzeResponse               = z.infer<typeof AnalyzeResponseSchema>;
export type StatsRunErrorCode             = z.infer<typeof StatsRunErrorCodeSchema>;
export type AnalyzeAcceptedResponse       = z.infer<typeof AnalyzeAcceptedResponseSchema>;
export type RunStatusResponse             = z.infer<typeof RunStatusResponseSchema>;

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

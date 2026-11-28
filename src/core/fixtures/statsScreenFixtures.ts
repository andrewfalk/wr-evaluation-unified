// 통계 화면 특성화(P2-76a, Phase 2 C9 구간 B)의 입력 — 기존 통계 테스트(`statistics/__tests__/*`)가 쓰는 모양을 옮겨 적고,
// 빠진 필수 필드를 채워 `@wr/contracts` 스키마를 그대로 통과하게 만든 것이다(테스트가 `Schema.parse(x)`가 x와 같음을 단언한다).
// 서버 응답은 클라이언트가 스키마로 parse한 **뒤의** 값이 화면에 들어가므로, 기본값이 있는 필드(analysisRole·termType 등)도
// parse 결과와 같게 적는다. 변수 이름·담당의 이름은 합성 값이다.
// 기존 픽스처(`statsPreviewFixture.js`)는 고치지 않는다 — 새 사례는 이 파일에 더한다.
import type {
  AnalyzeResponse,
  AnalyzeResult,
  AvailableMethod,
  CatalogResponse,
  CatalogVariable,
  PredictionMetric,
  PreviewResponse,
  RunManifest,
  StatsAnalysisRecipe,
} from '@wr/contracts/stats';

type VariableSpec = Pick<CatalogVariable, 'key' | 'label' | 'type'> & Partial<CatalogVariable>;

function variable(spec: VariableSpec): CatalogVariable {
  return {
    group: '합성 그룹',
    moduleId: 'knee',
    grain: 'case',
    unit: null,
    provenance: 'derived',
    dependsOn: [],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: `family.${spec.key}`,
    supportedFormulaPolicies: ['recompute_current'],
    formulaVersionKey: null,
    analysisRole: 'analyzable',
    broadcastToGrains: [],
    predictionRole: null,
    predictionOutcomeLevels: null,
    predictionEventLevels: null,
    ...spec,
  };
}

export const KEY = {
  relatedness: 'knee.relatedness.max',
  vibration: 'spine.vibration.dvMax',
  age: 'case.patient.age',
  exceeded: 'shoulder.exposure.anyExceeded',
  grade: 'elbow.assessment.burdenGradeMax',
  sex: 'case.patient.sex',
  job: 'case.job.title',
  doctor: 'case.staff.assignedDoctorUserId',
  outcome: 'diagnosis.rollup.anyHighRelatedness',
  cumulative: 'spine.relatedness.cumulative',
  registeredAt: 'case.meta.registeredAt',
} as const;

export function statsCatalog(): CatalogResponse {
  return {
    catalogVersion: 'cv-synthetic-1',
    variables: [
      variable({
        key: KEY.relatedness, label: '신체부담기여도(최대)', type: 'continuous', unit: '%', group: '무릎 · 파생지표',
        allowedAnalysisPurposes: ['association', 'formula_audit', 'prediction'], predictionRole: 'predictor',
      }),
      variable({
        key: KEY.vibration, label: '전신진동 일일노출량', type: 'continuous', group: '척추', moduleId: 'spine',
        allowedAnalysisPurposes: ['association', 'formula_audit', 'prediction'], predictionRole: 'predictor',
      }),
      variable({
        key: KEY.age, label: '나이', type: 'continuous', unit: '세', group: '인적사항', moduleId: 'shared', provenance: 'raw',
        allowedAnalysisPurposes: ['association', 'prediction'], predictionRole: 'predictor', availableAt: 'pre_assessment',
      }),
      variable({
        key: KEY.exceeded, label: '노출 한도 초과 여부', type: 'boolean', group: '어깨', moduleId: 'shoulder',
      }),
      variable({
        key: KEY.grade, label: '팔꿈치 부담 등급', type: 'ordinal', group: '팔꿈치', moduleId: 'elbow',
      }),
      variable({
        key: KEY.sex, label: '성별', type: 'categorical', group: '인적사항', moduleId: 'shared', provenance: 'raw',
        allowedAnalysisPurposes: ['association', 'prediction'], predictionRole: 'predictor', availableAt: 'pre_assessment',
        broadcastToGrains: ['job', 'disease'],
      }),
      variable({
        key: KEY.job, label: '대표 직종명', type: 'high_cardinality', group: '직업력', moduleId: 'shared', provenance: 'raw',
        sensitivity: 'quasi_identifier',
      }),
      variable({
        key: KEY.doctor, label: '담당 의사', type: 'categorical', group: '진료', moduleId: 'shared', provenance: 'raw',
        sensitivity: 'staff_identifier',
      }),
      variable({
        key: KEY.outcome, label: '업무관련성 높음(하나라도)', type: 'boolean', group: '판정', moduleId: 'shared',
        provenance: 'clinician_judgment', availableAt: 'post_decision', allowedAnalysisPurposes: ['association', 'prediction'],
        predictionRole: 'outcome', predictionOutcomeLevels: ['true', 'false'], predictionEventLevels: ['true'],
      }),
      variable({
        key: KEY.cumulative, label: '누적 신체부담', type: 'continuous', group: '척추', moduleId: 'spine',
        formulaFamily: 'spine_cumulative', supportedFormulaPolicies: ['recompute_recorded_version', 'recompute_current'],
        formulaVersionKey: 'spine.formulaVersion',
      }),
      variable({
        key: KEY.registeredAt, label: '등록일', type: 'date', group: '진료', moduleId: 'shared', provenance: 'raw',
        analysisRole: 'filter_only', allowedAnalysisPurposes: ['association', 'formula_audit', 'prediction'],
        availableAt: 'pre_assessment',
      }),
    ],
    supportedGrains: ['case', 'job', 'disease'],
    unsupportedGrains: [],
    minimumCohort: 10,
  };
}

type AnalysisMode = NonNullable<RunManifest['analysisMode']>;

export function runManifest(analysisRunId: string, analysisMode: AnalysisMode): RunManifest {
  return {
    analysisRunId,
    snapshotAsOf: '2025-12-31T15:00:00.000Z',
    recipeDigest: 'recipe-digest',
    sourceDigest: 'source-digest',
    resultDigest: 'result-digest',
    catalogVersion: 'cv-synthetic-1',
    extractorVersion: 'ex1',
    migrationVersion: 'mv1',
    formulaPolicies: {},
    estimabilityPolicyVersion: 'ep1',
    engineVersion: 'engine-1',
    serializerVersion: 'sv1',
    inferenceGatePolicyVersion: 'v1-repeated-measures-gate',
    analysisMode,
  };
}

/** parse 뒤 모양(기본값이 채워진 것)의 레시피. */
export function recipe(overrides: Partial<StatsAnalysisRecipe> & Pick<StatsAnalysisRecipe, 'variableKeys'>): StatsAnalysisRecipe {
  return {
    grain: 'case',
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

function emptyResult(): AnalyzeResult {
  return { continuous: [], discrete: [] };
}

const lv = (level: string | boolean, count: number, total: number) => ({ level, count, proportion: count / total });

// ---- ResultPanel 사례 ----

export interface ResultCase {
  name: string;
  recipe: StatsAnalysisRecipe;
  response: AnalyzeResponse;
}

const RUN = {
  descriptive: '10000000-0000-4000-8000-000000000001',
  distribution: '10000000-0000-4000-8000-000000000002',
  stratified: '10000000-0000-4000-8000-000000000003',
  group: '10000000-0000-4000-8000-000000000004',
  contingency: '10000000-0000-4000-8000-000000000005',
  correlation: '10000000-0000-4000-8000-000000000006',
  matrix: '10000000-0000-4000-8000-000000000007',
  regression: '10000000-0000-4000-8000-000000000008',
  prediction: '10000000-0000-4000-8000-000000000009',
  suppressed: '10000000-0000-4000-8000-000000000010',
} as const;

function descriptiveCase(): ResultCase {
  return {
    name: '연속·범주 기술통계(병합 "기타", 억제 행, 단독 분석 안내)',
    recipe: recipe({ variableKeys: [KEY.relatedness, KEY.vibration, KEY.job, KEY.grade] }),
    response: {
      runManifest: runManifest(RUN.descriptive, 'descriptive'),
      result: {
        continuous: [
          {
            variableKey: KEY.relatedness, kind: 'continuous', suppressed: false, n: 76, missingCount: 4,
            missingPatterns: [{ reasonCode: 'not_entered', count: 3 }, { reasonCode: 'not_assessed', count: 1 }],
            mean: 42.123456, sd: 12.5, median: 41, q1: 33.25, q3: 50.75, iqr: 17.5, skewness: 0.31, kurtosis: -0.42,
            min: 10, max: 88, nullReasons: {},
            histogram: { bins: [
              { lower: 0, upper: 20, count: 10 }, { lower: 20, upper: 40, count: 24 }, { lower: 40, upper: 60, count: 30 },
              { lower: 60, upper: 100, count: 12, tailMerged: true },
            ], merged: true },
            histogramReasonCode: null,
            boxplot: { q1: 33.25, median: 41, q3: 50.75, lowerWhisker: 10, upperWhisker: 76, outlierCount: 2 },
          },
          { variableKey: KEY.vibration, kind: 'continuous', suppressed: true },
        ],
        discrete: [
          {
            variableKey: KEY.job, kind: 'discrete', suppressed: false, n: 76, missingCount: 0, missingPatterns: [],
            levels: [lv('용접공', 40, 76), lv('목수', 20, 76)], other: { count: 16, proportion: 16 / 76 }, mode: '용접공',
          },
          { variableKey: KEY.grade, kind: 'discrete', suppressed: true },
        ],
      },
    },
  };
}

function distributionCase(): ResultCase {
  return {
    name: '분포 변형(히스토그램 해상도 부족·권한자 원본 히스토그램·원본 범주·상수 변수)',
    recipe: recipe({ variableKeys: [KEY.age, KEY.vibration, KEY.job] }),
    response: {
      runManifest: runManifest(RUN.distribution, 'descriptive'),
      result: {
        continuous: [
          {
            variableKey: KEY.age, kind: 'continuous', suppressed: false, n: 30, missingCount: 0, missingPatterns: null,
            mean: 45, sd: 0, median: 45, q1: 45, q3: 45, iqr: 0, skewness: null, kurtosis: null, min: 45, max: 45,
            nullReasons: { skewness: 'undefined_zero_variance', kurtosis: 'undefined_zero_variance' },
            histogram: null, histogramReasonCode: 'INSUFFICIENT_DISCLOSABLE_RESOLUTION', boxplot: null,
          },
          {
            variableKey: KEY.vibration, kind: 'continuous', suppressed: false, n: 40, missingCount: 2, missingPatterns: null,
            mean: 0.52, sd: 0.21, median: 0.5, q1: 0.35, q3: 0.66, iqr: 0.31, skewness: 0.1, kurtosis: 0.2, min: 0.1, max: 1.2,
            nullReasons: {},
            histogram: { bins: [{ lower: 0, upper: 0.6, count: 22 }, { lower: 0.6, upper: 1.2, count: 18 }] },
            rawHistogram: { bins: [
              { lower: 0, upper: 0.3, count: 9 }, { lower: 0.3, upper: 0.6, count: 13 },
              { lower: 0.6, upper: 0.9, count: 15 }, { lower: 0.9, upper: 1.2, count: 3 },
            ] },
            boxplot: { q1: 0.35, median: 0.5, q3: 0.66, lowerWhisker: 0.1, upperWhisker: 1.0, outlierCount: 1, outlierValues: [1.2] },
          },
        ],
        discrete: [
          {
            variableKey: KEY.job, kind: 'discrete', suppressed: false, n: 76, missingCount: 0, missingPatterns: [],
            levels: [lv('용접공', 40, 76), lv('목수', 20, 76)], other: { count: 16, proportion: 16 / 76 }, mode: '용접공',
            rawLevels: [lv('용접공', 40, 76), lv('목수', 20, 76), lv('간호사', 12, 76), lv('잠수부', 1, 76), lv('조종사', 3, 76)],
          },
        ],
      },
    },
  };
}

function stratifiedCase(): ResultCase {
  return {
    name: '층화 표(Table 1 — 그룹 비공개·결측 그룹·기타 그룹·표시명 중복)',
    recipe: recipe({ variableKeys: [KEY.age, KEY.sex], descriptive: { stratifyByKey: KEY.doctor } }),
    response: {
      runManifest: runManifest(RUN.stratified, 'descriptive'),
      result: {
        continuous: [], discrete: [],
        descriptiveStratified: {
          suppressed: false,
          stratifyByKey: KEY.doctor,
          groups: [
            { groupId: 'total', kind: 'total', level: null },
            { groupId: 'g0', kind: 'level', level: '합성 의사 가' },
            { groupId: 'g1', kind: 'level', level: '합성 의사 나' },
            { groupId: 'g2', kind: 'level', level: '합성 의사 나' },
            { groupId: 'other', kind: 'other', level: null },
            { groupId: 'missing', kind: 'missing', level: null },
          ],
          byGroup: [
            {
              groupId: 'total',
              continuous: [{ variableKey: KEY.age, kind: 'continuous', suppressed: true }],
              discrete: [{ variableKey: KEY.sex, kind: 'discrete', suppressed: true }],
            },
            {
              groupId: 'g0',
              continuous: [{ variableKey: KEY.age, kind: 'continuous', suppressed: false, n: 15, missingCount: 1, mean: 44.25, sd: 9.5, median: 45, q1: 38, q3: 51, iqr: 13, min: 25, max: 63 }],
              discrete: [{ variableKey: KEY.sex, kind: 'discrete', suppressed: false, n: 15, missingCount: 0, levels: [lv('M', 15, 15)], mode: 'M' }],
            },
            {
              groupId: 'g1',
              continuous: [{ variableKey: KEY.age, kind: 'continuous', suppressed: false, n: 12, missingCount: 0, mean: 50, sd: null, median: 50, q1: 47, q3: 53, iqr: 6, min: 41, max: 60 }],
              discrete: [{ variableKey: KEY.sex, kind: 'discrete', suppressed: false, n: 12, missingCount: 0, levels: [lv('F', 12, 12)], mode: 'F' }],
            },
            {
              groupId: 'g2',
              continuous: [{ variableKey: KEY.age, kind: 'continuous', suppressed: true }],
              discrete: [{ variableKey: KEY.sex, kind: 'discrete', suppressed: false, n: 0, missingCount: 11, levels: [], mode: null }],
            },
            {
              groupId: 'other',
              continuous: [{ variableKey: KEY.age, kind: 'continuous', suppressed: false, n: 10, missingCount: 0, mean: 39.5, sd: 8, median: 40, q1: 33, q3: 46, iqr: 13, min: 28, max: 55 }],
              discrete: [{ variableKey: KEY.sex, kind: 'discrete', suppressed: false, n: 10, missingCount: 0, levels: [lv('M', 6, 10), lv('F', 4, 10)], mode: 'M' }],
            },
            {
              groupId: 'missing',
              continuous: [{ variableKey: KEY.age, kind: 'continuous', suppressed: true }],
              discrete: [{ variableKey: KEY.sex, kind: 'discrete', suppressed: true }],
            },
          ],
        },
      },
    },
  };
}

function groupComparisonCase(): ResultCase {
  return {
    name: '그룹 비교(welch_t — 방향 설명·박스플롯·제외 사례·품질 표시 없음)',
    recipe: recipe({ analysisMode: 'bivariate', variableKeys: [KEY.relatedness, KEY.exceeded], requestedMethod: 'welch_t' }),
    response: {
      runManifest: runManifest(RUN.group, 'bivariate'),
      result: {
        ...emptyResult(),
        bivariate: {
          method: 'welch_t', suppressed: false, n: 60, statistic: 2.1, df: 57.3, pValue: 0.04,
          effectSizes: [
            { name: 'mean_difference', value: 1.5, ci: [0.1, 2.9], ciUnavailableReason: null },
            { name: 'hedges_g', value: 0.54, ci: null, ciUnavailableReason: 'not_supported_v1' },
          ],
          nullReasons: {}, multipleTesting: { method: 'none', adjustedP: null }, qualityFlags: [], extra: {},
          excludedCaseCount: 5, exclusions: [{ reasonCode: 'x_missing', count: 3 }, { reasonCode: 'both_missing', count: 2 }],
          groupBreakdown: [
            { label: false, n: 30, boxplot: { q1: 30, median: 38, q3: 45, lowerWhisker: 12, upperWhisker: 60 } },
            { label: true, n: 30, boxplot: { q1: 35, median: 41, q3: 52, lowerWhisker: 20, upperWhisker: 70, outlierCount: 1 } },
          ],
        },
      },
    },
  };
}

function anovaCase(): ResultCase {
  return {
    name: '그룹 비교(anova — 3그룹 η², 방향 설명 없음)',
    recipe: recipe({ analysisMode: 'bivariate', variableKeys: [KEY.grade, KEY.relatedness], requestedMethod: 'anova' }),
    response: {
      runManifest: runManifest(RUN.group, 'bivariate'),
      result: {
        ...emptyResult(),
        bivariate: {
          method: 'anova', suppressed: false, n: 90, statistic: 5.4, df: { numerator: 2, denominator: 40.2 }, pValue: 0.0062,
          effectSizes: [{ name: 'eta_squared', value: 0.3, ci: null, ciUnavailableReason: 'not_supported_v1' }],
          nullReasons: {}, multipleTesting: { method: 'none', adjustedP: null }, qualityFlags: [], extra: {},
          excludedCaseCount: 0, exclusions: null,
          groupBreakdown: [{ label: '경도', n: 30 }, { label: '중등도', n: 30 }, { label: '고도', n: 30 }],
        },
      },
    },
  };
}

function contingencyCase(): ResultCase {
  return {
    name: '분할표(chi_square — 기대빈도 낮음 표시·Cramér V)',
    recipe: recipe({ analysisMode: 'bivariate', variableKeys: [KEY.exceeded, KEY.sex], requestedMethod: 'chi_square' }),
    response: {
      runManifest: runManifest(RUN.contingency, 'bivariate'),
      result: {
        ...emptyResult(),
        bivariate: {
          method: 'chi_square', suppressed: false, n: 100, statistic: 4.2, df: 1, pValue: 0.0404,
          effectSizes: [], nullReasons: {}, multipleTesting: { method: 'none', adjustedP: null },
          qualityFlags: ['low_expected_count'],
          extra: { cramersV: { name: 'cramers_v', value: 0.2, ci: null, ciUnavailableReason: 'not_supported_v1' } },
          excludedCaseCount: 0, exclusions: [],
          contingencyTable: { rowLabels: [false, true], colLabels: ['M', 'F'], cells: [[20, 30], [15, 35]] },
        },
      },
    },
  };
}

function correlationCase(): ResultCase {
  return {
    name: '상관(pearson — 산점도 점·회귀선)',
    recipe: recipe({ analysisMode: 'bivariate', variableKeys: [KEY.relatedness, KEY.vibration], requestedMethod: 'pearson_correlation' }),
    response: {
      runManifest: runManifest(RUN.correlation, 'bivariate'),
      result: {
        ...emptyResult(),
        bivariate: {
          method: 'pearson_correlation', suppressed: false, n: 48, statistic: 3.1, df: 46, pValue: 0.0033,
          effectSizes: [{ name: 'r', value: 0.42, ci: [0.16, 0.63], ciUnavailableReason: null }],
          nullReasons: {}, multipleTesting: { method: 'none', adjustedP: null }, qualityFlags: [], extra: {},
          excludedCaseCount: 2, exclusions: [{ reasonCode: 'y_missing', count: 2 }],
          regressionLine: { slope: 0.8, intercept: 5.5 },
          scatter: { displayedCount: 4, totalCount: 48, points: [[10, 12], [20, 25], [30, 27], [40, 41]] },
        },
      },
    },
  };
}

function correlationMatrixCase(): ResultCase {
  return {
    name: '상관행렬(spearman — 억제 칸·보정값 비공개)',
    recipe: recipe({ analysisMode: 'correlation_matrix', variableKeys: [KEY.relatedness, KEY.vibration, KEY.age], requestedMethod: 'spearman_correlation' }),
    response: {
      runManifest: runManifest(RUN.matrix, 'correlation_matrix'),
      result: {
        ...emptyResult(),
        correlationMatrix: {
          method: 'spearman_correlation',
          variableKeys: [KEY.relatedness, KEY.vibration, KEY.age],
          cells: [
            { suppressed: false, xKey: KEY.relatedness, yKey: KEY.vibration, n: 50, r: 0.4, pValue: 0.004, adjustedP: null },
            { suppressed: true, xKey: KEY.relatedness, yKey: KEY.age, reasonCode: 'REPEATED_MEASURES_NOT_ALIGNED' },
            { suppressed: true, xKey: KEY.vibration, yKey: KEY.age },
          ],
          adjustedPWithheld: true,
        },
      },
    },
  };
}

function regressionOkCase(): ResultCase {
  return {
    name: '회귀(ols_linear ok — 범주 항·상호작용·VIF·표준화)',
    recipe: recipe({
      analysisMode: 'regression', variableKeys: [KEY.relatedness, KEY.age, KEY.sex], requestedMethod: 'ols_linear',
      regression: { outcomeKey: KEY.relatedness, referenceLevels: {}, standardizePredictors: true, interactionTerms: [[KEY.age, KEY.sex]], splineKeys: [] },
    }),
    response: {
      runManifest: runManifest(RUN.regression, 'regression'),
      result: {
        ...emptyResult(),
        regression: {
          suppressed: false, estimation: 'ok', method: 'ols_linear', outcomeKey: KEY.relatedness, eventLevel: null,
          referenceLevelsUsed: { [KEY.sex]: 'F' }, covariance: 'hc3', inferenceDistribution: 't', inferenceDf: 36,
          residualDf: 36, n: 40, personCount: 40, clusterCount: null, maxClusterShare: null,
          terms: [
            { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: 1.0, se: 0.2, statistic: 5, pValue: 0.0001, ciLower: 0.6, ciUpper: 1.4, exponentiated: null, termType: 'main', interactionOf: null },
            { name: KEY.age, label: '나이', variableKey: KEY.age, level: null, estimate: 0.31, se: 0.1, statistic: 3.1, pValue: 0.0037, ciLower: 0.11, ciUpper: 0.51, exponentiated: null, termType: 'main', interactionOf: null },
            { name: `${KEY.sex}:M`, label: '성별: M', variableKey: KEY.sex, level: 'M', estimate: -0.09309751621743677, se: 0.3, statistic: -0.31, pValue: 1.4422231634147625e-20, ciLower: -0.7, ciUpper: 0.52, exponentiated: null, termType: 'main', interactionOf: null },
            { name: `${KEY.age}:${KEY.sex}:M`, label: '나이 × 성별: M', variableKey: null, level: null, estimate: 0.05, se: 0.04, statistic: 1.25, pValue: 0.22, ciLower: -0.03, ciUpper: 0.13, exponentiated: null, termType: 'interaction', interactionOf: [KEY.age, KEY.sex] },
          ],
          fit: { r2: 0.4, adjR2: 0.35, logLik: null, aic: null, pseudoR2: null },
          nonEstimableReason: null, inferenceWithheldReason: null, excludedRowCount: 3, qualityFlags: [],
          analysisUnitNote: '사례(case) 단위 — 같은 사람의 사례가 여러 개면 독립이 아닐 수 있습니다.',
          diagnostics: {
            conditionNumber: 12.3,
            vif: [{ variableKey: KEY.age, termName: KEY.age, vif: 1.5 }, { variableKey: KEY.sex, termName: `${KEY.sex}:M`, vif: 2.5 }],
            pointDiagnosticsSupported: true, pointDiagnosticsUnsupportedReason: null, pointDiagnosticsStatus: 'not_requested',
            displayedPointCount: null, totalPointCount: null,
          },
          standardizedPredictorKeys: [KEY.age],
          standardization: { [KEY.age]: { mean: 45.2, sd: 9.8 } },
          splinePartialEffects: null,
        },
      },
    },
  };
}

function regressionWithheldCase(): ResultCase {
  return {
    name: '회귀(binary_logistic inference_withheld — 군집 부족, 오즈비)',
    recipe: recipe({
      analysisMode: 'regression', variableKeys: [KEY.exceeded, KEY.relatedness], requestedMethod: 'binary_logistic',
      regression: { outcomeKey: KEY.exceeded, referenceLevels: {}, eventLevel: 'true', standardizePredictors: false, interactionTerms: [], splineKeys: [] },
    }),
    response: {
      runManifest: runManifest(RUN.regression, 'regression'),
      result: {
        ...emptyResult(),
        regression: {
          suppressed: false, estimation: 'inference_withheld', method: 'binary_logistic', outcomeKey: KEY.exceeded, eventLevel: 'true',
          referenceLevelsUsed: {}, covariance: 'person_cluster_cr1', inferenceDistribution: null, inferenceDf: null,
          residualDf: 78, n: 80, personCount: 15, clusterCount: 15, maxClusterShare: 0.1,
          terms: [
            { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: -1.0, se: 0.2, statistic: null, pValue: null, ciLower: null, ciUpper: null, exponentiated: { estimate: 0.3679, ciLower: null, ciUpper: null }, termType: 'main', interactionOf: null },
            { name: KEY.relatedness, label: '신체부담기여도(최대)', variableKey: KEY.relatedness, level: null, estimate: 0.05, se: 0.35, statistic: null, pValue: null, ciLower: null, ciUpper: null, exponentiated: { estimate: 1.0513, ciLower: null, ciUpper: null }, termType: 'main', interactionOf: null },
          ],
          fit: { r2: null, adjR2: null, logLik: -40.5, aic: 85, pseudoR2: 0.12 },
          nonEstimableReason: null, inferenceWithheldReason: 'TOO_FEW_CLUSTERS', excludedRowCount: 2, qualityFlags: [],
          analysisUnitNote: '사례(case) 단위',
          diagnostics: {
            conditionNumber: null, vif: null, pointDiagnosticsSupported: false,
            pointDiagnosticsUnsupportedReason: null, pointDiagnosticsStatus: 'unavailable_model',
            displayedPointCount: null, totalPointCount: null,
          },
          standardizedPredictorKeys: [], standardization: null, splinePartialEffects: null,
        },
      },
    },
  };
}

function regressionNonEstimableCase(): ResultCase {
  return {
    name: '회귀(non_estimable — 완전 분리)',
    recipe: recipe({
      analysisMode: 'regression', variableKeys: [KEY.exceeded, KEY.relatedness], requestedMethod: 'binary_logistic',
      regression: { outcomeKey: KEY.exceeded, referenceLevels: {}, standardizePredictors: false, interactionTerms: [], splineKeys: [] },
    }),
    response: {
      runManifest: runManifest(RUN.regression, 'regression'),
      result: {
        ...emptyResult(),
        regression: {
          suppressed: false, estimation: 'non_estimable', method: 'binary_logistic', outcomeKey: KEY.exceeded, eventLevel: null,
          referenceLevelsUsed: {}, covariance: 'hc3', inferenceDistribution: null, inferenceDf: null,
          residualDf: 0, n: 0, personCount: 0, clusterCount: null, maxClusterShare: null,
          terms: [], fit: null, nonEstimableReason: 'SEPARATION_DETECTED', inferenceWithheldReason: null,
          excludedRowCount: 0, qualityFlags: [], analysisUnitNote: '', diagnostics: null,
          standardizedPredictorKeys: [], standardization: null, splinePartialEffects: null,
        },
      },
    },
  };
}

function predictionOkCase(): ResultCase {
  const cv = { status: 'ok' as const, withheldReason: null, validRepeats: 5, totalRepeats: 5, mean: 0.69, min: 0.6, max: 0.75 };
  const bootstrap = { status: 'ok' as const, withheldReason: null, validReplicates: 200, totalReplicates: 200, optimism: 0.02, corrected: 0.67, correctedOutOfRange: false };
  const metric = (name: PredictionMetric['metric'], apparent: number, representativeRepeat: number): PredictionMetric => ({ metric: name, apparent, representativeRepeat, cv, bootstrap });
  return {
    name: '예측(l2_logistic ok — 지표·보정곡선·계수·주의 문구)',
    recipe: recipe({
      analysisMode: 'prediction', analysisPurpose: 'prediction', variableKeys: [KEY.outcome, KEY.relatedness, KEY.age],
      requestedMethod: 'l2_logistic', prediction: { outcomeKey: KEY.outcome, eventLevel: 'true' },
    }),
    response: {
      runManifest: runManifest(RUN.prediction, 'prediction'),
      result: {
        ...emptyResult(),
        prediction: {
          suppressed: false, estimation: 'ok', nonEstimableReason: null, method: 'l2_logistic',
          outcomeKey: KEY.outcome, eventLevel: 'true',
          n: 700, personCount: 700, eventPersonCount: 120, nonEventPersonCount: 580, prevalence: 0.171, excludedRowCount: 30,
          parameterCount: 3, columnCount: 3,
          validation: { scheme: 'grouped_cv', outerFolds: 5, repeats: 5, innerFolds: 5, outerFoldBasis: 'base_cohort', samplerVersion: 'sha256-rr-v1' },
          lambda: { selected: 0.01, gridMin: 0.0001, gridMax: 10, gridSize: 26 },
          qualityFlags: [], droppedColumnFoldCount: 0,
          metrics: [
            metric('roc_auc', 0.7, 0.68), metric('average_precision', 0.41, 0.39), metric('brier', 0.15, 0.16),
            metric('calibration_intercept', 0.05, 0.02), metric('calibration_slope', 1.0, 0.95),
          ],
          aucCi: { target: 'roc_auc_cv_mean', lower: 0.6, upper: 0.78, method: 'person_bootstrap_oof_conditional', replicates: 1000 },
          curves: {
            bins: [
              { upperThreshold: 0.2, rows: 300, positiveRows: 30, meanPredicted: 0.1, observedRate: 0.1 },
              { upperThreshold: 0.5, rows: 250, positiveRows: 50, meanPredicted: 0.3, observedRate: 0.2 },
              { upperThreshold: 1, rows: 150, positiveRows: 40, meanPredicted: 0.6, observedRate: 0.2667 },
            ],
            suppressedReason: null, representativeRepeat: 1, areaMayDifferFromAuc: true,
          },
          coefficients: {
            intercept: -1.2,
            terms: [
              { term: KEY.relatedness, variableKey: KEY.relatedness, level: null, standardizedBeta: 0.4 },
              { term: KEY.age, variableKey: KEY.age, level: null, standardizedBeta: -0.1 },
            ],
          },
          caveats: ['RESEARCH_INTERNAL_VALIDATION', 'NOT_FOR_DEPLOYMENT'],
          notPerformed: ['temporal_holdout', 'subgroup', 'external_validation'],
        },
      },
    },
  };
}

function predictionLimitedCase(): ResultCase {
  return {
    name: '예측(non_estimable + 제한공개 applied — 완전사례 기준 인원 표)',
    recipe: recipe({
      analysisMode: 'prediction', analysisPurpose: 'prediction', variableKeys: [KEY.outcome, KEY.relatedness],
      requestedMethod: 'l2_logistic', prediction: { outcomeKey: KEY.outcome, eventLevel: 'true' },
    }),
    response: {
      runManifest: runManifest(RUN.prediction, 'prediction'),
      result: {
        ...emptyResult(),
        limitedDisclosure: 'applied',
        prediction: {
          suppressed: false, estimation: 'non_estimable', nonEstimableReason: 'INSUFFICIENT_EVENT_PERSONS', method: 'l2_logistic',
          outcomeKey: KEY.outcome, eventLevel: 'true',
          n: 269, personCount: 269, eventPersonCount: 261, nonEventPersonCount: 8, prevalence: 0.97, excludedRowCount: 1232,
          parameterCount: null, columnCount: null,
          validation: { scheme: 'grouped_cv', outerFolds: 5, repeats: 5, innerFolds: 5, outerFoldBasis: 'base_cohort', samplerVersion: 'sha256-rr-v1' },
          lambda: { selected: null, gridMin: 0.0001, gridMax: 10, gridSize: 26 },
          qualityFlags: [], droppedColumnFoldCount: null,
          metrics: [], aucCi: null, curves: null, coefficients: null,
          caveats: ['RESEARCH_INTERNAL_VALIDATION'], notPerformed: ['temporal_holdout', 'subgroup', 'external_validation'],
        },
      },
    },
  };
}

function suppressedBivariateCase(): ResultCase {
  return {
    name: '억제(이변량 억제 + 제한공개 applied — 해제됐지만 계산 불가)',
    recipe: recipe({ analysisMode: 'bivariate', variableKeys: [KEY.relatedness, KEY.exceeded], requestedMethod: 'welch_t' }),
    response: {
      runManifest: runManifest(RUN.suppressed, 'bivariate'),
      result: { ...emptyResult(), limitedDisclosure: 'applied', bivariate: { method: 'welch_t', suppressed: true, unavailableReason: 'insufficient_group_data' } },
    },
  };
}

function suppressedRegressionCase(): ResultCase {
  return {
    name: '억제(회귀 최소 인원 미달 + 제한 해제 실패 안내)',
    recipe: recipe({
      analysisMode: 'regression', variableKeys: [KEY.relatedness, KEY.age], requestedMethod: 'ols_linear',
      regression: { outcomeKey: KEY.relatedness, referenceLevels: {}, standardizePredictors: false, interactionTerms: [], splineKeys: [] },
    }),
    response: {
      runManifest: runManifest(RUN.suppressed, 'regression'),
      result: { ...emptyResult(), limitedDisclosure: 'unavailable_engine_busy', regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' } },
    },
  };
}

function suppressedStratifiedCase(): ResultCase {
  return {
    name: '억제(층화 표 전체 억제 + 기술통계 제한공개 applied)',
    recipe: recipe({ variableKeys: [KEY.sex], descriptive: { stratifyByKey: KEY.doctor } }),
    response: {
      runManifest: runManifest(RUN.suppressed, 'descriptive'),
      result: {
        ...emptyResult(),
        limitedDisclosure: 'applied',
        descriptiveStratified: { suppressed: true, stratifyByKey: KEY.doctor, reasonCode: 'DIFFERENCING_RATE_LIMIT' },
      },
    },
  };
}

export function resultCases(): ResultCase[] {
  return [
    descriptiveCase(),
    distributionCase(),
    stratifiedCase(),
    groupComparisonCase(),
    anovaCase(),
    contingencyCase(),
    correlationCase(),
    correlationMatrixCase(),
    regressionOkCase(),
    regressionWithheldCase(),
    regressionNonEstimableCase(),
    predictionOkCase(),
    predictionLimitedCase(),
    suppressedBivariateCase(),
    suppressedRegressionCase(),
    suppressedStratifiedCase(),
  ];
}

// ---- 미리보기(RecipePanel·작업대) ----

export function availableMethod(id: AvailableMethod['id'], overrides: Partial<AvailableMethod> = {}): AvailableMethod {
  return {
    id, label: id, purpose: 'association', status: 'available', reasonCode: null,
    observed: { personCount: 20, rowCount: 20 }, required: null, remedy: null, remedyRecipePatch: null,
    methodPolicyVersion: 'v1-bivariate',
    ...overrides,
  };
}

export function previewResponse(
  analysisMode: AnalysisMode,
  availableMethods: AvailableMethod[] = [],
  overrides: Partial<PreviewResponse> = {},
): PreviewResponse {
  return {
    runManifest: runManifest('20000000-0000-4000-8000-000000000001', analysisMode),
    counts: { personCount: 20, caseCount: 24, observationCount: 24, suppressed: false, minimumCohort: 10, reasonCode: null },
    estimability: {
      completeCaseN: 20, missingRatesByVariable: { [KEY.relatedness]: 0.05 }, distinctAssignedDoctorClusters: 2,
      candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'ep1',
    },
    availableMethods,
    methodCatalogVersion: availableMethods.length > 0 ? 'v1-bivariate' : null,
    differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
    ...overrides,
  };
}

import { describe, it, expect } from 'vitest';
import {
  AnalyzePredictionResultSchema,
  StatsAnalysisRecipeSchema,
  AnalyzeResultSchema,
} from '../stats';
import type { PredictionMetric } from '../stats';

// PR4-B2 — 계획서(async-riding-hennessy.md 4차 통합본) §1단계 "불변식" 표를 그대로
// 테스트로 고정한다. 회귀(statsRegression.test.ts)와 같은 목적: discriminatedUnion
// 바깥에 붙인 superRefine이 스키마 생성 단계에서 죽지 않는지(모듈 import 자체가 그
// 회귀 테스트) + 불변식 하나하나가 실제로 거부/허용을 가르는지 확인한다.

const DEFAULT_CV = {
  status: 'ok' as const, withheldReason: null,
  validRepeats: 5, totalRepeats: 5, mean: 0.69, min: 0.6, max: 0.75,
};
const DEFAULT_BOOTSTRAP = {
  status: 'ok' as const, withheldReason: null,
  validReplicates: 200, totalReplicates: 200,
  optimism: 0.02, corrected: 0.67, correctedOutOfRange: false,
};

type MetricOverrides = Partial<{
  apparent: number | null;
  representativeRepeat: number | null;
  cv: PredictionMetric['cv'];
  bootstrap: PredictionMetric['bootstrap'];
}>;

function buildMetric(metric: string, overrides: MetricOverrides = {}) {
  return {
    metric,
    apparent: 0.7,
    representativeRepeat: 0.68,
    cv: DEFAULT_CV,
    bootstrap: DEFAULT_BOOTSTRAP,
    ...overrides,
  };
}

const okPredictionPayload = {
  suppressed: false as const,
  estimation: 'ok' as const,
  nonEstimableReason: null,
  method: 'l2_logistic' as const,
  outcomeKey: 'diagnosis.rollup.anyHighRelatedness',
  eventLevel: 'true',
  n: 700,
  personCount: 700,
  eventPersonCount: 120,
  nonEventPersonCount: 580,
  prevalence: 0.171,
  excludedRowCount: 30,
  parameterCount: 8,
  columnCount: 10,
  validation: {
    scheme: 'grouped_cv' as const, outerFolds: 5, repeats: 5, innerFolds: 5,
    outerFoldBasis: 'base_cohort' as const, samplerVersion: 'sha256-rr-v1',
  },
  lambda: { selected: 0.01, gridMin: 0.0001, gridMax: 10, gridSize: 26 },
  qualityFlags: [] as string[],
  droppedColumnFoldCount: 0,
  metrics: [
    buildMetric('roc_auc'),
    buildMetric('average_precision'),
    buildMetric('brier', { apparent: 0.15, representativeRepeat: 0.16 }),
    buildMetric('calibration_intercept', { apparent: 0.05, representativeRepeat: 0.02 }),
    buildMetric('calibration_slope', { apparent: 1.0, representativeRepeat: 0.95 }),
  ],
  aucCi: {
    target: 'roc_auc_cv_mean' as const, lower: 0.6, upper: 0.78,
    method: 'person_bootstrap_oof_conditional' as const, replicates: 1000,
  },
  curves: {
    bins: [{ upperThreshold: 0.5, rows: 100, positiveRows: 20, meanPredicted: 0.3, observedRate: 0.2 }],
    suppressedReason: null,
    representativeRepeat: 1 as const,
    areaMayDifferFromAuc: true as const,
  },
  coefficients: {
    intercept: -1.2,
    terms: [{ term: 'x1', variableKey: 'x1', level: null, standardizedBeta: 0.4 }],
  },
  caveats: ['RESEARCH_INTERNAL_VALIDATION', 'NOT_FOR_DEPLOYMENT'] as const,
  notPerformed: ['temporal_holdout', 'subgroup', 'external_validation'] as const,
};

const nonEstimablePredictionPayload = {
  suppressed: false as const,
  estimation: 'non_estimable' as const,
  nonEstimableReason: 'OUTCOME_NOT_OBSERVED' as const,
  method: 'l2_logistic' as const,
  outcomeKey: 'diagnosis.rollup.anyHighRelatedness',
  eventLevel: 'true',
  n: 0,
  personCount: 0,
  eventPersonCount: 0,
  nonEventPersonCount: 0,
  prevalence: null,
  excludedRowCount: 0,
  parameterCount: null,
  columnCount: null,
  validation: {
    scheme: 'grouped_cv' as const, outerFolds: 5, repeats: 5, innerFolds: 5,
    outerFoldBasis: 'base_cohort' as const, samplerVersion: 'sha256-rr-v1',
  },
  lambda: { selected: null, gridMin: 0.0001, gridMax: 10, gridSize: 26 },
  qualityFlags: [] as string[],
  droppedColumnFoldCount: null,
  metrics: [] as unknown[],
  aucCi: null,
  curves: null,
  coefficients: null,
  caveats: ['RESEARCH_INTERNAL_VALIDATION'] as const,
  notPerformed: ['temporal_holdout', 'subgroup', 'external_validation'] as const,
};

describe('AnalyzePredictionResultSchema — 스키마 생성 smoke', () => {
  it('모듈 import·스키마 생성이 던지지 않는다', () => {
    expect(AnalyzePredictionResultSchema).toBeDefined();
  });
});

describe('AnalyzePredictionResultSchema — suppressed 상태', () => {
  it('suppressed:true + MIN_COHORT_NOT_MET을 허용한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(r.success).toBe(true);
  });

  it('suppressed:true에 다른 필드가 섞이면 거부한다(strict)', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET', n: 10 });
    expect(r.success).toBe(false);
  });
});

describe('AnalyzePredictionResultSchema — estimation:"ok"', () => {
  it('정상 payload(5개 지표 전부·곡선·계수)를 허용한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse(okPredictionPayload);
    expect(r.success).toBe(true);
  });

  it('roc_auc 지표가 없으면 거부한다(OK_REQUIRES_ROC_AUC_METRIC)', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: okPredictionPayload.metrics.filter((m) => m.metric !== 'roc_auc'),
    });
    expect(r.success).toBe(false);
  });

  it('curves가 null이면 거부한다(ok는 항상 곡선 객체를 낸다)', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...okPredictionPayload, curves: null });
    expect(r.success).toBe(false);
  });

  it('coefficients가 null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...okPredictionPayload, coefficients: null });
    expect(r.success).toBe(false);
  });

  it('lambda.selected가 null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      lambda: { ...okPredictionPayload.lambda, selected: null },
    });
    expect(r.success).toBe(false);
  });

  it('parameterCount/columnCount/droppedColumnFoldCount가 null이면 거부한다', () => {
    for (const field of ['parameterCount', 'columnCount', 'droppedColumnFoldCount'] as const) {
      const r = AnalyzePredictionResultSchema.safeParse({ ...okPredictionPayload, [field]: null });
      expect(r.success, `${field}=null이어도 통과함`).toBe(false);
    }
  });

  it('ok인데 nonEstimableReason이 세팅돼 있으면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...okPredictionPayload, nonEstimableReason: 'NOT_CONVERGED' });
    expect(r.success).toBe(false);
  });

  it('roc_auc가 아닌 지표(average_precision)는 cv가 보류돼도 전체는 통과한다(3차 리뷰 #3-6)', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        buildMetric('roc_auc'),
        buildMetric('average_precision', {
          cv: {
            status: 'withheld' as const, withheldReason: 'LOW_VALID_REPEATS' as const,
            validRepeats: 2, totalRepeats: 5, mean: null, min: null, max: null,
          },
        }),
        buildMetric('brier'),
        buildMetric('calibration_intercept'),
        buildMetric('calibration_slope'),
      ],
    });
    expect(r.success).toBe(true);
  });

  it('roc_auc의 cv.status가 withheld면 거부한다(ok는 대표지표 cv가 항상 ok)', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        buildMetric('roc_auc', {
          cv: {
            status: 'withheld' as const, withheldReason: 'LOW_VALID_REPEATS' as const,
            validRepeats: 2, totalRepeats: 5, mean: null, min: null, max: null,
          },
        }),
        ...okPredictionPayload.metrics.slice(1),
      ],
    });
    expect(r.success).toBe(false);
  });

  it('cv.status==="ok"인데 mean/min/max가 null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        buildMetric('roc_auc'),
        buildMetric('average_precision', { cv: { ...DEFAULT_CV, mean: null } }),
        buildMetric('brier'),
        buildMetric('calibration_intercept'),
        buildMetric('calibration_slope'),
      ],
    });
    expect(r.success).toBe(false);
  });

  it('bootstrap.status==="withheld"인데 optimism/corrected가 non-null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        buildMetric('roc_auc'),
        buildMetric('average_precision', {
          bootstrap: {
            status: 'withheld' as const, withheldReason: 'APPARENT_UNAVAILABLE' as const,
            validReplicates: 0, totalReplicates: 200, optimism: 0.01, corrected: 0.5, correctedOutOfRange: false,
          },
        }),
        buildMetric('brier'),
        buildMetric('calibration_intercept'),
        buildMetric('calibration_slope'),
      ],
    });
    expect(r.success).toBe(false);
  });

  it('bounded 지표(roc_auc)의 corrected가 범위를 벗어났는데 correctedOutOfRange:false면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        buildMetric('roc_auc', {
          bootstrap: { ...DEFAULT_BOOTSTRAP, corrected: 1.05, correctedOutOfRange: false },
        }),
        ...okPredictionPayload.metrics.slice(1),
      ],
    });
    expect(r.success).toBe(false);
  });

  it('bounded 지표의 corrected가 범위를 벗어나고 correctedOutOfRange:true면 허용한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        buildMetric('roc_auc', {
          bootstrap: { ...DEFAULT_BOOTSTRAP, corrected: 1.05, correctedOutOfRange: true },
        }),
        ...okPredictionPayload.metrics.slice(1),
      ],
    });
    expect(r.success).toBe(true);
  });

  it('unbounded 지표(calibration_slope)는 correctedOutOfRange:true를 절대 허용하지 않는다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        ...okPredictionPayload.metrics.slice(0, 4),
        buildMetric('calibration_slope', {
          apparent: 1.0, representativeRepeat: 0.95,
          bootstrap: { ...DEFAULT_BOOTSTRAP, corrected: 5.0, correctedOutOfRange: true },
        }),
      ],
    });
    expect(r.success).toBe(false);
  });

  it('bounded 지표의 apparent가 [0,1]을 벗어나면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      metrics: [
        buildMetric('roc_auc', { apparent: 1.5 }),
        ...okPredictionPayload.metrics.slice(1),
      ],
    });
    expect(r.success).toBe(false);
  });

  it('aucCi.lower가 upper보다 크면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...okPredictionPayload,
      aucCi: { ...okPredictionPayload.aucCi, lower: 0.9, upper: 0.5 },
    });
    expect(r.success).toBe(false);
  });

  it('personCount>0인데 prevalence가 null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...okPredictionPayload, prevalence: null });
    expect(r.success).toBe(false);
  });
});

describe('AnalyzePredictionResultSchema — estimation:"non_estimable"', () => {
  it('metrics:[] + curves/coefficients/aucCi:null + lambda.selected:null을 허용한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse(nonEstimablePredictionPayload);
    expect(r.success).toBe(true);
  });

  it.each([
    'OUTCOME_NOT_OBSERVED', 'EVENT_LEVEL_NOT_OBSERVED', 'NON_EVENT_LEVEL_NOT_OBSERVED',
    'INSUFFICIENT_PERSONS', 'INSUFFICIENT_EVENT_PERSONS', 'ZERO_VARIANCE_PREDICTOR',
    'TOO_MANY_LEVELS', 'TOO_MANY_COLUMNS', 'TOO_MANY_PARAMETERS',
    'INSUFFICIENT_EVENTS_PER_PARAMETER', 'FOLD_CLASS_MISSING', 'NOT_CONVERGED',
  ] as const)('3-4단계 순서표의 모든 사유(%s)를 허용한다', (reason) => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...nonEstimablePredictionPayload, nonEstimableReason: reason });
    expect(r.success).toBe(true);
  });

  it('nonEstimableReason이 없으면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...nonEstimablePredictionPayload, nonEstimableReason: null });
    expect(r.success).toBe(false);
  });

  it('metrics가 비어있지 않으면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...nonEstimablePredictionPayload,
      metrics: [buildMetric('roc_auc')],
    });
    expect(r.success).toBe(false);
  });

  it('curves가 non-null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...nonEstimablePredictionPayload, curves: okPredictionPayload.curves });
    expect(r.success).toBe(false);
  });

  it('coefficients가 non-null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...nonEstimablePredictionPayload,
      coefficients: okPredictionPayload.coefficients,
    });
    expect(r.success).toBe(false);
  });

  it('lambda.selected가 non-null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({
      ...nonEstimablePredictionPayload,
      lambda: { ...nonEstimablePredictionPayload.lambda, selected: 0.01 },
    });
    expect(r.success).toBe(false);
  });

  it('personCount:0인데 prevalence가 non-null이면 거부한다', () => {
    const r = AnalyzePredictionResultSchema.safeParse({ ...nonEstimablePredictionPayload, prevalence: 0.1 });
    expect(r.success).toBe(false);
  });
});

describe('AnalyzeResultSchema — prediction 필드 연결', () => {
  it('prediction 필드가 있으면 그대로 보존된다(zod strip으로 사라지지 않음)', () => {
    const r = AnalyzeResultSchema.safeParse({
      continuous: [],
      discrete: [],
      prediction: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prediction).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    }
  });

  it('prediction 필드가 없어도(구버전 재파싱) 통과한다', () => {
    const r = AnalyzeResultSchema.safeParse({ continuous: [], discrete: [] });
    expect(r.success).toBe(true);
  });
});

describe('StatsAnalysisRecipeSchema — analysisMode:"prediction"', () => {
  const baseRecipe = {
    grain: 'case' as const,
    variableKeys: ['age', 'outcomeVar'],
    analysisPurpose: 'prediction' as const,
    analysisMode: 'prediction' as const,
    prediction: { outcomeKey: 'outcomeVar', eventLevel: 'true' },
  };

  it('정상 prediction 레시피를 허용한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse(baseRecipe);
    expect(r.success).toBe(true);
  });

  it('prediction 객체가 없으면 거부한다(PREDICTION_REQUIRES_PREDICTION_OBJECT)', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({ ...baseRecipe, prediction: undefined });
    expect(r.success).toBe(false);
  });

  it('outcomeKey가 variableKeys에 없으면 거부한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      ...baseRecipe,
      prediction: { outcomeKey: 'notInList', eventLevel: 'true' },
    });
    expect(r.success).toBe(false);
  });

  it('variableKeys가 2개 미만이면 거부한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({ ...baseRecipe, variableKeys: ['outcomeVar'] });
    expect(r.success).toBe(false);
  });

  it('중복 변수가 있으면 거부한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({ ...baseRecipe, variableKeys: ['outcomeVar', 'outcomeVar'] });
    expect(r.success).toBe(false);
  });

  it('eventLevel 없이는 prediction 객체 자체가 거부된다(필수 필드)', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      ...baseRecipe,
      prediction: { outcomeKey: 'outcomeVar' },
    });
    expect(r.success).toBe(false);
  });

  it('analysisMode:"prediction" + analysisPurpose:"association"이면 거부한다(PURPOSE_MODE_MISMATCH)', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({ ...baseRecipe, analysisPurpose: 'association' as const });
    expect(r.success).toBe(false);
  });

  it('analysisMode:"descriptive" + analysisPurpose:"prediction"이면 거부한다(PURPOSE_MODE_MISMATCH 역방향)', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      grain: 'case' as const,
      variableKeys: ['age'],
      analysisPurpose: 'prediction' as const,
      analysisMode: 'descriptive' as const,
    });
    expect(r.success).toBe(false);
  });

  it('l2_logistic이 StatsMethodIdSchema에 있다(requestedMethod로 명시 가능)', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({ ...baseRecipe, requestedMethod: 'l2_logistic' });
    expect(r.success).toBe(true);
  });
});

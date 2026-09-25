// PR4-B2 — 예측 ③비추정 판정(이미 ctx.predictionState.nonEstimableCheck에 계산돼
// 있음) → ④엔진 실행 → 곡선 공개통제 → 결과 조립(계획서 §5단계 "엔진 → 곡선
// 공개통제 → 조립"). ②(공개통제)를 통과하지 못한 요청은 이 함수 자체가
// 호출되지 않는다(statsAnalyzeHandler.ts가 먼저 차단 — 회귀와 동일 원칙).
import type {
  AnalyzePredictionResult, PredictionCaveat, PredictionCoefficients, PredictionMetric,
} from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import {
  runPredictionStatsEngine,
  buildPredictionEngineRequest,
  type EngineRunOpts,
  type PredictionEngineRequest,
  type StatsEnginePredictionMetric,
} from './statsEngine';
import { PREDICTION_POLICY } from './statsPolicy';
import { stringifyOutcomeValue } from './statsPredictionCohort';
import type { PredictionDesignMatrix } from './statsPredictionDesign';
import { computePredictionCurves, type PredictionCurveRow } from './statsPredictionDisclosure';

const METRIC_NAMES = ['roc_auc', 'average_precision', 'brier', 'calibration_intercept', 'calibration_slope'] as const;
const BOUNDED_METRICS = new Set<string>(['roc_auc', 'average_precision', 'brier']);

// PR4-B2 — 후속 필수(temporal holdout·subgroup)와 별도 연구(외부검증)를 구분해
// 명시한다(계획서 확정 결정 #5). estimation:'ok'일 때 항상 같은 값.
const NOT_PERFORMED = ['temporal_holdout', 'subgroup', 'external_validation'] as const;

// 코드리뷰(2026-09-25) — prevalence는 모형이 실제로 적합·평가되는 단위(S2 행)
// 기준이어야 한다. eventPersonCount/personCount(사람 단위)를 쓰면 disease grain처럼
// 한 사람이 여러 행을 가질 때 두 비율이 달라진다(예: S2 90행·사건 행 30개인데
// 사건 보유자가 60명 중 30명이면 사람 기준 0.5≠행 기준 0.333). 성공·추정불가
// 양쪽 경로 모두 이 함수로 계산한다.
function computeRowLevelPrevalence(state: NonNullable<AnalysisContext['predictionState']>): number | null {
  if (state.s2Rows.length === 0) return null;
  const eventRowCount = state.s2Rows.filter(
    (row) => stringifyOutcomeValue(row.values[state.outcomeKey]!.value) === state.eventLevel,
  ).length;
  return eventRowCount / state.s2Rows.length;
}

function buildValidationBlock() {
  return {
    scheme: 'grouped_cv' as const,
    outerFolds: PREDICTION_POLICY.outerFolds,
    repeats: PREDICTION_POLICY.repeats,
    innerFolds: PREDICTION_POLICY.innerFolds,
    outerFoldBasis: 'base_cohort' as const,
    samplerVersion: PREDICTION_POLICY.samplerVersion,
  };
}

function buildLambdaBlock(selected: number | null) {
  return {
    selected,
    gridMin: PREDICTION_POLICY.lambdaGridMin,
    gridMax: PREDICTION_POLICY.lambdaGridMax,
    gridSize: PREDICTION_POLICY.lambdaGridSize,
  };
}

/** 고정 캐비어트(계획서 §1단계 "caveats"). SAME_ASSESSOR_FINDINGS만 조건부다 —
 * K-L Grade·Ellman·확인상태·척추 공통소견처럼 clinician_judgment predictor가
 * 하나라도 선택됐으면(그 상병의 업무관련성 판정과 같은 평가자가 매긴 값이므로)
 * 붙인다. 나머지는 이 연구용 내부검증 방법론 자체의 구조적 사실이라
 * estimation:'ok'면 항상 붙는다. */
function buildCaveats(state: NonNullable<AnalysisContext['predictionState']>, ctx: AnalysisContext): PredictionCaveat[] {
  const caveats: PredictionCaveat[] = [
    'RESEARCH_INTERNAL_VALIDATION',
    'NOT_FOR_DEPLOYMENT',
    'TEMPORAL_VALIDATION_NOT_PERFORMED',
    'SUBGROUP_PERFORMANCE_NOT_PERFORMED',
    'EXTERNAL_VALIDATION_NOT_PERFORMED',
    'LATEST_PAYLOAD_LEAKAGE_POSSIBLE',
    'RAW_EXPOSURE_FORMULA_INPUT',
    'USER_MODEL_SELECTION_NOT_CORRECTED',
  ];
  const hasClinicianJudgmentPredictor = state.predictorKeys.some(
    (key) => ctx.catalogByKey.get(key)?.provenance === 'clinician_judgment',
  );
  if (hasClinicianJudgmentPredictor) caveats.push('SAME_ASSESSOR_FINDINGS');
  return caveats;
}

function buildNonEstimableResult(
  state: NonNullable<AnalysisContext['predictionState']>,
  reason: NonNullable<AnalysisContext['predictionState']>['nonEstimableCheck']['reason'] & string,
  ctx: AnalysisContext,
): AnalyzePredictionResult {
  return {
    suppressed: false,
    estimation: 'non_estimable',
    nonEstimableReason: reason as Exclude<typeof reason, null>,
    method: 'l2_logistic',
    outcomeKey: state.outcomeKey,
    eventLevel: state.eventLevel,
    // 코드리뷰(2026-09-25) — "모형을 추정할 수 없다"와 "분석 대상 행이 없다"는
    // 다르다. 추정 불가 사유 1~6(design 자체가 없는 경우)도 S2 행은 이미 계산돼
    // 있다(state.s2Rows는 nonEstimableCheck와 무관하게 항상 채워진다).
    n: state.s2Rows.length,
    personCount: state.personCount,
    eventPersonCount: state.eventPersonCount,
    nonEventPersonCount: state.nonEventPersonCount,
    prevalence: computeRowLevelPrevalence(state),
    excludedRowCount: state.excludedRowCount,
    parameterCount: state.nonEstimableCheck.parameterCount,
    columnCount: state.nonEstimableCheck.columnCount,
    validation: buildValidationBlock(),
    lambda: buildLambdaBlock(null),
    qualityFlags: [],
    droppedColumnFoldCount: null,
    metrics: [],
    aucCi: null,
    curves: null,
    coefficients: null,
    caveats: buildCaveats(state, ctx),
    notPerformed: [...NOT_PERFORMED],
  };
}

function buildMetric(name: (typeof METRIC_NAMES)[number], raw: StatsEnginePredictionMetric): PredictionMetric {
  const cvWithheld = raw.cv.status === 'withheld';
  const bootstrapWithheld = raw.bootstrap.status === 'withheld';
  const bounded = BOUNDED_METRICS.has(name);
  const correctedOutOfRange = !bootstrapWithheld && raw.bootstrap.corrected !== null && bounded
    && (raw.bootstrap.corrected < 0 || raw.bootstrap.corrected > 1);

  return {
    metric: name,
    apparent: raw.apparent,
    representativeRepeat: raw.representativeRepeat,
    cv: {
      status: raw.cv.status,
      withheldReason: cvWithheld ? 'LOW_VALID_REPEATS' : null,
      validRepeats: raw.cv.validRepeats,
      totalRepeats: raw.cv.totalRepeats,
      mean: raw.cv.mean,
      min: raw.cv.min,
      max: raw.cv.max,
    },
    bootstrap: {
      status: raw.bootstrap.status,
      withheldReason: bootstrapWithheld ? (raw.apparent === null ? 'APPARENT_UNAVAILABLE' : 'LOW_VALID_REPLICATES') : null,
      validReplicates: raw.bootstrap.validReplicates,
      totalReplicates: raw.bootstrap.totalReplicates,
      optimism: raw.bootstrap.optimism,
      corrected: raw.bootstrap.corrected,
      correctedOutOfRange,
    },
  };
}

function buildCoefficients(
  intercept: number,
  coefficients: number[],
  columns: ReadonlyArray<{ name: string; variableKey: string; level: string | null }>,
): PredictionCoefficients {
  return {
    intercept,
    terms: columns.map((col, i) => ({
      term: col.name,
      variableKey: col.variableKey,
      level: col.level,
      standardizedBeta: coefficients[i],
    })),
  };
}

/** 사전검사(statsAnalyzeHandler.ts의 assertInputWithinLimitsForMode)와 실제 실행
 * (computePredictionAnalyzeResult)이 공유하는 순수 빌더 — regression의
 * buildRegressionEngineRequest와 동일한 원칙(코드리뷰 2026-09-24, 근사 요청으로
 * 사전검사를 하면 실제 요청과 바이트 크기가 어긋날 수 있다). design이 없으면
 * (non_estimable 확정) 호출하면 안 된다. */
export function buildPredictionEngineRequestForState(
  state: NonNullable<AnalysisContext['predictionState']>,
  design: PredictionDesignMatrix,
): { request: PredictionEngineRequest; y: number[]; groups: string[] } {
  const y = state.s2Rows.map((row) => (stringifyOutcomeValue(row.values[state.outcomeKey]!.value) === state.eventLevel ? 1 : 0));
  const groups = state.s2Rows.map((row) => row.cohortPersonKey!);
  const request = buildPredictionEngineRequest({
    y, x: design.x, columnNames: design.columns.map((c) => c.name), groups,
    outerFoldAssignment: state.outerFoldAssignment, outerFoldCount: state.outerFoldCount,
  });
  return { request, y, groups };
}

/** computeAndPersist(statsRunsQueue.ts)의 캐시-미스 분기 전용 진입점(다른 모드
 * 계산 함수와 동일한 원칙). ctx.predictionState가 null이면 안 된다 —
 * statsAnalyzeHandler.ts가 호출 전에 ②공개통제 통과를 이미 보장한다. */
export async function computePredictionAnalyzeResult(
  ctx: AnalysisContext,
  opts?: EngineRunOpts,
): Promise<AnalyzePredictionResult> {
  const state = ctx.predictionState;
  if (!state) {
    throw new Error('computePredictionAnalyzeResult: ctx.predictionState가 없다 — 호출 순서 위반');
  }

  const { nonEstimableCheck } = state;
  if (nonEstimableCheck.reason !== null) {
    return buildNonEstimableResult(state, nonEstimableCheck.reason, ctx);
  }
  const design = nonEstimableCheck.design;
  if (!design) {
    throw new Error('computePredictionAnalyzeResult: nonEstimableCheck.reason이 null인데 design이 없다 — 계약 위반');
  }

  const { request, y, groups } = buildPredictionEngineRequestForState(state, design);

  const raw = await runPredictionStatsEngine(request, opts);

  if (raw.estimation === 'non_estimable') {
    return {
      suppressed: false,
      estimation: 'non_estimable',
      nonEstimableReason: 'NOT_CONVERGED',
      method: 'l2_logistic',
      outcomeKey: state.outcomeKey,
      eventLevel: state.eventLevel,
      n: state.s2Rows.length,
      personCount: state.personCount,
      eventPersonCount: state.eventPersonCount,
      nonEventPersonCount: state.nonEventPersonCount,
      prevalence: computeRowLevelPrevalence(state),
      excludedRowCount: state.excludedRowCount,
      parameterCount: design.parameterCount,
      columnCount: design.columnCount,
      validation: buildValidationBlock(),
      lambda: buildLambdaBlock(null),
      qualityFlags: [],
      droppedColumnFoldCount: raw.droppedColumnFoldCount,
      metrics: [],
      aucCi: null,
      curves: null,
      coefficients: null,
      caveats: buildCaveats(state, ctx),
      notPerformed: [...NOT_PERFORMED],
    };
  }

  const metrics: PredictionMetric[] = METRIC_NAMES.map((name) => buildMetric(name, raw.metrics[name]!));

  // 곡선 — 반복 1(representativeRepeat)의 OOF만 쓴다(계획서 결정 #8). ROC/PR/
  // calibration 셋 다 이 공통 구간을 공유한다.
  const curveRows: PredictionCurveRow[] = raw.oofRepresentative!.map((point) => ({
    row: point.row,
    p: point.p,
    y: y[point.row] as 0 | 1,
    cohortPersonKey: groups[point.row],
  }));
  const curvesResult = computePredictionCurves(curveRows);
  const curves = {
    bins: curvesResult.bins,
    suppressedReason: curvesResult.suppressedReason,
    representativeRepeat: 1 as const,
    areaMayDifferFromAuc: true as const,
  };

  return {
    suppressed: false,
    estimation: 'ok',
    nonEstimableReason: null,
    method: 'l2_logistic',
    outcomeKey: state.outcomeKey,
    eventLevel: state.eventLevel,
    n: state.s2Rows.length,
    personCount: state.personCount,
    eventPersonCount: state.eventPersonCount,
    nonEventPersonCount: state.nonEventPersonCount,
    prevalence: computeRowLevelPrevalence(state),
    excludedRowCount: state.excludedRowCount,
    parameterCount: design.parameterCount,
    columnCount: design.columnCount,
    validation: buildValidationBlock(),
    lambda: buildLambdaBlock(raw.lambdaSelected),
    qualityFlags: [],
    droppedColumnFoldCount: raw.droppedColumnFoldCount,
    metrics,
    aucCi: raw.aucCi,
    curves,
    coefficients: buildCoefficients(raw.intercept!, raw.coefficients!, design.columns),
    caveats: buildCaveats(state, ctx),
    notPerformed: [...NOT_PERFORMED],
  };
}

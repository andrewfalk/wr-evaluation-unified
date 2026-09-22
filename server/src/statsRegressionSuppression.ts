// PR4-A1 — 연관성 회귀 ⑤적합 + ⑥추론 공개 정책 + ⑦결과 조립. 계획서
// (pr4-a-lexical-reddy.md) §2 "실행 순서" 참고. ①②③④(입력상한·완전사례·
// 공개통제·설계행렬)는 이미 statsAnalysisContext.ts가 preview·analyze 공유
// 경로에서 끝내둔 상태(ctx.regressionDesign)로 이 함수에 들어온다 — ③을
// 통과하지 못한 요청은 이 함수 자체가 호출되지 않는다(statsAnalyzeHandler.ts가
// 먼저 차단, §2 "③이 ④보다 먼저인 이유").
//
// PR4-A2 — VIF/condition number·spline 부분효과 조립을 여기서 담당한다. spline
// 대비행렬은 Node가 만들어 보낸다(계획서 §3 "spline 부분효과" — Python은
// spline을 전혀 모른다). 행 단위 진단(limited_row)은 여기서 만들지 않는다 —
// statsLimitedRowMerge.ts가 hasAccess일 때만 별도 경량 엔진 호출로 채운다
// (계획서 §4 "limited_row 진단값" — 캐시 hit/miss와 무관한 (X,y,β)만의 순수
// 함수로 분리).
import type {
  AnalyzeRegressionResult, RegressionDiagnostics, RegressionSplinePartialEffect, RegressionTerm,
} from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import {
  runRegressionStatsEngine,
  type RegressionCovarianceSpec,
  type StatsEngineRegressionDiagnostics,
} from './statsEngine';
import { REGRESSION_POLICY } from './statsPolicy';
import type { RegressionDesignMatrix } from './statsRegressionDesign';
import { naturalSplineBasis, type SplineKnots } from './statsSplineBasis';

const ANALYSIS_UNIT_NOTE =
  '이 계수는 행(사례·직업·상병) 단위 연관성이며, 행을 여러 개 가진 사람이 더 큰 가중치를 ' +
  '갖습니다. 클러스터 보정은 표준오차만 조정하고 이 가중치를 바꾸지 않습니다.';

const SPLINE_GRID_SIZE = 40;

function distinctCount(values: readonly string[]): number {
  return new Set(values).size;
}

/** ⑥ 추론 공개 정책의 covariance 선택 — personCount==rowCount면 HC3, 아니면
 * person-cluster CR1(계획 §2 표). 클러스터 부족·쏠림 여부는 여기서 판정하지
 * 않는다 — Python 응답을 받은 *뒤*에 판정한다(리뷰 #17 우선순위 사슬:
 * covariance 불능/degenerate가 클러스터 사유보다 항상 우선해야 하므로, Python이
 * 실제로 계산해본 결과를 보기 전에는 최종 상태를 정할 수 없다). */
function resolveCovarianceSpec(design: RegressionDesignMatrix): { spec: RegressionCovarianceSpec; personCount: number; rowCount: number } {
  const rowCount = design.x.length;
  const personCount = distinctCount(design.personClusterKeys);
  if (personCount === rowCount) {
    return { spec: { type: 'hc3' }, personCount, rowCount };
  }
  return { spec: { type: 'cluster', groups: design.personClusterKeys }, personCount, rowCount };
}

function maxClusterShare(groups: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  const total = groups.length;
  let max = 0;
  for (const c of counts.values()) max = Math.max(max, c / total);
  return max;
}

function mapTerms(
  rawTerms: ReadonlyArray<{
    name: string; estimate: number; se: number | null; statistic: number | null;
    pValue: number | null; ciLower: number | null; ciUpper: number | null;
    exponentiated: { estimate: number; ciLower: number | null; ciUpper: number | null } | null;
  }>,
  columns: RegressionDesignMatrix['columns'],
  nullifyInference: boolean,
): RegressionTerm[] {
  const columnByName = new Map(columns.map((c) => [c.name, c] as const));
  return rawTerms.map((t) => {
    const col = columnByName.get(t.name);
    return {
      name: t.name,
      label: col?.label ?? t.name,
      variableKey: col?.variableKey ?? null,
      level: col?.level ?? null,
      estimate: t.estimate,
      se: t.se,
      statistic: nullifyInference ? null : t.statistic,
      pValue: nullifyInference ? null : t.pValue,
      ciLower: nullifyInference ? null : t.ciLower,
      ciUpper: nullifyInference ? null : t.ciUpper,
      exponentiated: nullifyInference && t.exponentiated
        ? { estimate: t.exponentiated.estimate, ciLower: null, ciUpper: null }
        : t.exponentiated,
      // PR4-A2 — spline 기저 항은 클라이언트가 forest plot에서 묶어 빼고
      // 부분효과 곡선으로 대체 표시한다. interaction 항은 어느 두 predictor의
      // 곱인지 알려준다.
      termType: col?.termType ?? 'main',
      interactionOf: col?.interactionOf ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// PR4-A2 — spline 예측 그리드 + 대비행렬. 훈련 시 정한 knot을 그대로 재사용한다
// (그리드에서 분위수를 다시 계산하면 다른 기저가 된다, §2 "spline 기저").
// ---------------------------------------------------------------------------

function buildSplineGrid(knots: SplineKnots): number[] {
  const [lo, hi] = knots.boundary;
  if (!(hi > lo)) return [lo];
  const grid: number[] = [];
  for (let i = 0; i < SPLINE_GRID_SIZE; i += 1) {
    grid.push(lo + ((hi - lo) * i) / (SPLINE_GRID_SIZE - 1));
  }
  return grid;
}

/** 대비 벡터 = basis(x) - basis(x₀)(그리드 최솟값), spline 기저 열에만 값을
 * 싣고 나머지 열은 0이다 — spline predictor는 interaction에 참여할 수 없으므로
 * (계약 단계에서 이미 차단) 이 블록만으로 충분하다(계획서 §3 "대비 정의"). */
function buildSplineContrastMatrix(
  variableKey: string,
  knots: SplineKnots,
  columns: RegressionDesignMatrix['columns'],
  gridValues: number[],
): number[][] {
  const p = columns.length;
  const basisColumnIndices = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.variableKey === variableKey && c.termType === 'spline_basis')
    .map(({ i }) => i);
  const baseline = naturalSplineBasis(gridValues[0], knots);
  return gridValues.map((x) => {
    const row = new Array(p).fill(0);
    const basis = naturalSplineBasis(x, knots);
    basisColumnIndices.forEach((colIndex, basisPos) => {
      row[colIndex] = basis[basisPos] - baseline[basisPos];
    });
    return row;
  });
}

function buildPublicDiagnostics(
  raw: StatsEngineRegressionDiagnostics | null,
  columns: RegressionDesignMatrix['columns'],
  rowCount: number,
): RegressionDiagnostics | null {
  if (raw === null) return null;
  const nonInterceptColumns = columns.slice(1); // Python의 vif는 절편 제외, 같은 순서
  const vif = nonInterceptColumns.map((col, i) => ({
    variableKey: col.variableKey,
    termName: col.name,
    vif: raw.vif[i] ?? null,
  }));
  return {
    conditionNumber: raw.conditionNumber,
    vif,
    pointDiagnosticsSupported: raw.pointDiagnosticsSupported,
    pointDiagnosticsUnsupportedReason: raw.pointDiagnosticsUnsupportedReason,
    // PR4-A2 — 모형이 애초에 미지원이면 여기서 바로 unavailable_model로 확정한다
    // (엔진을 부를 이유가 없다). 지원하면 statsLimitedRowMerge.ts가 hasAccess를
    // 보고 최종 상태(unavailable_no_access/unavailable_computation_failed/
    // available)를 결정할 때까지 not_requested로 둔다.
    pointDiagnosticsStatus: raw.pointDiagnosticsSupported ? 'not_requested' : 'unavailable_model',
    displayedPointCount: null,
    totalPointCount: rowCount,
  };
}

function buildPublicSplinePartialEffects(
  rawEffects: ReadonlyArray<{
    variableKey: string;
    points: ReadonlyArray<{
      deltaFromBaseline: number | null; ciLower: number | null; ciUpper: number | null;
      exponentiated: { estimate: number; ciLower: number | null; ciUpper: number | null } | null;
    }>;
  }> | null,
  splineGridByKey: ReadonlyMap<string, number[]>,
): RegressionSplinePartialEffect[] | null {
  if (rawEffects === null) return null;
  return rawEffects.map((effect) => {
    const gridValues = splineGridByKey.get(effect.variableKey) ?? [];
    return {
      variableKey: effect.variableKey,
      scale: 'linear_predictor' as const,
      points: effect.points.map((point, i) => ({
        x: gridValues[i],
        deltaFromBaseline: point.deltaFromBaseline,
        ciLower: point.ciLower,
        ciUpper: point.ciUpper,
        exponentiated: point.exponentiated,
      })),
    };
  });
}

/** computeAndPersist의 캐시-미스 분기 전용 진입점(다른 모드 계산 함수와 동일한
 * 원칙 — 캐시 hit면 이 함수는 호출되지 않는다). ctx.regressionDesign이 null이면
 * 안 된다 — statsAnalyzeHandler.ts가 호출 전에 ③ 공개·④ 설계행렬 존재를
 * 이미 보장한다. */
export async function computeRegressionAnalyzeResult(ctx: AnalysisContext): Promise<AnalyzeRegressionResult> {
  const design = ctx.regressionDesign;
  if (!design) {
    throw new Error('computeRegressionAnalyzeResult: ctx.regressionDesign이 없다 — 호출 순서 위반');
  }
  const excludedRowCount = ctx.regressionExcludedRowCount ?? 0;

  if (!design.ok) {
    return {
      suppressed: false,
      estimation: 'non_estimable',
      method: ctx.regressionMethod!,
      outcomeKey: ctx.recipe.regression!.outcomeKey,
      eventLevel: null,
      referenceLevelsUsed: {},
      covariance: 'hc3',
      inferenceDistribution: null,
      inferenceDf: null,
      residualDf: 0,
      n: 0,
      personCount: 0,
      clusterCount: null,
      maxClusterShare: null,
      terms: [],
      fit: null,
      nonEstimableReason: design.reason,
      inferenceWithheldReason: null,
      excludedRowCount,
      qualityFlags: [],
      analysisUnitNote: ANALYSIS_UNIT_NOTE,
      diagnostics: null,
      standardizedPredictorKeys: [],
      standardization: null,
      splinePartialEffects: null,
    };
  }

  const { spec, personCount, rowCount } = resolveCovarianceSpec(design.design);
  const family = design.design.method === 'ols_linear' ? 'gaussian' : 'binomial';

  // PR4-A2 — spline predictor별 예측 그리드+대비행렬을 만들어 함께 보낸다.
  // gridByKey는 응답을 받은 뒤 x값을 zip하기 위해 로컬로 보관한다(Python은
  // 대비 벡터만 알고 원본 x값은 모른다).
  const splineGridByKey = new Map<string, number[]>();
  const splineContrasts: { variableKey: string; contrastMatrix: number[][] }[] = [];
  for (const [variableKey, knots] of Object.entries(design.design.splineKnots)) {
    const gridValues = buildSplineGrid(knots);
    splineGridByKey.set(variableKey, gridValues);
    splineContrasts.push({
      variableKey,
      contrastMatrix: buildSplineContrastMatrix(variableKey, knots, design.design.columns, gridValues),
    });
  }

  const raw = await runRegressionStatsEngine({
    family,
    y: design.design.y,
    X: design.design.x,
    columnNames: design.design.columns.map((c) => c.name),
    covariance: spec,
    splineContrasts,
  });

  const residualDf = rowCount - design.design.columns.length;
  const standardization = Object.keys(design.design.standardization).length > 0 ? design.design.standardization : null;

  if (raw.estimation === 'non_estimable') {
    return {
      suppressed: false,
      estimation: 'non_estimable',
      method: design.design.method,
      outcomeKey: ctx.recipe.regression!.outcomeKey,
      eventLevel: design.design.eventLevel,
      referenceLevelsUsed: design.design.referenceLevelsUsed,
      covariance: spec.type === 'hc3' ? 'hc3' : 'person_cluster_cr1',
      inferenceDistribution: null,
      inferenceDf: null,
      residualDf,
      n: rowCount,
      personCount,
      clusterCount: spec.type === 'cluster' ? personCount : null,
      maxClusterShare: spec.type === 'cluster' ? maxClusterShare(spec.groups) : null,
      terms: [],
      fit: null,
      nonEstimableReason: raw.nonEstimableReason,
      inferenceWithheldReason: null,
      excludedRowCount,
      qualityFlags: design.design.qualityFlags,
      analysisUnitNote: ANALYSIS_UNIT_NOTE,
      diagnostics: null,
      standardizedPredictorKeys: design.design.standardizedPredictorKeys,
      standardization,
      splinePartialEffects: null,
    };
  }

  // 리뷰 #17 우선순위 사슬 — covariance 불능/degenerate(Python이 판정)가 클러스터
  // 사유(Node가 판정)보다 항상 우선한다. Python이 이미 se를 전부 null로 낸
  // 상태(raw.estimation==='inference_withheld')라면 그 사유를 그대로 쓰고,
  // 클러스터 게이트로 "덮어쓰지" 않는다.
  let estimation: 'ok' | 'inference_withheld' = raw.estimation === 'ok' ? 'ok' : 'inference_withheld';
  let inferenceWithheldReason: 'TOO_FEW_CLUSTERS' | 'CLUSTER_IMBALANCE' | 'COVARIANCE_NOT_COMPUTABLE' | 'DEGENERATE_COVARIANCE' | null = null;
  let nullifyInference = false;

  if (raw.inferenceIssue === 'COVARIANCE_NOT_COMPUTABLE' || raw.inferenceIssue === 'DEGENERATE_COVARIANCE') {
    inferenceWithheldReason = raw.inferenceIssue;
  } else if (spec.type === 'cluster') {
    const share = maxClusterShare(spec.groups);
    if (personCount < REGRESSION_POLICY.minClusters) {
      estimation = 'inference_withheld';
      inferenceWithheldReason = 'TOO_FEW_CLUSTERS';
      nullifyInference = true;
    } else if (share > REGRESSION_POLICY.maxClusterShare) {
      estimation = 'inference_withheld';
      inferenceWithheldReason = 'CLUSTER_IMBALANCE';
      nullifyInference = true;
    }
  }

  const terms = mapTerms(raw.terms, design.design.columns, nullifyInference);

  // PR4-A2 — spline CI는 계수표와 같은 원칙: Python 자체 사유든 Node 클러스터
  // 게이트(nullifyInference)든 inference_withheld면 전부 null. Python이
  // inference_withheld를 직접 리턴한 경우는 이미 cov=None으로 CI가 null이므로,
  // 여기서 추가로 널화해야 하는 건 Node가 사후에 내린 클러스터 게이트뿐이다.
  const splinePartialEffectsRaw = nullifyInference && raw.splinePartialEffects
    ? raw.splinePartialEffects.map((effect) => ({
        variableKey: effect.variableKey,
        points: effect.points.map((point) => ({
          deltaFromBaseline: point.deltaFromBaseline,
          ciLower: null,
          ciUpper: null,
          exponentiated: point.exponentiated ? { estimate: point.exponentiated.estimate, ciLower: null, ciUpper: null } : null,
        })),
      }))
    : raw.splinePartialEffects;

  return {
    suppressed: false,
    estimation,
    method: design.design.method,
    outcomeKey: ctx.recipe.regression!.outcomeKey,
    eventLevel: design.design.eventLevel,
    referenceLevelsUsed: design.design.referenceLevelsUsed,
    covariance: spec.type === 'hc3' ? 'hc3' : 'person_cluster_cr1',
    inferenceDistribution: nullifyInference ? null : raw.inferenceDistribution,
    inferenceDf: nullifyInference ? null : raw.inferenceDf,
    residualDf,
    n: rowCount,
    personCount,
    clusterCount: spec.type === 'cluster' ? personCount : null,
    maxClusterShare: spec.type === 'cluster' ? maxClusterShare(spec.groups) : null,
    terms,
    fit: raw.fit,
    nonEstimableReason: null,
    inferenceWithheldReason,
    excludedRowCount,
    qualityFlags: [...design.design.qualityFlags, ...raw.qualityFlags],
    analysisUnitNote: ANALYSIS_UNIT_NOTE,
    diagnostics: buildPublicDiagnostics(raw.diagnostics, design.design.columns, rowCount),
    standardizedPredictorKeys: design.design.standardizedPredictorKeys,
    standardization,
    splinePartialEffects: buildPublicSplinePartialEffects(splinePartialEffectsRaw, splineGridByKey),
  };
}

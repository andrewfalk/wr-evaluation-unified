// PR4-A1 — 연관성 회귀 ⑤적합 + ⑥추론 공개 정책 + ⑦결과 조립. 계획서
// (pr4-a-lexical-reddy.md) §2 "실행 순서" 참고. ①②③④(입력상한·완전사례·
// 공개통제·설계행렬)는 이미 statsAnalysisContext.ts가 preview·analyze 공유
// 경로에서 끝내둔 상태(ctx.regressionDesign)로 이 함수에 들어온다 — ③을
// 통과하지 못한 요청은 이 함수 자체가 호출되지 않는다(statsAnalyzeHandler.ts가
// 먼저 차단, §2 "③이 ④보다 먼저인 이유").
import type { AnalyzeRegressionResult, RegressionTerm } from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import { runRegressionStatsEngine, type RegressionCovarianceSpec } from './statsEngine';
import { REGRESSION_POLICY } from './statsPolicy';
import type { RegressionDesignMatrix } from './statsRegressionDesign';

const ANALYSIS_UNIT_NOTE =
  '이 계수는 행(사례·직업·상병) 단위 연관성이며, 행을 여러 개 가진 사람이 더 큰 가중치를 ' +
  '갖습니다. 클러스터 보정은 표준오차만 조정하고 이 가중치를 바꾸지 않습니다.';

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
    };
  }

  const { spec, personCount, rowCount } = resolveCovarianceSpec(design.design);
  const family = design.design.method === 'ols_linear' ? 'gaussian' : 'binomial';
  const raw = await runRegressionStatsEngine({
    family,
    y: design.design.y,
    x: design.design.x,
    columnNames: design.design.columns.map((c) => c.name),
    covariance: spec,
  });

  const residualDf = rowCount - design.design.columns.length;

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
  };
}

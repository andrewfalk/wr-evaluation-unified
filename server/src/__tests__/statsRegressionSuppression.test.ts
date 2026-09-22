// PR4-A1 — computeRegressionAnalyzeResult(⑤⑥⑦) 단위테스트. runRegressionStatsEngine을
// mock해 리뷰 #17의 우선순위 사슬(covariance 불능/degenerate가 클러스터 사유보다
// 항상 우선 — Node가 덮어쓰지 않음)과 클러스터 게이트 강등(p·CI만 null, se는 유지)을
// 직접 확인한다.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runRegressionStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runRegressionStatsEngine: (...args: unknown[]) => runRegressionStatsEngine(...args) };
});

beforeEach(() => { vi.clearAllMocks(); });

import { computeRegressionAnalyzeResult } from '../statsRegressionSuppression';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { RegressionDesignMatrix, RegressionDesignResult } from '../statsRegressionDesign';

function makeDesign(overrides: Partial<RegressionDesignMatrix> = {}): RegressionDesignMatrix {
  return {
    y: [1, 2, 3, 4],
    x: [[1, 0], [1, 1], [1, 0], [1, 1]],
    columns: [
      { name: 'intercept', label: '절편', variableKey: null, level: null },
      { name: 'x1', label: 'x1 변수', variableKey: 'x1', level: null },
    ],
    personClusterKeys: ['p1', 'p2', 'p3', 'p4'],
    referenceLevelsUsed: {},
    method: 'ols_linear',
    eventLevel: null,
    qualityFlags: [],
    ...overrides,
  };
}

function makeCtx(design: RegressionDesignResult | null, excludedRowCount = 0): AnalysisContext {
  return {
    orgId: 'org', userId: 'user',
    recipe: {
      grain: 'case', variableKeys: ['x1', 'y'], filters: [], analysisPurpose: 'association',
      formulaPolicies: {}, analysisMode: 'regression', requestedMethod: 'ols_linear',
      regression: { outcomeKey: 'y', referenceLevels: {} },
    },
    catalogByKey: new Map(),
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: {} as AnalysisContext['dataset'],
    requestSuppressed: false, reasonCode: null,
    paired: null, pairDisclosed: false, availableMethods: [], methodCatalogVersion: null,
    correlationMatrixPairs: null, correlationMatrixVariables: null,
    regressionDisclosed: true,
    regressionDesign: design,
    regressionExcludedRowCount: excludedRowCount,
    regressionMethod: 'ols_linear',
  };
}

function rawTerm(overrides: Partial<{
  name: string; estimate: number; se: number | null; statistic: number | null;
  pValue: number | null; ciLower: number | null; ciUpper: number | null;
  exponentiated: { estimate: number; ciLower: number | null; ciUpper: number | null } | null;
}> = {}) {
  return {
    name: 'x1', estimate: 1.5, se: 0.3, statistic: 5.0, pValue: 0.001,
    ciLower: 0.9, ciUpper: 2.1, exponentiated: null,
    ...overrides,
  };
}

describe('computeRegressionAnalyzeResult — non_estimable(Node ④ 판정, Python 미호출)', () => {
  it('design.ok===false면 Python을 호출하지 않고 non_estimable을 반환한다', async () => {
    const ctx = makeCtx({ ok: false, reason: 'RANK_DEFICIENT' });
    const result = await computeRegressionAnalyzeResult(ctx);
    expect(runRegressionStatsEngine).not.toHaveBeenCalled();
    expect(result).toMatchObject({ suppressed: false, estimation: 'non_estimable', nonEstimableReason: 'RANK_DEFICIENT', terms: [], fit: null });
  });
});

describe('computeRegressionAnalyzeResult — HC3 경로(personCount===rowCount)', () => {
  it('정상 응답이면 estimation:"ok"로 covariance:"hc3"를 쓴다', async () => {
    runRegressionStatsEngine.mockResolvedValueOnce({
      estimation: 'ok', nonEstimableReason: null, inferenceIssue: 'ok',
      inferenceDistribution: 't', inferenceDf: 2, clusterCount: null,
      terms: [rawTerm({ name: 'intercept', estimate: 1.0 }), rawTerm({ name: 'x1' })],
      fit: { r2: 0.9, adjR2: 0.85, logLik: null, aic: null, pseudoR2: null },
      converged: true, qualityFlags: [],
    });
    const design = makeDesign(); // personClusterKeys 4개 전부 다름 → personCount===rowCount
    const ctx = makeCtx({ ok: true, design });
    const result = await computeRegressionAnalyzeResult(ctx);

    expect(runRegressionStatsEngine).toHaveBeenCalledTimes(1);
    const call = runRegressionStatsEngine.mock.calls[0][0];
    expect(call.covariance).toEqual({ type: 'hc3' });

    expect(result).toMatchObject({ suppressed: false, estimation: 'ok', covariance: 'hc3', personCount: 4, n: 4, clusterCount: null, maxClusterShare: null });
    if (result.suppressed === false && result.estimation === 'ok') {
      expect(result.terms).toHaveLength(2);
      expect(result.terms[1].label).toBe('x1 변수');
      expect(result.terms[1].variableKey).toBe('x1');
      expect(result.terms[1].pValue).toBe(0.001);
    }
  });
});

describe('computeRegressionAnalyzeResult — 클러스터 경로', () => {
  function clusterDesign(clusterKeys: string[]) {
    return makeDesign({
      y: clusterKeys.map((_, i) => i),
      x: clusterKeys.map((_, i) => [1, i]),
      personClusterKeys: clusterKeys,
    });
  }

  it('클러스터 수가 충분하면(>=30) 정상 ok', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 40; i += 1) keys.push(`p${i % 32}`); // 32개 클러스터, 40행
    runRegressionStatsEngine.mockResolvedValueOnce({
      estimation: 'ok', nonEstimableReason: null, inferenceIssue: 'ok',
      inferenceDistribution: 't', inferenceDf: 31, clusterCount: 32,
      terms: [rawTerm({ name: 'intercept' }), rawTerm({ name: 'x1' })],
      fit: { r2: 0.5, adjR2: 0.4, logLik: null, aic: null, pseudoR2: null },
      converged: true, qualityFlags: [],
    });
    const ctx = makeCtx({ ok: true, design: clusterDesign(keys) });
    const result = await computeRegressionAnalyzeResult(ctx);

    const call = runRegressionStatsEngine.mock.calls[0][0];
    expect(call.covariance.type).toBe('cluster');
    expect(result).toMatchObject({ estimation: 'ok', covariance: 'person_cluster_cr1', clusterCount: 32 });
    if (result.suppressed === false && result.estimation === 'ok') {
      expect(result.terms[1].pValue).not.toBeNull();
    }
  });

  it('클러스터 수가 부족하면(<30) TOO_FEW_CLUSTERS로 강등 — se는 유지, p/CI/statistic만 null', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 40; i += 1) keys.push(`p${i % 15}`); // 15개 클러스터만
    runRegressionStatsEngine.mockResolvedValueOnce({
      estimation: 'ok', nonEstimableReason: null, inferenceIssue: 'ok',
      inferenceDistribution: 't', inferenceDf: 14, clusterCount: 15,
      terms: [rawTerm({ name: 'intercept' }), rawTerm({ name: 'x1', se: 0.4 })],
      fit: { r2: 0.5, adjR2: 0.4, logLik: null, aic: null, pseudoR2: null },
      converged: true, qualityFlags: [],
    });
    const ctx = makeCtx({ ok: true, design: clusterDesign(keys) });
    const result = await computeRegressionAnalyzeResult(ctx);

    expect(result).toMatchObject({ estimation: 'inference_withheld', inferenceWithheldReason: 'TOO_FEW_CLUSTERS', inferenceDistribution: null, inferenceDf: null });
    if (result.suppressed === false && result.estimation === 'inference_withheld') {
      expect(result.terms[1].se).toBe(0.4); // se는 유지
      expect(result.terms[1].pValue).toBeNull();
      expect(result.terms[1].statistic).toBeNull();
      expect(result.terms[1].ciLower).toBeNull();
      expect(result.terms[1].ciUpper).toBeNull();
    }
  });

  it('클러스터 쏠림이 크면(단일 클러스터>20%) CLUSTER_IMBALANCE로 강등', async () => {
    // 40개 클러스터 중 하나가 행의 30%를 차지 — 클러스터 수는 충분(>=30)해도 쏠림으로 걸림.
    const keys: string[] = [];
    for (let i = 0; i < 30; i += 1) keys.push('dominant'); // 30/100 = 30%
    for (let i = 0; i < 70; i += 1) keys.push(`p${i}`);
    runRegressionStatsEngine.mockResolvedValueOnce({
      estimation: 'ok', nonEstimableReason: null, inferenceIssue: 'ok',
      inferenceDistribution: 't', inferenceDf: 70, clusterCount: 71,
      terms: [rawTerm({ name: 'intercept' }), rawTerm({ name: 'x1', se: 0.2 })],
      fit: { r2: 0.5, adjR2: 0.4, logLik: null, aic: null, pseudoR2: null },
      converged: true, qualityFlags: [],
    });
    const ctx = makeCtx({ ok: true, design: clusterDesign(keys) });
    const result = await computeRegressionAnalyzeResult(ctx);
    expect(result).toMatchObject({ estimation: 'inference_withheld', inferenceWithheldReason: 'CLUSTER_IMBALANCE' });
  });

  it('리뷰 #17 — covariance 불능(Python 판정)이 클러스터 부족(Node 판정)보다 우선한다(덮어쓰지 않음)', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 40; i += 1) keys.push(`p${i % 10}`); // 클러스터도 부족(10<30)
    runRegressionStatsEngine.mockResolvedValueOnce({
      estimation: 'inference_withheld', nonEstimableReason: null, inferenceIssue: 'COVARIANCE_NOT_COMPUTABLE',
      inferenceDistribution: null, inferenceDf: null, clusterCount: 10,
      terms: [
        { name: 'intercept', estimate: 1.0, se: null, statistic: null, pValue: null, ciLower: null, ciUpper: null, exponentiated: null },
        { name: 'x1', estimate: 1.5, se: null, statistic: null, pValue: null, ciLower: null, ciUpper: null, exponentiated: null },
      ],
      fit: { r2: 0.5, adjR2: 0.4, logLik: null, aic: null, pseudoR2: null },
      converged: true, qualityFlags: [],
    });
    const ctx = makeCtx({ ok: true, design: clusterDesign(keys) });
    const result = await computeRegressionAnalyzeResult(ctx);

    // 최종 사유가 COVARIANCE_NOT_COMPUTABLE로 유지돼야 한다 — TOO_FEW_CLUSTERS로
    // 덮이면 안 된다(우선순위 사슬 위반).
    expect(result).toMatchObject({ estimation: 'inference_withheld', inferenceWithheldReason: 'COVARIANCE_NOT_COMPUTABLE' });
    if (result.suppressed === false && result.estimation === 'inference_withheld') {
      expect(result.terms.every((t) => t.se === null)).toBe(true);
    }
  });
});

describe('computeRegressionAnalyzeResult — Python이 non_estimable을 반환하는 경우(⑤ 분리 등)', () => {
  it('raw.estimation==="non_estimable"이면 그대로 전달한다', async () => {
    runRegressionStatsEngine.mockResolvedValueOnce({
      estimation: 'non_estimable', nonEstimableReason: 'SEPARATION_DETECTED', inferenceIssue: null,
      inferenceDistribution: null, inferenceDf: null, clusterCount: null,
      terms: [], fit: null, converged: false, qualityFlags: [],
    });
    const ctx = makeCtx({ ok: true, design: makeDesign() });
    const result = await computeRegressionAnalyzeResult(ctx);
    expect(result).toMatchObject({ estimation: 'non_estimable', nonEstimableReason: 'SEPARATION_DETECTED', terms: [], fit: null });
  });
});

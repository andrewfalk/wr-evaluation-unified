// PR3-A — computeBivariateAnalyzeResult(B-처리) 단위테스트. 코드리뷰가 지목한
// "소수셀 직접 analyze → 엔진 호출 없이 suppressed"와 "포함/제외 대칭 억제와
// 제외 상세 독립 생략"을 runBivariateStatsEngine을 mock해 직접 확인한다.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runBivariateStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runBivariateStatsEngine: (...args: unknown[]) => runBivariateStatsEngine(...args) };
});

import { computeBivariateAnalyzeResult } from '../statsBivariateSuppression';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { PairedRow } from '../statsBivariateDataset';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

function makeVariable(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}

const CATALOG = new Map<string, AnalyticsVariableMetadata>([
  ['grp', makeVariable('grp', 'boolean')],
  ['val', makeVariable('val', 'continuous')],
]);

function makeCtx(pairs: PairedRow[], exclusions: AnalysisContext['paired'] extends infer P ? (P extends { exclusions: infer E } ? E : never) : never = []): AnalysisContext {
  return {
    orgId: 'org', userId: 'user',
    recipe: {
      grain: 'case', variableKeys: ['grp', 'val'], filters: [], analysisPurpose: 'association',
      formulaPolicies: {}, analysisMode: 'bivariate', requestedMethod: 'welch_t',
    },
    catalogByKey: CATALOG,
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: {} as AnalysisContext['dataset'],
    requestSuppressed: false, reasonCode: null,
    paired: {
      pairs,
      includedCaseCount: pairs.length,
      includedPersonCount: new Set(pairs.map((p) => p.personClusterKey)).size,
      excludedCaseCount: 0,
      excludedPersonCount: 0,
      exclusions,
    },
    pairDisclosed: true,
    availableMethods: [],
    methodCatalogVersion: 'v1-bivariate',
    correlationMatrixPairs: null,
    correlationMatrixVariables: null,
  };
}

function makeGroupPairs(counts: Array<{ label: boolean; n: number }>): PairedRow[] {
  const pairs: PairedRow[] = [];
  let seq = 0;
  for (const { label, n } of counts) {
    for (let i = 0; i < n; i += 1) { seq += 1; pairs.push({ caseId: `c${seq}`, personClusterKey: `p${seq}`, x: label, y: seq * 1.0 }); }
  }
  return pairs;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('computeBivariateAnalyzeResult — B-1 소수셀 사전검사', () => {
  it('그룹 하나라도 소수(1~9)면 엔진을 호출하지 않고 즉시 suppressed를 반환한다', async () => {
    const pairs = makeGroupPairs([{ label: false, n: 95 }, { label: true, n: 5 }]);
    const ctx = makeCtx(pairs);
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result).toEqual({ method: 'welch_t', suppressed: true });
    expect(runBivariateStatsEngine).not.toHaveBeenCalled();
  });

  it('모든 그룹이 ≥10이면 실제로 엔진을 호출하고 결과를 그대로 공개한다', async () => {
    const pairs = makeGroupPairs([{ label: false, n: 50 }, { label: true, n: 50 }]);
    const ctx = makeCtx(pairs);
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 100, statistic: 2.5, df: 98, pValue: 0.01,
      effectSizes: [{ name: 'mean_difference', value: 5, ci: [1, 9], ciUnavailableReason: null }],
      nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.01 },
      qualityFlags: [], extra: {},
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(runBivariateStatsEngine).toHaveBeenCalledTimes(1);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.statistic).toBe(2.5);
      // [코드리뷰 2026-09-12] 그룹 라벨·n이 응답에 실제로 포함돼야 부호 해석이 가능하다.
      expect(result.groupBreakdown).toEqual([{ label: false, n: 50 }, { label: true, n: 50 }]);
    }
  });

  it('엔진이 statistic:null(값상수 등)을 반환해도 nullReasons를 노출하지 않고 불투명 억제한다', async () => {
    const pairs = makeGroupPairs([{ label: false, n: 50 }, { label: true, n: 50 }]);
    const ctx = makeCtx(pairs);
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 100, statistic: null, df: null, pValue: null, effectSizes: [],
      nullReasons: { statistic: 'constant_variable' }, multipleTesting: { method: 'none', adjustedP: null },
      qualityFlags: [], extra: {},
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result).toEqual({ method: 'welch_t', suppressed: true });
  });
});

describe('computeBivariateAnalyzeResult — B-2 제외사유 독립 생략', () => {
  it('제외 합계는 유지하고 사유 중 하나라도 소수면 상세만 null로 생략한다(결과 자체는 별개로 공개)', async () => {
    const pairs = makeGroupPairs([{ label: false, n: 40 }, { label: true, n: 40 }]);
    const ctx = makeCtx(pairs, [
      { reasonCode: 'x_missing', count: 1, personCount: 1 },
      { reasonCode: 'y_missing', count: 19, personCount: 19 },
    ]);
    (ctx.paired as { excludedCaseCount: number }).excludedCaseCount = 20;
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 80, statistic: 1.0, df: 78, pValue: 0.3,
      effectSizes: [{ name: 'mean_difference', value: 1, ci: [-1, 3], ciUnavailableReason: null }],
      nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.3 },
      qualityFlags: [], extra: {},
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.excludedCaseCount).toBe(20); // 합계는 그대로 공개
      expect(result.exclusions).toBeNull();        // 사유별 상세만 생략(x_missing=1이 소수셀)
      expect(result.statistic).toBe(1.0);           // 분석 결과 자체는 억제 대상이 아님(독립 판정)
    }
  });

  it('제외 사유가 전부 충분히 크면(≥10) 상세를 그대로 공개한다', async () => {
    const pairs = makeGroupPairs([{ label: false, n: 40 }, { label: true, n: 40 }]);
    const ctx = makeCtx(pairs, [
      { reasonCode: 'x_missing', count: 15, personCount: 15 },
      { reasonCode: 'y_missing', count: 20, personCount: 20 },
    ]);
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 80, statistic: 1.0, df: 78, pValue: 0.3,
      effectSizes: [], nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.3 },
      qualityFlags: [], extra: {},
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.exclusions).toEqual([
        { reasonCode: 'x_missing', count: 15 },
        { reasonCode: 'y_missing', count: 20 },
      ]);
    }
  });
});

describe('computeBivariateAnalyzeResult — PR3-B 그룹별 박스플롯(§5)', () => {
  it('그룹별 boxplot이 배선되고, 이상치 게이트를 통과하면 outlierCount도 노출된다', async () => {
    const pairs = makeGroupPairs([{ label: false, n: 50 }, { label: true, n: 50 }]);
    const ctx = makeCtx(pairs);
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 100, statistic: 2.5, df: 98, pValue: 0.01,
      effectSizes: [{ name: 'mean_difference', value: 5, ci: [1, 9], ciUnavailableReason: null }],
      nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.01 },
      qualityFlags: [], extra: {},
      groupBoxplots: [
        { label: false, boxplot: { q1: 10, median: 20, q3: 30, lowerWhisker: 1, upperWhisker: 40, lowerFence: -20, upperFence: 60, outlierCount: 0, outlierValues: [] } },
        { label: true, boxplot: { q1: 60, median: 70, q3: 80, lowerWhisker: 55, upperWhisker: 90, lowerFence: 25, upperFence: 115, outlierCount: 15, outlierValues: [] } },
      ],
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) return;
    // false 그룹(y값 1..50, fence -20~60) — 전부 fence 안이라 이상치 0명, 비이상치 50명 — 공개.
    expect(result.groupBreakdown?.[0].boxplot).toMatchObject({ q1: 10, q3: 30, outlierCount: 0 });
    // true 그룹(y값 51..100, fence 25~115) — 전부 안쪽이지만 Python이 15로 보고했다고
    // 가정한 값을 그대로 신뢰하지 않고 Node가 재계산한 게이트를 통과해야 노출된다.
    expect(result.groupBreakdown?.[1].boxplot).toMatchObject({ q1: 60, q3: 80 });
  });

  it('그룹 내부 이상치가 소수집단이면 그 그룹의 outlierCount만 생략된다(범위값은 유지)', async () => {
    // false 그룹: y값 1..49(정상)와 y값 하나만 극단치로 만들어 이상치 1명 재현.
    const pairs: PairedRow[] = [];
    for (let i = 1; i <= 49; i += 1) pairs.push({ caseId: `f${i}`, personClusterKey: `pf${i}`, x: false, y: i });
    pairs.push({ caseId: 'f-outlier', personClusterKey: 'pf-outlier', x: false, y: 1000 });
    for (let i = 1; i <= 50; i += 1) pairs.push({ caseId: `t${i}`, personClusterKey: `pt${i}`, x: true, y: 100 + i });
    const ctx = makeCtx(pairs);
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 100, statistic: 2.5, df: 98, pValue: 0.01,
      effectSizes: [{ name: 'mean_difference', value: 5, ci: [1, 9], ciUnavailableReason: null }],
      nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.01 },
      qualityFlags: [], extra: {},
      groupBoxplots: [
        // q1/q3는 대략 12/37 근방(정상 49개 기준) — fence 밖에 1000이 위치하도록 구성.
        { label: false, boxplot: { q1: 12, median: 25, q3: 37, lowerWhisker: 1, upperWhisker: 49, lowerFence: -25.5, upperFence: 74.5, outlierCount: 1, outlierValues: [1000] } },
        { label: true, boxplot: { q1: 112, median: 125, q3: 137, lowerWhisker: 101, upperWhisker: 150, lowerFence: 75.5, upperFence: 174.5, outlierCount: 0, outlierValues: [] } },
      ],
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) return;
    const falseGroup = result.groupBreakdown?.[0];
    expect(falseGroup?.boxplot).toBeDefined();
    expect(falseGroup?.boxplot && 'outlierCount' in falseGroup.boxplot).toBe(false); // 이상치 1명 — 게이트 실패
    expect(falseGroup?.boxplot?.q1).toBe(12); // 범위값 자체는 유지
    const trueGroup = result.groupBreakdown?.[1];
    expect(trueGroup?.boxplot).toMatchObject({ outlierCount: 0 }); // 이 그룹은 이상치 0명이라 공개
  });
});

describe('computeBivariateAnalyzeResult — PR3-B 상관 regressionLine/scatter(§2/§7)', () => {
  function makeCorrelationCtx(pairs: PairedRow[]): AnalysisContext {
    const catalog = new Map<string, AnalyticsVariableMetadata>([
      ['x', makeVariable('x', 'continuous')],
      ['y', makeVariable('y', 'continuous')],
    ]);
    return {
      ...makeCtx(pairs),
      recipe: { ...makeCtx(pairs).recipe, variableKeys: ['x', 'y'], requestedMethod: 'pearson_correlation' },
      catalogByKey: catalog,
    };
  }

  it('regressionLine과 scatter.grid가 배선된다(원시 points는 절대 포함하지 않는다)', async () => {
    const pairs: PairedRow[] = Array.from({ length: 100 }, (_, i) => ({
      caseId: `c${i}`, personClusterKey: `p${i}`, x: i, y: i * 2,
    }));
    const ctx = makeCorrelationCtx(pairs);
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 100, statistic: 0.99, df: 98, pValue: 0.0001,
      effectSizes: [{ name: 'pearson_r', value: 0.99, ci: [0.98, 0.995], ciUnavailableReason: null }],
      nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.0001 },
      qualityFlags: [], extra: {},
      regressionLine: { slope: 2, intercept: 0 },
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) return;
    expect(result.regressionLine).toEqual({ slope: 2, intercept: 0 });
    expect(result.scatter).toBeDefined();
    expect(result.scatter?.totalCount).toBe(100);
    expect(result.scatter && 'points' in result.scatter).toBe(false);
  });

  it('regressionLine이 null(상수/계산불가)이면 그대로 null로 노출된다', async () => {
    const pairs: PairedRow[] = Array.from({ length: 50 }, (_, i) => ({
      caseId: `c${i}`, personClusterKey: `p${i}`, x: i, y: i,
    }));
    const ctx = makeCorrelationCtx(pairs);
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 50, statistic: 1.0, df: 48, pValue: 0.0,
      effectSizes: [{ name: 'pearson_r', value: 1.0, ci: null, ciUnavailableReason: 'perfect_correlation' }],
      nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.0 },
      qualityFlags: [], extra: {},
      regressionLine: null,
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) return;
    expect(result.regressionLine).toBeNull();
  });
});

describe('computeBivariateAnalyzeResult — 분할표 groupBreakdown/contingencyTable 배선', () => {
  it('chi_square 결과에 contingencyTable(rowLabels/colLabels/cells)이 포함된다', async () => {
    const pairs: PairedRow[] = [];
    let seq = 0;
    const cells: Array<[boolean, boolean, number]> = [[false, false, 20], [false, true, 15], [true, false, 25], [true, true, 30]];
    for (const [x, y, n] of cells) {
      for (let i = 0; i < n; i += 1) { seq += 1; pairs.push({ caseId: `c${seq}`, personClusterKey: `p${seq}`, x, y }); }
    }
    const catalog = new Map<string, AnalyticsVariableMetadata>([
      ['x', makeVariable('x', 'boolean')],
      ['y', makeVariable('y', 'boolean')],
    ]);
    const ctx: AnalysisContext = {
      ...makeCtx(pairs),
      recipe: { ...makeCtx(pairs).recipe, variableKeys: ['x', 'y'], requestedMethod: 'chi_square' },
      catalogByKey: catalog,
    };
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 90, statistic: 1.2, df: 1, pValue: 0.27, effectSizes: [],
      nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.27 },
      qualityFlags: [], extra: { cramersV: { name: 'cramers_v', value: 0.1, ci: null, ciUnavailableReason: 'not_supported_v1' } },
    });
    const result = await computeBivariateAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.contingencyTable).toEqual({
        rowLabels: [false, true],
        colLabels: [false, true],
        cells: [[20, 15], [25, 30]],
      });
    }
  });
});

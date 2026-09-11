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

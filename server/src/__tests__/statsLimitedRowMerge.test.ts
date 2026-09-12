// PR3-B §9 — attachLimitedRowFields(응답시점 merge). 대상 필드는 boxplot
// outlierValues(descriptive/그룹별)와 scatter 원시 points 2종뿐(상관행렬은 해당
// 없음). hasAccess=false면 항상 no-op, 원본 객체를 mutate하지 않는지, gate가
// 실패한(outlierCount 없는) 변수는 건드리지 않는지를 검증한다.
import { describe, it, expect } from 'vitest';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { PairedRow } from '../statsBivariateDataset';
import type { AnalyzeResult } from '@wr/contracts';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { attachLimitedRowFields } from '../statsLimitedRowMerge';
import { canonicalDigest } from '../canonicalSerializer';

function makeVariable(key: string, type: AnalyticsVariableMetadata['type'] = 'continuous'): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}

function datasetRow(i: number, key: string, value: number): DatasetRow {
  return { caseId: `c${i}`, personClusterKey: `p${i}`, values: { [key]: { value, missing: null, qualityFlags: [] } } };
}

function baseCtx(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    orgId: 'org', userId: 'user',
    recipe: { grain: 'case', variableKeys: ['v'], filters: [], analysisPurpose: 'association', formulaPolicies: {}, analysisMode: 'descriptive' },
    catalogByKey: new Map([['v', makeVariable('v')]]),
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: { rows: [], personCount: 0, caseCount: 0, observationCount: 0, distinctAssignedDoctorClusters: 0, internalResultDigest: 'x' },
    requestSuppressed: false, reasonCode: null,
    paired: null, pairDisclosed: false, availableMethods: [], methodCatalogVersion: null,
    correlationMatrixPairs: null, correlationMatrixVariables: null,
    ...overrides,
  };
}

describe('attachLimitedRowFields — descriptive boxplot outlierValues', () => {
  const values = [1, 2, 3, 4, 5, 100]; // Q1~Q3 근방 정상, 100은 이상치
  const rows = values.map((v, i) => datasetRow(i, 'v', v));
  const resultWithGatePassed: AnalyzeResult = {
    continuous: [{
      variableKey: 'v', kind: 'continuous', suppressed: false,
      n: 6, missingCount: 0, missingPatterns: [],
      mean: 19.17, sd: null, median: 3.5, q1: 2, q3: 4.75, iqr: 2.75,
      skewness: null, kurtosis: null, min: 1, max: 100, nullReasons: {},
      boxplot: { q1: 2, median: 3.5, q3: 4.75, lowerWhisker: 1, upperWhisker: 5, outlierCount: 1 },
    }],
    discrete: [],
  };

  it('hasAccess=false면 항상 no-op(원본 그대로, attached:false)', () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = attachLimitedRowFields(ctx, resultWithGatePassed, false);
    expect(outcome.attached).toBe(false);
    expect(outcome.result).toBe(resultWithGatePassed); // 참조까지 그대로(진짜 no-op)
  });

  it('hasAccess=true이고 outlierCount가 있으면 outlierValues를 계산해 붙인다', () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = attachLimitedRowFields(ctx, resultWithGatePassed, true);
    expect(outcome.attached).toBe(true);
    const boxplot = outcome.result.continuous[0].suppressed ? undefined : outcome.result.continuous[0].boxplot;
    expect(boxplot?.outlierValues).toEqual([100]);
  });

  it('원본 result 객체를 mutate하지 않는다(새 객체 조립)', () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const before = JSON.parse(JSON.stringify(resultWithGatePassed));
    attachLimitedRowFields(ctx, resultWithGatePassed, true);
    expect(resultWithGatePassed).toEqual(before);
  });

  it('outlierCount가 없는(gate 실패) 변수는 손대지 않는다', () => {
    const gateFailedResult: AnalyzeResult = {
      continuous: [{
        ...resultWithGatePassed.continuous[0],
        boxplot: { q1: 2, median: 3.5, q3: 4.75, lowerWhisker: 1, upperWhisker: 5 }, // outlierCount 없음
      }],
      discrete: [],
    } as AnalyzeResult;
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = attachLimitedRowFields(ctx, gateFailedResult, true);
    expect(outcome.attached).toBe(false);
    const c = outcome.result.continuous[0];
    expect(c.suppressed ? undefined : c.boxplot && 'outlierValues' in c.boxplot).toBeFalsy();
  });

  // 코드리뷰로 발견(2026-09-11) — {...result, continuous, bivariate} 형태로 반환하면
  // descriptive 모드처럼 원래 bivariate 필드 자체가 없던 result에도 값이
  // undefined인 bivariate 키가 새로 생긴다. finalizeAnalyzeResponse가 attached:true일
  // 때 이 result를 canonicalDigest()에 넘기는데, canonicalDigest는 Object.entries로
  // 모든 키(undefined 값 포함)를 순회하다 undefined를 만나면 throw한다(JSON.stringify와
  // 달리 undefined 키를 조용히 생략하지 않음) — 즉 이 조합(descriptive+outlierCount
  // 존재+limited_row 권한)의 실제 HTTP 요청은 지금까지 전부 500이었을 잠재 결함이었다.
  it('원래 bivariate 필드가 없던 result엔 bivariate:undefined 키를 새로 만들지 않는다(canonicalDigest 500 회귀 방지)', () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = attachLimitedRowFields(ctx, resultWithGatePassed, true);
    expect(outcome.attached).toBe(true);
    expect('bivariate' in outcome.result).toBe(false);
    expect(() => canonicalDigest({ result: outcome.result })).not.toThrow();
  });

  it('suppressed:true 변수는 손대지 않는다', () => {
    const suppressedResult: AnalyzeResult = {
      continuous: [{ variableKey: 'v', kind: 'continuous', suppressed: true }],
      discrete: [],
    };
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = attachLimitedRowFields(ctx, suppressedResult, true);
    expect(outcome.attached).toBe(false);
  });
});

describe('attachLimitedRowFields — 상관행렬은 해당 없음(no-op)', () => {
  it('result.correlationMatrix가 있어도 손대지 않는다(limited_row 필드 자체가 없음)', () => {
    const result: AnalyzeResult = {
      continuous: [], discrete: [],
      correlationMatrix: {
        method: 'pearson_correlation', variableKeys: ['a', 'b', 'c'],
        cells: [{ suppressed: false, xKey: 'a', yKey: 'b', n: 50, r: 0.5, pValue: 0.01, adjustedP: 0.01 }],
        adjustedPWithheld: false,
      },
    };
    const ctx = baseCtx();
    const outcome = attachLimitedRowFields(ctx, result, true);
    expect(outcome.attached).toBe(false);
    expect(outcome.result.correlationMatrix).toEqual(result.correlationMatrix);
  });
});

describe('attachLimitedRowFields — 상관(pearson/spearman) scatter.points', () => {
  function makePairs(n: number): PairedRow[] {
    return Array.from({ length: n }, (_, i) => ({ caseId: `c${i}`, personClusterKey: `p${i}`, x: i, y: i * 2 }));
  }

  it('scatter가 있으면 points를 채우고 displayedCount를 갱신한다', () => {
    const pairs = makePairs(50);
    const result: AnalyzeResult = {
      continuous: [], discrete: [],
      bivariate: {
        method: 'pearson_correlation', suppressed: false,
        n: 50, statistic: 0.99, df: 48, pValue: 0.0001,
        effectSizes: [], nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.0001 },
        qualityFlags: [], extra: {}, excludedCaseCount: 0, exclusions: [],
        scatter: { displayedCount: 50, totalCount: 50 }, // grid만 있고 points는 아직 없음
      },
    };
    const ctx = baseCtx({
      recipe: { ...baseCtx().recipe, variableKeys: ['x', 'y'], analysisMode: 'bivariate', requestedMethod: 'pearson_correlation' },
      paired: { pairs, includedCaseCount: 50, includedPersonCount: 50, excludedCaseCount: 0, excludedPersonCount: 0, exclusions: [] },
    });
    const outcome = attachLimitedRowFields(ctx, result, true);
    expect(outcome.attached).toBe(true);
    const bivariate = outcome.result.bivariate;
    expect(bivariate && !bivariate.suppressed && bivariate.scatter?.points).toHaveLength(50);
  });

  it('hasAccess=false면 scatter.points를 붙이지 않는다', () => {
    const pairs = makePairs(50);
    const result: AnalyzeResult = {
      continuous: [], discrete: [],
      bivariate: {
        method: 'pearson_correlation', suppressed: false,
        n: 50, statistic: 0.99, df: 48, pValue: 0.0001,
        effectSizes: [], nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.0001 },
        qualityFlags: [], extra: {}, excludedCaseCount: 0, exclusions: [],
        scatter: { displayedCount: 50, totalCount: 50 },
      },
    };
    const ctx = baseCtx({
      recipe: { ...baseCtx().recipe, variableKeys: ['x', 'y'], analysisMode: 'bivariate', requestedMethod: 'pearson_correlation' },
      paired: { pairs, includedCaseCount: 50, includedPersonCount: 50, excludedCaseCount: 0, excludedPersonCount: 0, exclusions: [] },
    });
    const outcome = attachLimitedRowFields(ctx, result, false);
    expect(outcome.attached).toBe(false);
  });
});

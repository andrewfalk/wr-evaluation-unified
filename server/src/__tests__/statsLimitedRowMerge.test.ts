// PR3-B §9 — attachLimitedRowFields(응답시점 merge). 대상 필드는 boxplot
// outlierValues(descriptive/그룹별)와 scatter 원시 points 2종뿐(상관행렬은 해당
// 없음). hasAccess=false면 항상 no-op, 원본 객체를 mutate하지 않는지, gate가
// 실패한(outlierCount 없는) 변수는 건드리지 않는지를 검증한다.
//
// PR4-A2 — regression 분기(§4 "limited_row 진단값")도 이 파일에서 검증한다.
// runRegressionDiagnosticsEngine을 mock해 5단계 pointDiagnosticsStatus 전환을
// 직접 확인한다: 권한 없음/모형 미지원은 엔진을 아예 안 부르고, 권한 있음+
// 모형 지원일 때만 실제로 호출해 성공/실패를 각각 available/unavailable_
// computation_failed로 반영한다.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { PairedRow } from '../statsBivariateDataset';
import type { AnalyzeResult, AnalyzeRegressionResult } from '@wr/contracts';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { RegressionDesignMatrix } from '../statsRegressionDesign';
import { canonicalDigest } from '../canonicalSerializer';

const runRegressionDiagnosticsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runRegressionDiagnosticsEngine: (...args: unknown[]) => runRegressionDiagnosticsEngine(...args) };
});

beforeEach(() => { vi.clearAllMocks(); });

import { attachLimitedRowFields } from '../statsLimitedRowMerge';

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
    regressionDisclosed: false, regressionDesign: null, regressionExcludedRowCount: null, regressionMethod: null,
    predictionDisclosed: false, predictionState: null,
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

  it('hasAccess=false면 항상 no-op(원본 그대로, attached:false)', async () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = await attachLimitedRowFields(ctx, resultWithGatePassed, false);
    expect(outcome.attached).toBe(false);
    expect(outcome.result).toBe(resultWithGatePassed); // 참조까지 그대로(진짜 no-op)
  });

  it('hasAccess=true이고 outlierCount가 있으면 outlierValues를 계산해 붙인다', async () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = await attachLimitedRowFields(ctx, resultWithGatePassed, true);
    expect(outcome.attached).toBe(true);
    const boxplot = outcome.result.continuous[0].suppressed ? undefined : outcome.result.continuous[0].boxplot;
    expect(boxplot?.outlierValues).toEqual([100]);
  });

  it('원본 result 객체를 mutate하지 않는다(새 객체 조립)', async () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const before = JSON.parse(JSON.stringify(resultWithGatePassed));
    await attachLimitedRowFields(ctx, resultWithGatePassed, true);
    expect(resultWithGatePassed).toEqual(before);
  });

  it('outlierCount가 없는(gate 실패) 변수는 손대지 않는다', async () => {
    const gateFailedResult: AnalyzeResult = {
      continuous: [{
        ...resultWithGatePassed.continuous[0],
        boxplot: { q1: 2, median: 3.5, q3: 4.75, lowerWhisker: 1, upperWhisker: 5 }, // outlierCount 없음
      }],
      discrete: [],
    } as AnalyzeResult;
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = await attachLimitedRowFields(ctx, gateFailedResult, true);
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
  it('원래 bivariate 필드가 없던 result엔 bivariate:undefined 키를 새로 만들지 않는다(canonicalDigest 500 회귀 방지)', async () => {
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = await attachLimitedRowFields(ctx, resultWithGatePassed, true);
    expect(outcome.attached).toBe(true);
    expect('bivariate' in outcome.result).toBe(false);
    expect(() => canonicalDigest({ result: outcome.result })).not.toThrow();
  });

  it('suppressed:true 변수는 손대지 않는다', async () => {
    const suppressedResult: AnalyzeResult = {
      continuous: [{ variableKey: 'v', kind: 'continuous', suppressed: true }],
      discrete: [],
    };
    const ctx = baseCtx({ dataset: { ...baseCtx().dataset, rows } });
    const outcome = await attachLimitedRowFields(ctx, suppressedResult, true);
    expect(outcome.attached).toBe(false);
  });
});

describe('attachLimitedRowFields — 상관행렬은 해당 없음(no-op)', () => {
  it('result.correlationMatrix가 있어도 손대지 않는다(limited_row 필드 자체가 없음)', async () => {
    const result: AnalyzeResult = {
      continuous: [], discrete: [],
      correlationMatrix: {
        method: 'pearson_correlation', variableKeys: ['a', 'b', 'c'],
        cells: [{ suppressed: false, xKey: 'a', yKey: 'b', n: 50, r: 0.5, pValue: 0.01, adjustedP: 0.01 }],
        adjustedPWithheld: false,
      },
    };
    const ctx = baseCtx();
    const outcome = await attachLimitedRowFields(ctx, result, true);
    expect(outcome.attached).toBe(false);
    expect(outcome.result.correlationMatrix).toEqual(result.correlationMatrix);
  });
});

describe('attachLimitedRowFields — 상관(pearson/spearman) scatter.points', () => {
  function makePairs(n: number): PairedRow[] {
    return Array.from({ length: n }, (_, i) => ({ caseId: `c${i}`, personClusterKey: `p${i}`, x: i, y: i * 2 }));
  }

  it('scatter가 있으면 points를 채우고 displayedCount를 갱신한다', async () => {
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
    const outcome = await attachLimitedRowFields(ctx, result, true);
    expect(outcome.attached).toBe(true);
    const bivariate = outcome.result.bivariate;
    expect(bivariate && !bivariate.suppressed && bivariate.scatter?.points).toHaveLength(50);
  });

  it('hasAccess=false면 scatter.points를 붙이지 않는다', async () => {
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
    const outcome = await attachLimitedRowFields(ctx, result, false);
    expect(outcome.attached).toBe(false);
  });
});

describe('attachLimitedRowFields — regression pointDiagnostics(PR4-A2)', () => {
  function makeRegressionDesign(overrides: Partial<RegressionDesignMatrix> = {}): RegressionDesignMatrix {
    return {
      y: [1, 2, 3, 4],
      x: [[1, 0], [1, 1], [1, 0], [1, 1]],
      columns: [
        { name: 'intercept', label: '절편', variableKey: null, level: null, termType: 'main', interactionOf: null },
        { name: 'x1', label: 'x1 변수', variableKey: 'x1', level: null, termType: 'main', interactionOf: null },
      ],
      personClusterKeys: ['p1', 'p2', 'p3', 'p4'],
      caseIds: ['c1', 'c2', 'c3', 'c4'],
      referenceLevelsUsed: {},
      method: 'ols_linear',
      eventLevel: null,
      qualityFlags: [],
      standardizedPredictorKeys: [],
      standardization: {},
      splineKnots: {},
      ...overrides,
    };
  }

  function makeRegressionResult(diagnosticsOverrides: Partial<NonNullable<Extract<AnalyzeRegressionResult, { suppressed: false }>['diagnostics']>> = {}): AnalyzeResult {
    return {
      continuous: [], discrete: [],
      regression: {
        suppressed: false, estimation: 'ok', method: 'ols_linear', outcomeKey: 'y',
        eventLevel: null, referenceLevelsUsed: {}, covariance: 'hc3',
        inferenceDistribution: 't', inferenceDf: 2, residualDf: 2, n: 4, personCount: 4,
        clusterCount: null, maxClusterShare: null,
        terms: [
          { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: 1.0, se: 0.1, statistic: 10, pValue: 0.01, ciLower: 0.8, ciUpper: 1.2, exponentiated: null, termType: 'main', interactionOf: null },
          { name: 'x1', label: 'x1 변수', variableKey: 'x1', level: null, estimate: 1.5, se: 0.3, statistic: 5, pValue: 0.01, ciLower: 0.9, ciUpper: 2.1, exponentiated: null, termType: 'main', interactionOf: null },
        ],
        fit: { r2: 0.9, adjR2: 0.85, logLik: null, aic: null, pseudoR2: null },
        nonEstimableReason: null, inferenceWithheldReason: null, excludedRowCount: 0, qualityFlags: [],
        analysisUnitNote: 'note',
        diagnostics: {
          conditionNumber: 1.5, vif: [{ variableKey: 'x1', termName: 'x1', vif: 1.0 }],
          pointDiagnosticsSupported: true, pointDiagnosticsUnsupportedReason: null,
          pointDiagnosticsStatus: 'not_requested', displayedPointCount: null, totalPointCount: 4,
          ...diagnosticsOverrides,
        },
        standardizedPredictorKeys: [], standardization: null, splinePartialEffects: [],
      },
    };
  }

  it('hasAccess=false면 엔진을 호출하지 않고 unavailable_no_access로 전환한다', async () => {
    const ctx = baseCtx({ regressionDesign: { ok: true, design: makeRegressionDesign() } });
    const outcome = await attachLimitedRowFields(ctx, makeRegressionResult(), false);
    expect(runRegressionDiagnosticsEngine).not.toHaveBeenCalled();
    expect(outcome.attached).toBe(false);
    const regression = outcome.result.regression;
    expect(regression && !regression.suppressed && regression.diagnostics?.pointDiagnosticsStatus).toBe('unavailable_no_access');
  });

  it('모형이 미지원(pointDiagnosticsSupported=false)이면 권한이 있어도 엔진을 호출하지 않는다', async () => {
    const ctx = baseCtx({ regressionDesign: { ok: true, design: makeRegressionDesign() } });
    const result = makeRegressionResult({
      pointDiagnosticsSupported: false, pointDiagnosticsUnsupportedReason: 'NEAR_SINGULAR_LEVERAGE',
      pointDiagnosticsStatus: 'unavailable_model',
    });
    const outcome = await attachLimitedRowFields(ctx, result, true);
    expect(runRegressionDiagnosticsEngine).not.toHaveBeenCalled();
    expect(outcome.attached).toBe(false);
    const regression = outcome.result.regression;
    expect(regression && !regression.suppressed && regression.diagnostics?.pointDiagnosticsStatus).toBe('unavailable_model');
  });

  it('권한 있음+모형 지원+엔진 성공 → available, pointDiagnostics·표시개수 채움', async () => {
    runRegressionDiagnosticsEngine.mockResolvedValueOnce({
      pointDiagnosticsSupported: true, pointDiagnosticsUnsupportedReason: null,
      points: [
        { rowIndex: 0, fittedValue: 1.0, residual: 0.0, leverage: 0.25, standardizedResidual: 0.0, cooksDistance: 0.0, theoreticalQuantile: -1.0 },
        { rowIndex: 1, fittedValue: 2.5, residual: -0.5, leverage: 0.25, standardizedResidual: -0.4, cooksDistance: 0.02, theoreticalQuantile: -0.3 },
      ],
    });
    const ctx = baseCtx({ regressionDesign: { ok: true, design: makeRegressionDesign() } });
    const outcome = await attachLimitedRowFields(ctx, makeRegressionResult(), true);
    expect(runRegressionDiagnosticsEngine).toHaveBeenCalledTimes(1);
    const call = runRegressionDiagnosticsEngine.mock.calls[0][0];
    expect(call.beta).toEqual([1.0, 1.5]); // terms를 name으로 매칭해 columns 순서로 재구성
    expect(outcome.attached).toBe(true);
    const regression = outcome.result.regression;
    if (regression && !regression.suppressed) {
      expect(regression.diagnostics?.pointDiagnosticsStatus).toBe('available');
      expect(regression.diagnostics?.pointDiagnostics).toHaveLength(2);
      expect(regression.diagnostics?.displayedPointCount).toBe(4);
      expect(regression.diagnostics?.totalPointCount).toBe(4);
    }
  });

  it('엔진 호출 실패 시 unavailable_computation_failed로 전환하되 계수·적합도는 그대로 보존한다', async () => {
    runRegressionDiagnosticsEngine.mockRejectedValueOnce(new Error('engine crashed'));
    const ctx = baseCtx({ regressionDesign: { ok: true, design: makeRegressionDesign() } });
    const outcome = await attachLimitedRowFields(ctx, makeRegressionResult(), true);
    expect(outcome.attached).toBe(false);
    const regression = outcome.result.regression;
    if (regression && !regression.suppressed) {
      expect(regression.diagnostics?.pointDiagnosticsStatus).toBe('unavailable_computation_failed');
      expect(regression.diagnostics?.pointDiagnostics).toBeUndefined();
      // 계수·적합도는 보존된다(순수 계산 실패이지 전체 응답 실패가 아니다).
      expect(regression.terms).toHaveLength(2);
      expect(regression.fit?.r2).toBe(0.9);
    }
  });

  it('suppressed:true regression은 손대지 않는다', async () => {
    const ctx = baseCtx();
    const result: AnalyzeResult = { continuous: [], discrete: [], regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' } };
    const outcome = await attachLimitedRowFields(ctx, result, true);
    expect(runRegressionDiagnosticsEngine).not.toHaveBeenCalled();
    expect(outcome.attached).toBe(false);
    expect(outcome.result.regression).toEqual(result.regression);
  });

  it('원래 regression 필드가 없던 result엔 regression:undefined 키를 새로 만들지 않는다', async () => {
    const ctx = baseCtx();
    const result: AnalyzeResult = { continuous: [], discrete: [] };
    const outcome = await attachLimitedRowFields(ctx, result, true);
    expect('regression' in outcome.result).toBe(false);
    expect(() => canonicalDigest({ result: outcome.result })).not.toThrow();
  });
});

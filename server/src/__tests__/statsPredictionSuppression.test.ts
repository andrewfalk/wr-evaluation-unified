// PR4-B2 — computePredictionAnalyzeResult(③비추정 판정 재확인→④엔진→곡선
// 공개통제→조립) 단위테스트. runPredictionStatsEngine을 mock해 non_estimable
// 조기반환(Python 미호출)·metric withheldReason 파생·caveats 조건부(SAME_ASSESSOR_
// FINDINGS)·buildPredictionEngineRequestForState 공유 빌더를 직접 확인한다.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runPredictionStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runPredictionStatsEngine: (...args: unknown[]) => runPredictionStatsEngine(...args) };
});

beforeEach(() => { vi.clearAllMocks(); });

import { computePredictionAnalyzeResult, buildPredictionEngineRequestForState } from '../statsPredictionSuppression';
import type { AnalysisContext, PredictionAnalysisState } from '../statsAnalysisContext';
import type { PredictionDesignMatrix } from '../statsPredictionDesign';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

function extracted(value: unknown) {
  return { value, missing: null, qualityFlags: [] };
}

function makeRows(spec: Array<{ y: boolean; person: string; x1: number }>): DatasetRow[] {
  return spec.map((s, i) => ({
    caseId: `c${i}`,
    personClusterKey: s.person,
    cohortPersonKey: s.person,
    values: { outcome: extracted(s.y), x1: extracted(s.x1) },
  }));
}

function makeDesign(rows: DatasetRow[]): PredictionDesignMatrix {
  return {
    x: rows.map((r) => [r.values.x1.value as number]),
    columns: [{ name: 'x1', variableKey: 'x1', level: null }],
    columnCount: 1,
    parameterCount: 1,
  };
}

function makeState(overrides: Partial<PredictionAnalysisState> = {}): PredictionAnalysisState {
  const rows = makeRows([
    { y: true, person: 'p1', x1: 1 },
    { y: false, person: 'p2', x1: 2 },
    { y: true, person: 'p3', x1: 3 },
    { y: false, person: 'p4', x1: 4 },
  ]);
  const outerFoldAssignment = new Map<number, Map<string, number>>([
    [1, new Map([['p1', 0], ['p2', 1], ['p3', 0], ['p4', 1]])],
  ]);
  return {
    outcomeKey: 'outcome',
    eventLevel: 'true',
    predictorKeys: ['x1'],
    s2Rows: rows,
    cohortDigest: 'cohort-digest',
    outerFoldAssignment,
    outerFoldCount: 2,
    nonEstimableCheck: { reason: null, columnCount: 1, parameterCount: 1, design: makeDesign(rows) },
    personCount: 4,
    eventPersonCount: 2,
    nonEventPersonCount: 2,
    excludedRowCount: 0,
    ...overrides,
  };
}

function makeCtx(state: PredictionAnalysisState | null, catalogByKey: Map<string, AnalyticsVariableMetadata> = new Map()): AnalysisContext {
  return {
    orgId: 'org', userId: 'user',
    recipe: {
      grain: 'case', variableKeys: ['x1', 'outcome'], filters: [], analysisPurpose: 'prediction',
      formulaPolicies: {}, analysisMode: 'prediction', requestedMethod: 'l2_logistic',
      prediction: { outcomeKey: 'outcome', eventLevel: 'true' },
    } as unknown as AnalysisContext['recipe'],
    catalogByKey,
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: {} as AnalysisContext['dataset'],
    requestSuppressed: false, reasonCode: null,
    paired: null, pairDisclosed: false, availableMethods: [], methodCatalogVersion: null,
    correlationMatrixPairs: null, correlationMatrixVariables: null,
    regressionDisclosed: false, regressionDesign: null, regressionExcludedRowCount: null, regressionMethod: null,
    predictionDisclosed: true,
    predictionState: state,
  };
}

describe('computePredictionAnalyzeResult — non_estimable(Node ①~⑩ 판정, Python 미호출)', () => {
  it('nonEstimableCheck.reason이 있으면 엔진을 호출하지 않고 non_estimable을 반환한다', async () => {
    const state = makeState({ nonEstimableCheck: { reason: 'INSUFFICIENT_PERSONS', columnCount: null, parameterCount: null, design: null } });
    const ctx = makeCtx(state);
    const result = await computePredictionAnalyzeResult(ctx);
    expect(runPredictionStatsEngine).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      suppressed: false, estimation: 'non_estimable', nonEstimableReason: 'INSUFFICIENT_PERSONS',
      metrics: [], aucCi: null, curves: null, coefficients: null, lambda: { selected: null },
    });
  });

  it('ctx.predictionState가 null이면 호출 순서 위반으로 throw한다', async () => {
    await expect(computePredictionAnalyzeResult(makeCtx(null))).rejects.toThrow(/호출 순서 위반/);
  });
});

describe('computePredictionAnalyzeResult — ok 경로', () => {
  function okRaw(overrides: Partial<Record<string, unknown>> = {}) {
    const metric = (apparent: number) => ({
      apparent, representativeRepeat: apparent,
      cv: { status: 'ok' as const, validRepeats: 5, totalRepeats: 5, mean: apparent, min: apparent, max: apparent },
      bootstrap: { status: 'ok' as const, validReplicates: 200, totalReplicates: 200, optimism: 0.01, corrected: apparent - 0.01 },
    });
    return {
      estimation: 'ok' as const,
      nonEstimableReason: null,
      lambdaSelected: 0.1,
      metrics: {
        roc_auc: metric(0.8), average_precision: metric(0.7), brier: metric(0.2),
        calibration_intercept: metric(0.0), calibration_slope: metric(1.0),
      },
      aucCi: { target: 'roc_auc_cv_mean' as const, lower: 0.6, upper: 0.9, method: 'person_bootstrap_oof_conditional' as const, replicates: 1000 },
      oofRepresentative: [{ row: 0, p: 0.1 }, { row: 1, p: 0.2 }, { row: 2, p: 0.8 }, { row: 3, p: 0.9 }],
      intercept: -0.5,
      coefficients: [1.2],
      droppedColumnFoldCount: 0,
      flags: [],
      ...overrides,
    };
  }

  it('정상 응답이면 estimation:"ok"로 metrics/coefficients/aucCi를 조립한다', async () => {
    runPredictionStatsEngine.mockResolvedValueOnce(okRaw());
    const state = makeState();
    const ctx = makeCtx(state);
    const result = await computePredictionAnalyzeResult(ctx);

    expect(runPredictionStatsEngine).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ suppressed: false, estimation: 'ok', personCount: 4, eventPersonCount: 2, prevalence: 0.5, n: 4 });
    if (result.suppressed === false && result.estimation === 'ok') {
      expect(result.lambda.selected).toBe(0.1);
      expect(result.coefficients).toEqual({ intercept: -0.5, terms: [{ term: 'x1', variableKey: 'x1', level: null, standardizedBeta: 1.2 }] });
      expect(result.metrics.find((m) => m.metric === 'roc_auc')).toMatchObject({
        apparent: 0.8, cv: { status: 'ok', withheldReason: null }, bootstrap: { status: 'ok', withheldReason: null, correctedOutOfRange: false },
      });
      expect(result.aucCi).toEqual(okRaw().aucCi);
      // 캐비어트 — SAME_ASSESSOR_FINDINGS는 clinician_judgment predictor가 없으므로 빠진다.
      expect(result.caveats).not.toContain('SAME_ASSESSOR_FINDINGS');
      expect(result.caveats).toContain('RESEARCH_INTERNAL_VALIDATION');
      expect(result.notPerformed).toEqual(['temporal_holdout', 'subgroup', 'external_validation']);
    }
  });

  it('clinician_judgment provenance predictor가 선택되면 SAME_ASSESSOR_FINDINGS를 붙인다', async () => {
    runPredictionStatsEngine.mockResolvedValueOnce(okRaw());
    const catalogByKey = new Map<string, AnalyticsVariableMetadata>([
      ['x1', { provenance: 'clinician_judgment' } as AnalyticsVariableMetadata],
    ]);
    const ctx = makeCtx(makeState(), catalogByKey);
    const result = await computePredictionAnalyzeResult(ctx);
    if (result.suppressed === false) {
      expect(result.caveats).toContain('SAME_ASSESSOR_FINDINGS');
    } else {
      throw new Error('expected suppressed:false');
    }
  });

  it('cv.status가 withheld면 withheldReason:LOW_VALID_REPEATS, bootstrap withheld+apparent null이면 APPARENT_UNAVAILABLE', async () => {
    runPredictionStatsEngine.mockResolvedValueOnce(okRaw({
      metrics: {
        roc_auc: {
          apparent: null, representativeRepeat: null,
          cv: { status: 'withheld', validRepeats: 1, totalRepeats: 5, mean: null, min: null, max: null },
          bootstrap: { status: 'withheld', validReplicates: 0, totalReplicates: 200, optimism: null, corrected: null },
        },
        average_precision: okRaw().metrics.average_precision,
        brier: okRaw().metrics.brier,
        calibration_intercept: okRaw().metrics.calibration_intercept,
        calibration_slope: okRaw().metrics.calibration_slope,
      },
      aucCi: null,
    }));
    const ctx = makeCtx(makeState());
    const result = await computePredictionAnalyzeResult(ctx);
    if (result.suppressed === false && result.estimation === 'ok') {
      const rocAuc = result.metrics.find((m) => m.metric === 'roc_auc')!;
      expect(rocAuc.cv).toMatchObject({ status: 'withheld', withheldReason: 'LOW_VALID_REPEATS' });
      expect(rocAuc.bootstrap).toMatchObject({ status: 'withheld', withheldReason: 'APPARENT_UNAVAILABLE' });
    }
  });

  it('bootstrap withheld+apparent 존재면 withheldReason:LOW_VALID_REPLICATES', async () => {
    runPredictionStatsEngine.mockResolvedValueOnce(okRaw({
      metrics: {
        ...okRaw().metrics,
        roc_auc: {
          apparent: 0.8, representativeRepeat: 0.8,
          cv: { status: 'ok', validRepeats: 5, totalRepeats: 5, mean: 0.75, min: 0.7, max: 0.8 },
          bootstrap: { status: 'withheld', validReplicates: 100, totalReplicates: 200, optimism: null, corrected: null },
        },
      },
    }));
    const ctx = makeCtx(makeState());
    const result = await computePredictionAnalyzeResult(ctx);
    if (result.suppressed === false && result.estimation === 'ok') {
      const rocAuc = result.metrics.find((m) => m.metric === 'roc_auc')!;
      expect(rocAuc.bootstrap).toMatchObject({ status: 'withheld', withheldReason: 'LOW_VALID_REPLICATES' });
    }
  });

  it('correctedOutOfRange — bounded metric(roc_auc)이 [0,1] 밖이면 true, unbounded(calibration_slope)는 항상 false', async () => {
    runPredictionStatsEngine.mockResolvedValueOnce(okRaw({
      metrics: {
        ...okRaw().metrics,
        roc_auc: {
          apparent: 0.8, representativeRepeat: 0.8,
          cv: { status: 'ok', validRepeats: 5, totalRepeats: 5, mean: 0.75, min: 0.7, max: 0.8 },
          bootstrap: { status: 'ok', validReplicates: 200, totalReplicates: 200, optimism: -0.15, corrected: 1.05 },
        },
        calibration_slope: {
          apparent: 1.0, representativeRepeat: 1.0,
          cv: { status: 'ok', validRepeats: 5, totalRepeats: 5, mean: 1.0, min: 0.9, max: 1.1 },
          bootstrap: { status: 'ok', validReplicates: 200, totalReplicates: 200, optimism: -0.5, corrected: 1.6 },
        },
      },
    }));
    const ctx = makeCtx(makeState());
    const result = await computePredictionAnalyzeResult(ctx);
    if (result.suppressed === false && result.estimation === 'ok') {
      expect(result.metrics.find((m) => m.metric === 'roc_auc')!.bootstrap.correctedOutOfRange).toBe(true);
      expect(result.metrics.find((m) => m.metric === 'calibration_slope')!.bootstrap.correctedOutOfRange).toBe(false);
    }
  });
});

describe('computePredictionAnalyzeResult — 엔진이 non_estimable(NOT_CONVERGED)을 반환하는 경우', () => {
  it('raw.estimation==="non_estimable"이면 NOT_CONVERGED로 변환한다', async () => {
    runPredictionStatsEngine.mockResolvedValueOnce({
      estimation: 'non_estimable', nonEstimableReason: 'NOT_CONVERGED', lambdaSelected: null,
      metrics: {}, aucCi: null, oofRepresentative: null, intercept: null, coefficients: null,
      droppedColumnFoldCount: 2, flags: [],
    });
    const ctx = makeCtx(makeState());
    const result = await computePredictionAnalyzeResult(ctx);
    expect(result).toMatchObject({
      estimation: 'non_estimable', nonEstimableReason: 'NOT_CONVERGED', metrics: [], aucCi: null,
      curves: null, coefficients: null, droppedColumnFoldCount: 2,
    });
  });
});

describe('buildPredictionEngineRequestForState — 사전검사·실행이 정확히 같은 요청을 쓴다', () => {
  it('state.s2Rows/design으로부터 y·groups·columnNames를 정확히 만든다', () => {
    const state = makeState();
    const design = state.nonEstimableCheck.design!;
    const { request, y, groups } = buildPredictionEngineRequestForState(state, design);
    expect(y).toEqual([1, 0, 1, 0]); // outcome=true/false, eventLevel='true'
    expect(groups).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(request.columnNames).toEqual(['x1']);
    expect(request.X).toEqual([[1], [2], [3], [4]]);
    expect(request.outerFoldCount).toBe(2);
    expect(request.outerFolds).toEqual([[0, 1, 0, 1]]);
  });
});

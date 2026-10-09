// 제한데이터(stats.export_limited_rows) 권한자의 예측 소수 셀(1~9명) 해제 — 단위 테스트.
// 풀리는 것: 공개통제 ②(S1/S2 사건·비사건·양쪽, 레벨, 제외 집합 E/F/B, 전체 N<10)와 곡선의 소수 인원 구간 병합.
// 안 풀리는 것: ③ 통계적 추정 가능 조건(최소 50명·사건/비사건 각 25·EPV 등) — 사건이 1~9명이면 "억제"가
// "사건/비사건 인원 부족" 사유로 바뀐다. 엔진(수 분)은 한 번만 돌려 일반본·해제본을 함께 조립한다.
// 실제 Postgres·Python 경로는 statsPredictionLimitedDisclosure.integration.test.ts가 증명한다.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

const runPredictionStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runPredictionStatsEngine: (...args: unknown[]) => runPredictionStatsEngine(...args) };
});

import { evaluatePredictionDisclosure } from '../statsPredictionCohort';
import { computePredictionCurves, type PredictionCurveRow } from '../statsPredictionDisclosure';
import {
  assemblePredictionResult, computePredictionAnalyzeResult, computePredictionViews, runPredictionEngineStage,
} from '../statsPredictionSuppression';
import type { AnalysisContext, PredictionAnalysisState } from '../statsAnalysisContext';
import type { PredictionDesignMatrix } from '../statsPredictionDesign';
import type { DatasetRow } from '../statsDatasetBuilder';

beforeEach(() => { vi.resetAllMocks(); });

const set = (n: number, prefix = 'p') => new Set(Array.from({ length: n }, (_, i) => `${prefix}${i}`));

describe('evaluatePredictionDisclosure — lifted', () => {
  // 사건 3명(소수 셀)인 코호트 — S1/S2 사건·서로소 사건·교집합 등 여러 검사가 걸린다.
  const input = {
    s1EventNonEvent: { pPlus: set(3), pMinus: set(97, 'n') },
    s2EventNonEvent: { pPlus: set(3), pMinus: set(97, 'n') },
    s2PersonCount: 100,
    s2LevelSummaries: [{ variableKey: 'g', level: 'a', personCount: 4 }],
    excludedPersonSets: { E: set(2, 'e'), F: new Set<string>(), B: new Set<string>() },
  };

  it('제한 모드는 소수 셀이 있으면 억제하고, 옵션이 없거나 lifted:false도 같다(기존 동작 불변)', () => {
    const expected = { disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' };
    expect(evaluatePredictionDisclosure(input)).toEqual(expected);
    expect(evaluatePredictionDisclosure(input, {})).toEqual(expected);
    expect(evaluatePredictionDisclosure(input, { lifted: false })).toEqual(expected);
  });

  it('해제 모드는 모든 소수 셀 조건이 걸려 있어도 공개로 통과한다', () => {
    expect(evaluatePredictionDisclosure(input, { lifted: true })).toEqual({ disclose: true, reasonCode: null });
  });
});

describe('computePredictionCurves — lifted', () => {
  // 100행(각자 다른 사람): 예측값이 클수록 사건 — 상위 구간에 사건이 3명뿐이라 제한 모드에서는 이웃 구간으로 병합된다.
  const rows: PredictionCurveRow[] = Array.from({ length: 100 }, (_, i) => ({
    row: i, p: (i + 1) / 101, y: (i >= 97 ? 1 : 0) as 0 | 1, cohortPersonKey: `p${i}`,
  }));

  it('제한 모드는 소수 인원 구간을 병합하고, 해제 모드는 병합 없이 후보 구간을 그대로 공개한다', () => {
    const restricted = computePredictionCurves(rows);
    const lifted = computePredictionCurves(rows, { lifted: true });

    expect(lifted.suppressedReason).toBeNull();
    expect(lifted.bins).toHaveLength(20); // curveCandidateBins — 병합 없음
    // 해제본에는 사건이 1~9명인 구간이 그대로 보인다(제한 모드에서는 공개 불가라 병합되거나 억제됐을 구간).
    expect(lifted.bins!.some((b) => b.positiveRows >= 1 && b.positiveRows <= 9)).toBe(true);
    // 제한 모드는 같은 입력을 병합하므로 구간이 더 적거나 아예 억제된다.
    if (restricted.bins !== null) expect(restricted.bins.length).toBeLessThan(lifted.bins!.length);
  });

  it('옵션이 없으면 기존 동작이다', () => {
    expect(computePredictionCurves(rows)).toEqual(computePredictionCurves(rows, { lifted: false }));
  });

  it('동점이 많아 구간이 최소 구간 수 미만이면 해제 모드에서도 곡선은 억제된다(곡선 품질 조건은 유지)', () => {
    const tied: PredictionCurveRow[] = Array.from({ length: 100 }, (_, i) => ({
      row: i, p: i < 50 ? 0.2 : 0.8, y: (i % 2) as 0 | 1, cohortPersonKey: `p${i}`,
    }));
    expect(computePredictionCurves(tied, { lifted: true })).toEqual({ bins: null, suppressedReason: 'MIN_DISCLOSABLE_BINS_NOT_MET' });
  });
});

// ---------------------------------------------------------------------------
// 일반본·해제본 조립
// ---------------------------------------------------------------------------
function extracted(value: unknown) {
  return { value, missing: null, qualityFlags: [] };
}
function makeRows(n: number): DatasetRow[] {
  return Array.from({ length: n }, (_, i) => ({
    caseId: `c${i}`,
    personClusterKey: `p${i}`,
    cohortPersonKey: `p${i}`,
    values: { outcome: extracted(i >= n - 3), x1: extracted(i) },
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
function makeState(over: Partial<PredictionAnalysisState> = {}): PredictionAnalysisState {
  const rows = makeRows(100);
  return {
    outcomeKey: 'outcome', eventLevel: 'true', predictorKeys: ['x1'],
    s2Rows: rows, cohortDigest: 'cd',
    outerFoldAssignment: new Map([[1, new Map(rows.map((r, i) => [r.cohortPersonKey!, i % 5]))]]),
    outerFoldCount: 5,
    nonEstimableCheck: { reason: null, columnCount: 1, parameterCount: 1, design: makeDesign(rows) },
    personCount: 100, eventPersonCount: 3, nonEventPersonCount: 97, excludedRowCount: 0,
    ...over,
  };
}
function makeCtx(state: PredictionAnalysisState | null, over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    orgId: 'org', userId: 'user',
    recipe: {
      grain: 'case', variableKeys: ['x1', 'outcome'], filters: [], analysisPurpose: 'prediction',
      formulaPolicies: {}, analysisMode: 'prediction', requestedMethod: 'l2_logistic',
      prediction: { outcomeKey: 'outcome', eventLevel: 'true' },
    } as unknown as AnalysisContext['recipe'],
    catalogByKey: new Map<string, AnalyticsVariableMetadata>(),
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: {} as AnalysisContext['dataset'],
    requestSuppressed: false, reasonCode: null,
    paired: null, pairDisclosed: false, availableMethods: [], methodCatalogVersion: null,
    correlationMatrixPairs: null, correlationMatrixVariables: null,
    regressionDisclosed: false, regressionDesign: null, regressionExcludedRowCount: null, regressionMethod: null,
    predictionDisclosed: true, predictionState: state, descriptiveStratifyPartition: null,
    ...over,
  };
}
const okRaw = () => {
  const metric = (apparent: number) => ({
    apparent, representativeRepeat: apparent,
    cv: { status: 'ok' as const, validRepeats: 5, totalRepeats: 5, mean: apparent, min: apparent, max: apparent },
    bootstrap: { status: 'ok' as const, validReplicates: 200, totalReplicates: 200, optimism: 0.01, corrected: apparent - 0.01 },
  });
  return {
    estimation: 'ok' as const, nonEstimableReason: null, lambdaSelected: 0.1,
    metrics: {
      roc_auc: metric(0.8), average_precision: metric(0.7), brier: metric(0.2),
      calibration_intercept: metric(0.0), calibration_slope: metric(1.0),
    },
    aucCi: { target: 'roc_auc_cv_mean' as const, lower: 0.6, upper: 0.9, method: 'person_bootstrap_oof_conditional' as const, replicates: 1000 },
    // 예측값이 클수록 사건(상위 3행) — 소수 인원 구간이 생긴다.
    oofRepresentative: Array.from({ length: 100 }, (_, i) => ({ row: i, p: (i + 1) / 101 })),
    intercept: -0.5, coefficients: [1.2], droppedColumnFoldCount: 0, flags: [],
  };
};

describe('assemblePredictionResult — restricted vs lifted 곡선', () => {
  it('같은 엔진 결과를 컨텍스트 모드에 따라 다르게 조립한다(제한: 병합, 해제: 20구간 그대로)', async () => {
    runPredictionStatsEngine.mockResolvedValue(okRaw());
    const state = makeState();
    const run = await runPredictionEngineStage(makeCtx(state));
    const restricted = assemblePredictionResult(makeCtx(state), run);
    const lifted = assemblePredictionResult(makeCtx(state, { disclosureMode: 'lifted' }), run);

    if (restricted.suppressed || lifted.suppressed) throw new Error('unexpected suppression');
    expect(runPredictionStatsEngine).toHaveBeenCalledTimes(1);
    expect(lifted.curves?.bins).toHaveLength(20);
    expect((restricted.curves?.bins?.length ?? 0)).toBeLessThan(20);
    // 통계 결과 자체는 두 표시본이 같다 — 달라지는 것은 곡선 공개 범위뿐이다.
    expect(lifted.metrics).toEqual(restricted.metrics);
    expect(lifted.coefficients).toEqual(restricted.coefficients);
    expect(lifted.eventPersonCount).toBe(3);
  });

  it('구조적 추정불가(③)는 엔진 없이 같은 사유로 조립되고, 해제 컨텍스트에서도 사유가 유지된다(사건 3명 → 인원 부족)', async () => {
    const state = makeState({
      nonEstimableCheck: { reason: 'INSUFFICIENT_PERSONS', columnCount: null, parameterCount: null, design: null },
    });
    const run = await runPredictionEngineStage(makeCtx(state, { disclosureMode: 'lifted' }));
    expect(run).toEqual({ kind: 'structural' });
    expect(runPredictionStatsEngine).not.toHaveBeenCalled();
    const lifted = assemblePredictionResult(makeCtx(state, { disclosureMode: 'lifted' }), run);
    expect(lifted).toMatchObject({ suppressed: false, estimation: 'non_estimable', nonEstimableReason: 'INSUFFICIENT_PERSONS' });
  });

  it('기존 진입점(computePredictionAnalyzeResult)은 단계를 합친 것과 같은 결과를 낸다', async () => {
    runPredictionStatsEngine.mockResolvedValue(okRaw());
    const state = makeState();
    const viaEntry = await computePredictionAnalyzeResult(makeCtx(state));
    const viaStages = assemblePredictionResult(makeCtx(state), await runPredictionEngineStage(makeCtx(state)));
    expect(viaEntry).toEqual(viaStages);
  });
});

describe('computePredictionViews — 엔진 1회로 두 표시본', () => {
  it('일반본 ②가 통과하면 두 표시본 모두 조립하고, 엔진은 한 번만 부른다', async () => {
    runPredictionStatsEngine.mockResolvedValue(okRaw());
    const restricted = makeCtx(makeState());
    const lifted = makeCtx(makeState(), { disclosureMode: 'lifted' });

    const views = await computePredictionViews(restricted, lifted);
    expect(runPredictionStatsEngine).toHaveBeenCalledTimes(1);
    expect(views.aggregate.prediction).toMatchObject({ suppressed: false, estimation: 'ok' });
    expect(views.limited.prediction).toMatchObject({ suppressed: false, estimation: 'ok' });
    const aggBins = (views.aggregate.prediction as { curves: { bins: unknown[] | null } }).curves.bins;
    const limBins = (views.limited.prediction as { curves: { bins: unknown[] } }).curves.bins;
    expect(limBins).toHaveLength(20);
    expect((aggBins?.length ?? 0)).toBeLessThan(20);
  });

  it('일반본 ②가 닫혀 있으면(소수 집단) 일반본은 기존 억제 스텁이고 해제본만 정상 조립된다', async () => {
    runPredictionStatsEngine.mockResolvedValue(okRaw());
    const restricted = makeCtx(null, { predictionDisclosed: false });
    const lifted = makeCtx(makeState(), { disclosureMode: 'lifted' });

    const views = await computePredictionViews(restricted, lifted);
    expect(views.aggregate.prediction).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(JSON.stringify(views.aggregate)).not.toContain('roc_auc'); // 일반본에는 지표가 하나도 없다
    expect(views.limited.prediction).toMatchObject({ suppressed: false, estimation: 'ok', eventPersonCount: 3 });
  });

  it('전체 N<10으로 일반본이 요청 수준 억제여도 일반본은 스텁이다', async () => {
    runPredictionStatsEngine.mockResolvedValue(okRaw());
    const restricted = makeCtx(null, { predictionDisclosed: false, requestSuppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    const lifted = makeCtx(makeState(), { disclosureMode: 'lifted' });
    const views = await computePredictionViews(restricted, lifted);
    expect(views.aggregate.prediction).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('일반본과 해제본의 predictionState가 어긋나면(같은 dataset에서 파생되지 않음) 조용히 넘어가지 않고 throw한다', async () => {
    runPredictionStatsEngine.mockResolvedValue(okRaw());
    const restricted = makeCtx(makeState({ cohortDigest: 'other' }));
    const lifted = makeCtx(makeState(), { disclosureMode: 'lifted' });
    await expect(computePredictionViews(restricted, lifted)).rejects.toThrow(/어긋났다/);
  });

  it('해제 컨텍스트에 predictionState가 없으면 호출 순서 위반으로 throw한다', async () => {
    await expect(
      computePredictionViews(makeCtx(null, { predictionDisclosed: false }), makeCtx(null, { disclosureMode: 'lifted' })),
    ).rejects.toThrow(/호출 순서 위반/);
  });
});

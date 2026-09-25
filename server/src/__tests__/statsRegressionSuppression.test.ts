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

import { computeRegressionAnalyzeResult, buildRegressionEngineRequest } from '../statsRegressionSuppression';
import { assertRegressionWithinLimits, StatsEngineInputTooLargeError } from '../statsEngine';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { RegressionDesignMatrix, RegressionDesignResult } from '../statsRegressionDesign';

// PR4-A2 — 2열(절편+x1) 설계 기준 최소 diagnostics/splinePartialEffects. 이
// 파일의 목적은 클러스터 게이트 우선순위 로직이지 diagnostics 렌더링이 아니므로
// 형태만 유효하게 맞춘다(diagnostics===undefined면 buildPublicDiagnostics가
// 런타임에서 raw.vif에 접근하다 죽는다 — null과 undefined는 다르다).
const DIAGNOSTICS_OK = {
  conditionNumber: 1.0, vif: [1.0], pointDiagnosticsSupported: true, pointDiagnosticsUnsupportedReason: null,
};

function makeDesign(overrides: Partial<RegressionDesignMatrix> = {}): RegressionDesignMatrix {
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

function makeCtx(design: RegressionDesignResult | null, excludedRowCount = 0): AnalysisContext {
  return {
    orgId: 'org', userId: 'user',
    recipe: {
      grain: 'case', variableKeys: ['x1', 'y'], filters: [], analysisPurpose: 'association',
      formulaPolicies: {}, analysisMode: 'regression', requestedMethod: 'ols_linear',
      regression: {
        outcomeKey: 'y', referenceLevels: {}, eventLevel: undefined,
        standardizePredictors: false, interactionTerms: [], splineKeys: [],
      },
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
    predictionDisclosed: false,
    predictionState: null,
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
    expect(result).toMatchObject({
      suppressed: false, estimation: 'non_estimable', nonEstimableReason: 'RANK_DEFICIENT', terms: [], fit: null,
      diagnostics: null, splinePartialEffects: null,
    });
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
      diagnostics: DIAGNOSTICS_OK, splinePartialEffects: [],
    });
    const design = makeDesign(); // personClusterKeys 4개 전부 다름 → personCount===rowCount
    const ctx = makeCtx({ ok: true, design });
    const result = await computeRegressionAnalyzeResult(ctx);

    expect(runRegressionStatsEngine).toHaveBeenCalledTimes(1);
    const call = runRegressionStatsEngine.mock.calls[0][0];
    expect(call.covariance).toEqual({ type: 'hc3' });
    expect(call.splineContrasts).toEqual([]);

    expect(result).toMatchObject({ suppressed: false, estimation: 'ok', covariance: 'hc3', personCount: 4, n: 4, clusterCount: null, maxClusterShare: null });
    if (result.suppressed === false && result.estimation === 'ok') {
      expect(result.terms).toHaveLength(2);
      expect(result.terms[1].label).toBe('x1 변수');
      expect(result.terms[1].variableKey).toBe('x1');
      expect(result.terms[1].pValue).toBe(0.001);
      expect(result.diagnostics).toMatchObject({ pointDiagnosticsSupported: true, pointDiagnosticsStatus: 'not_requested' });
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
      diagnostics: DIAGNOSTICS_OK, splinePartialEffects: [],
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
      diagnostics: DIAGNOSTICS_OK,
      splinePartialEffects: [{ variableKey: 'x1', points: [{ deltaFromBaseline: 1.0, ciLower: 0.5, ciUpper: 1.5, exponentiated: null }] }],
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
      // PR4-A2 — Node 클러스터 게이트가 spline CI도 null로 만든다(계수표와 동일 원칙).
      expect(result.splinePartialEffects![0].points[0].ciLower).toBeNull();
      expect(result.splinePartialEffects![0].points[0].ciUpper).toBeNull();
      expect(result.splinePartialEffects![0].points[0].deltaFromBaseline).toBe(1.0); // delta는 유지
      // pointDiagnosticsSupported는 Node 클러스터 게이트와 무관하게 유지된다.
      expect(result.diagnostics).toMatchObject({ pointDiagnosticsSupported: true });
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
      diagnostics: DIAGNOSTICS_OK, splinePartialEffects: [],
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
      diagnostics: { conditionNumber: null, vif: [null], pointDiagnosticsSupported: false, pointDiagnosticsUnsupportedReason: 'NEAR_SINGULAR_LEVERAGE' },
      splinePartialEffects: [],
    });
    const ctx = makeCtx({ ok: true, design: clusterDesign(keys) });
    const result = await computeRegressionAnalyzeResult(ctx);

    // 최종 사유가 COVARIANCE_NOT_COMPUTABLE로 유지돼야 한다 — TOO_FEW_CLUSTERS로
    // 덮이면 안 된다(우선순위 사슬 위반).
    expect(result).toMatchObject({ estimation: 'inference_withheld', inferenceWithheldReason: 'COVARIANCE_NOT_COMPUTABLE' });
    if (result.suppressed === false && result.estimation === 'inference_withheld') {
      expect(result.terms.every((t) => t.se === null)).toBe(true);
      // PR4-A2 — 이 경우는 Python 자체가 h 계산에 실패한 사례를 가정(diagnostics
      // 예시) — pointDiagnosticsSupported는 이 값을 그대로 반영한다.
      expect(result.diagnostics).toMatchObject({ pointDiagnosticsSupported: false, pointDiagnosticsUnsupportedReason: 'NEAR_SINGULAR_LEVERAGE' });
    }
  });
});

describe('computeRegressionAnalyzeResult — Python이 non_estimable을 반환하는 경우(⑤ 분리 등)', () => {
  it('raw.estimation==="non_estimable"이면 그대로 전달한다', async () => {
    runRegressionStatsEngine.mockResolvedValueOnce({
      estimation: 'non_estimable', nonEstimableReason: 'SEPARATION_DETECTED', inferenceIssue: null,
      inferenceDistribution: null, inferenceDf: null, clusterCount: null,
      terms: [], fit: null, converged: false, qualityFlags: [],
      diagnostics: null, splinePartialEffects: null,
    });
    const ctx = makeCtx({ ok: true, design: makeDesign() });
    const result = await computeRegressionAnalyzeResult(ctx);
    expect(result).toMatchObject({
      estimation: 'non_estimable', nonEstimableReason: 'SEPARATION_DETECTED', terms: [], fit: null,
      diagnostics: null, splinePartialEffects: null,
    });
  });
});

// 코드리뷰(2026-09-24) — statsAnalyzeHandler.ts의 입력상한 사전검사가 covariance:hc3·
// splineContrasts:[]로 근사한 요청을 검사해, 실제 실행이 보낼 cluster covariance
// groups·spline 대비행렬을 포함한 진짜 요청보다 작게(과소평가) 측정했다. 그 결과
// 35,000행×4열처럼 cluster groups만 추가해도 실제 바이트 상한(2MiB)을 넘는 요청이
// 사전검사를 통과해 admission·quota를 소비한 뒤 워커에서야 PROCESS_ERROR로
// 실패했다 — 의도한 400 INPUT_TOO_LARGE가 아니었다. buildRegressionEngineRequest를
// 사전검사와 실행 양쪽이 공유하도록 고친 뒤, 이 함수 자체가 실제 covariance/
// splineContrasts를 채우는지와 그 결과가 진짜 바이트 상한을 정확히 잡아내는지를
// 직접 증명한다.
describe('buildRegressionEngineRequest — 사전검사·실행이 정확히 같은 요청을 쓴다', () => {
  it('personCount===rowCount면 covariance:hc3를 쓴다', () => {
    const design = makeDesign(); // personClusterKeys 4개 전부 다름
    const { request, personCount, rowCount } = buildRegressionEngineRequest(design);
    expect(request.covariance).toEqual({ type: 'hc3' });
    expect(personCount).toBe(4);
    expect(rowCount).toBe(4);
  });

  it('personCount<rowCount면 실제 personClusterKeys를 담은 covariance:cluster를 쓴다', () => {
    const design = makeDesign({ personClusterKeys: ['p1', 'p1', 'p2', 'p2'] });
    const { request, personCount } = buildRegressionEngineRequest(design);
    expect(request.covariance).toEqual({ type: 'cluster', groups: ['p1', 'p1', 'p2', 'p2'] });
    expect(personCount).toBe(2);
  });

  it('spline knots가 있으면 빈 배열이 아닌 실제 대비행렬을 채운다', () => {
    const design = makeDesign({
      columns: [
        { name: 'intercept', label: '절편', variableKey: null, level: null, termType: 'main', interactionOf: null },
        { name: 'x1_spline_1', label: 'x1 spline', variableKey: 'x1', level: null, termType: 'spline_basis', interactionOf: null },
      ],
      splineKnots: { x1: { boundary: [0, 10], internal: [2, 5, 8] } },
    });
    const { request, splineGridByKey } = buildRegressionEngineRequest(design);
    expect(request.splineContrasts).toHaveLength(1);
    expect(request.splineContrasts[0].variableKey).toBe('x1');
    expect(request.splineContrasts[0].contrastMatrix.length).toBeGreaterThan(0);
    expect(request.splineContrasts[0].contrastMatrix[0]).toHaveLength(2); // columns.length
    expect(splineGridByKey.get('x1')?.length).toBeGreaterThan(0);
  });

  it('35,000행 cluster covariance 입력 — 실제 요청은 바이트 상한을 넘어 거부되지만, 이전의 hc3+빈 splineContrasts 근사는 같은 입력을 통과시켰다', () => {
    const n = 35000;
    // 문자열 길이는 임의가 아니다 — cluster groups 필드 하나만 추가했을 때 실측
    // 바이트 상한(2,097,152)을 확실히 넘기고, 그 필드가 없는 근사는 확실히 안
    // 넘기도록(약 1.1MB vs 약 2.3MB) 여유를 두고 맞췄다(node로 직접 측정).
    const personClusterKeys = Array.from({ length: n }, (_, i) => `person-cluster-group-longer-${i % (n / 2)}`); // n/2명 → cluster 경로
    const design = makeDesign({
      // 실측치(리뷰 지적)와 같은 자릿수 규모를 내려고 소수 4자리로 고정한다 — 정수
      // 몇 자리로는 바이트 상한을 못 넘기고, 완전 정밀도 난수는 반대로 cluster
      // groups 없이도 넘겨버려 "cluster groups만 추가하면 넘는다"는 재현이 안 된다.
      y: Array.from({ length: n }, () => Number(Math.random().toFixed(4))),
      x: Array.from({ length: n }, () => [
        1, Number(Math.random().toFixed(4)), Number(Math.random().toFixed(4)), Number(Math.random().toFixed(4)),
      ]),
      columns: [
        { name: 'intercept', label: '절편', variableKey: null, level: null, termType: 'main', interactionOf: null },
        { name: 'x1', label: 'x1', variableKey: 'x1', level: null, termType: 'main', interactionOf: null },
        { name: 'x2', label: 'x2', variableKey: 'x2', level: null, termType: 'main', interactionOf: null },
        { name: 'x3', label: 'x3', variableKey: 'x3', level: null, termType: 'main', interactionOf: null },
      ],
      personClusterKeys,
    });

    const { request } = buildRegressionEngineRequest(design);
    expect(request.covariance.type).toBe('cluster');

    // 실제 요청(진짜 cluster groups 포함) — 바이트 상한을 넘어 거부돼야 한다.
    expect(() => assertRegressionWithinLimits(request)).toThrow(StatsEngineInputTooLargeError);

    // 이전 사전검사가 쓰던 근사(covariance를 hc3로, splineContrasts를 빈 배열로
    // 고정)는 정확히 같은 y/X/columnNames를 갖고도 이 초과를 놓쳤다는 것을 직접
    // 재현한다 — 이게 바로 코드리뷰가 지적한 과소평가다.
    const oldApproximation = { ...request, covariance: { type: 'hc3' as const }, splineContrasts: [] };
    expect(() => assertRegressionWithinLimits(oldApproximation)).not.toThrow();
  });
});

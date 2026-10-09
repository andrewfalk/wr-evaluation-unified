// 제한데이터(stats.export_limited_rows) 권한자의 이변량 소수 셀(1~9명) 해제 — 단위 테스트.
// 풀리는 것: 쌍 게이트(레이어1)·A-2 브레이크다운 가림·B-1 그룹/셀 n·B-2 제외 사유 상세·이상치 수·산점도 그리드.
// 안 풀리는 것: 반복측정 게이트·그룹 수·표 차원·Python 계산 불가(사유를 붙여 알린다).
// 실제 Postgres·Python 경로는 statsBivariateLimitedDisclosure.integration.test.ts가 증명한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { AnalyzeResult } from '@wr/contracts';

const hasCapability = vi.fn();
vi.mock('../middleware/requireCapability', () => ({
  hasCapability: (...args: unknown[]) => hasCapability(...args),
  requireCapability: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const deriveLiftedContext = vi.fn();
vi.mock('../statsAnalysisContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsAnalysisContext')>();
  return { ...actual, deriveLiftedContext: (...args: unknown[]) => deriveLiftedContext(...args) };
});

const runBivariateStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runBivariateStatsEngine: (...args: unknown[]) => runBivariateStatsEngine(...args) };
});

import {
  evaluateBivariateDisclosure, isGroupBreakdownDisclosable, isTableDisclosable,
} from '../statsBivariateDisclosureGate';
import { computeAvailableMethods } from '../statsMethodCatalog';
import { METHOD_POLICY_VERSION } from '../statsExecutionDigest';
import { computeScatterGrid } from '../statsScatterGrid';
import { computeBivariateAnalyzeResult, pickUnavailableReason } from '../statsBivariateSuppression';
import { isLiftApplicable, resolveEffectiveContext, resolveLiftedRecompute } from '../statsLiftedRecompute';
import { __resetLimitedDisclosureGuardForTests } from '../statsLimitedDisclosureGuard';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { PairedDatasetResult, PairedRow } from '../statsBivariateDataset';

function makeVariable(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}

const POLICY = 'v-test';

function makePaired(pairs: PairedRow[], extra: Partial<PairedDatasetResult> = {}): PairedDatasetResult {
  return {
    pairs,
    includedCaseCount: pairs.length,
    includedPersonCount: new Set(pairs.map((p) => p.personClusterKey)).size,
    excludedCaseCount: 0,
    excludedPersonCount: 0,
    exclusions: [],
    ...extra,
  };
}

// level별 인원 수를 주면 고유 person 1:1 행을 만든다(반복측정 없음).
function groupPairs(counts: Array<{ label: string | boolean; n: number }>): PairedRow[] {
  const pairs: PairedRow[] = [];
  let seq = 0;
  for (const { label, n } of counts) {
    for (let i = 0; i < n; i += 1) { seq += 1; pairs.push({ caseId: `c${seq}`, personClusterKey: `p${seq}`, x: label, y: seq }); }
  }
  return pairs;
}

const statusOf = (methods: ReturnType<typeof computeAvailableMethods>, id: string) => methods.find((m) => m.id === id);

beforeEach(() => {
  vi.resetAllMocks();
  __resetLimitedDisclosureGuardForTests();
});

describe('게이트 lifted 옵션', () => {
  it('evaluateBivariateDisclosure: 포함/제외가 소수 셀이어도 lifted면 공개로 통과하고, 옵션이 없으면 그대로 억제한다', () => {
    const counts = { includedPersonCount: 97, excludedPersonCount: 3 };
    expect(evaluateBivariateDisclosure(counts)).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(evaluateBivariateDisclosure(counts, { lifted: false })).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(evaluateBivariateDisclosure(counts, { lifted: true })).toEqual({ disclose: true, reasonCode: null });
  });

  it('isGroupBreakdownDisclosable / isTableDisclosable: lifted면 항상 true, 옵션이 없으면 기존 판정', () => {
    const groups = [{ personCount: 50 }, { personCount: 3 }];
    const table = [[1, 19], [19, 61]];
    expect(isGroupBreakdownDisclosable(groups)).toBe(false);
    expect(isGroupBreakdownDisclosable(groups, { lifted: true })).toBe(true);
    expect(isTableDisclosable(table)).toBe(false);
    expect(isTableDisclosable(table, { lifted: true })).toBe(true);
  });
});

describe('computeAvailableMethods — A-2 가림 해제', () => {
  const CATALOG = new Map<string, AnalyticsVariableMetadata>([
    ['grp', makeVariable('grp', 'categorical')],
    ['val', makeVariable('val', 'continuous')],
  ]);

  it('소수 그룹이 있는 3그룹 데이터: 제한 목록은 welch_t를 available로 가리고, 해제 목록은 REQUIRES_EXACTLY_TWO_GROUPS를 드러낸다', () => {
    const paired = makePaired(groupPairs([{ label: 'a', n: 50 }, { label: 'b', n: 50 }, { label: 'c', n: 3 }]));
    const restricted = computeAvailableMethods('grp', 'val', CATALOG, paired, POLICY);
    expect(statusOf(restricted, 'welch_t')).toMatchObject({ status: 'available', reasonCode: null });

    const lifted = computeAvailableMethods('grp', 'val', CATALOG, paired, POLICY, { lifted: true });
    expect(statusOf(lifted, 'welch_t')).toMatchObject({ status: 'unsupported', reasonCode: 'REQUIRES_EXACTLY_TWO_GROUPS' });
    expect(statusOf(lifted, 'anova')).toMatchObject({ status: 'available' }); // 3그룹이면 anova는 가능
  });

  it('소수 칸이 있는 2×2 분할표: 해제하면 chi_square의 기대도수 사유(LOW_EXPECTED_COUNT)가 드러난다', () => {
    const catalog = new Map<string, AnalyticsVariableMetadata>([
      ['x', makeVariable('x', 'boolean')], ['y', makeVariable('y', 'boolean')],
    ]);
    const pairs: PairedRow[] = [];
    let seq = 0;
    for (const [x, y, n] of [[false, false, 1], [false, true, 19], [true, false, 19], [true, true, 61]] as Array<[boolean, boolean, number]>) {
      for (let i = 0; i < n; i += 1) { seq += 1; pairs.push({ caseId: `c${seq}`, personClusterKey: `p${seq}`, x, y }); }
    }
    const paired = makePaired(pairs);
    const restricted = computeAvailableMethods('x', 'y', catalog, paired, POLICY);
    expect(statusOf(restricted, 'chi_square')).toMatchObject({ status: 'available', reasonCode: null });

    const lifted = computeAvailableMethods('x', 'y', catalog, paired, POLICY, { lifted: true });
    expect(statusOf(lifted, 'chi_square')).toMatchObject({ status: 'conditional', reasonCode: 'LOW_EXPECTED_COUNT' });
    expect(statusOf(lifted, 'fisher_exact')).toMatchObject({ status: 'available' });
  });

  it('반복측정 게이트는 해제해도 그대로다(한 사람이 여러 사례)', () => {
    const pairs = groupPairs([{ label: 'a', n: 50 }, { label: 'b', n: 50 }]);
    pairs[1] = { ...pairs[1], personClusterKey: pairs[0].personClusterKey }; // 같은 사람이 두 사례
    const lifted = computeAvailableMethods('grp', 'val', CATALOG, makePaired(pairs), POLICY, { lifted: true });
    expect(statusOf(lifted, 'welch_t')).toMatchObject({ status: 'unsupported', reasonCode: 'REPEATED_MEASURES_NOT_ALIGNED' });
  });
});

describe('computeScatterGrid — lifted', () => {
  // 한 칸에 3명만 있는 분포: 제한 모드는 그리드 전체를 억제(null), 해제 모드는 그리드를 만든다.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ personClusterKey: `a${i}`, x: i % 3, y: i % 3 })),
    ...Array.from({ length: 3 }, (_, i) => ({ personClusterKey: `b${i}`, x: 100, y: 100 })),
  ];

  it('제한 모드는 소수 셀이 있으면 null, 해제 모드는 count 합이 전체와 같은 그리드를 반환한다', () => {
    const xOf = (r: { x: number }) => r.x;
    const yOf = (r: { y: number }) => r.y;
    expect(computeScatterGrid(rows, xOf, yOf)).toBeNull();
    const lifted = computeScatterGrid(rows, xOf, yOf, { lifted: true });
    expect(lifted).not.toBeNull();
    expect(lifted!.cells.reduce((s, c) => s + c.count, 0)).toBe(rows.length);
    expect(lifted!.cells.some((c) => c.count === 3)).toBe(true); // 소수 칸이 그대로 보인다
  });
});

describe('pickUnavailableReason', () => {
  it('가장 구체적인 사유를 우선하고, 사유가 없으면 undefined(지어내지 않는다)', () => {
    expect(pickUnavailableReason({ statistic: 'non_finite_result', pValue: 'insufficient_group_data' })).toBe('insufficient_group_data');
    expect(pickUnavailableReason({ statistic: 'constant_variable' })).toBe('constant_variable');
    expect(pickUnavailableReason({})).toBeUndefined();
  });
});

describe('computeBivariateAnalyzeResult — lifted', () => {
  const CATALOG = new Map<string, AnalyticsVariableMetadata>([
    ['grp', makeVariable('grp', 'boolean')],
    ['val', makeVariable('val', 'continuous')],
  ]);

  function makeCtx(paired: PairedDatasetResult, disclosureMode?: 'lifted'): AnalysisContext {
    return {
      orgId: 'org', userId: 'user',
      recipe: {
        grain: 'case', variableKeys: ['grp', 'val'], filters: [], analysisPurpose: 'association',
        formulaPolicies: {}, analysisMode: 'bivariate', requestedMethod: 'welch_t',
      },
      catalogByKey: CATALOG, recipeDigest: 'rd', queryFamilyDigest: 'qfd',
      differencing: { forceSuppress: false, remaining: 10 },
      requestSuppressed: false, reasonCode: null,
      paired, pairDisclosed: true, availableMethods: [], methodCatalogVersion: POLICY,
      disclosureMode,
    } as unknown as AnalysisContext;
  }

  const okEngine = (extra: Record<string, unknown> = {}) => ({
    n: 55, statistic: 2.5, df: 53, pValue: 0.01,
    effectSizes: [{ name: 'mean_difference', value: 5, ci: [1, 9], ciUnavailableReason: null }],
    nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.01 }, qualityFlags: [], extra: {},
    ...extra,
  });

  it('소수 그룹(5명): 제한 모드는 엔진 없이 억제, 해제 모드는 엔진을 호출해 그룹별 n까지 공개한다', async () => {
    const pairs = groupPairs([{ label: false, n: 50 }, { label: true, n: 5 }]);

    const restricted = await computeBivariateAnalyzeResult(makeCtx(makePaired(pairs)));
    expect(restricted).toEqual({ method: 'welch_t', suppressed: true });
    expect(runBivariateStatsEngine).not.toHaveBeenCalled();

    runBivariateStatsEngine.mockResolvedValueOnce(okEngine());
    const lifted = await computeBivariateAnalyzeResult(makeCtx(makePaired(pairs), 'lifted'));
    expect(runBivariateStatsEngine).toHaveBeenCalledTimes(1);
    expect(lifted.suppressed).toBe(false);
    if (lifted.suppressed) return;
    expect(lifted.groupBreakdown).toEqual([{ label: false, n: 50 }, { label: true, n: 5 }]);
  });

  it('제외 사유 중 소수 셀이 있어도 해제 모드는 사유별 상세(exclusions)를 공개한다', async () => {
    const pairs = groupPairs([{ label: false, n: 40 }, { label: true, n: 40 }]);
    const paired = makePaired(pairs, {
      excludedCaseCount: 20,
      exclusions: [
        { reasonCode: 'x_missing', count: 1, personCount: 1 },
        { reasonCode: 'y_missing', count: 19, personCount: 19 },
      ],
    });
    runBivariateStatsEngine.mockResolvedValue(okEngine({ n: 80 }));

    const restricted = await computeBivariateAnalyzeResult(makeCtx(paired));
    if (restricted.suppressed) throw new Error('unexpected suppression');
    expect(restricted.exclusions).toBeNull();

    const lifted = await computeBivariateAnalyzeResult(makeCtx(paired, 'lifted'));
    if (lifted.suppressed) throw new Error('unexpected suppression');
    expect(lifted.exclusions).toEqual([{ reasonCode: 'x_missing', count: 1 }, { reasonCode: 'y_missing', count: 19 }]);
  });

  it('그룹 내부 이상치가 1명이어도 해제 모드는 outlierCount를 공개한다(제한 모드는 생략)', async () => {
    const pairs: PairedRow[] = [];
    for (let i = 1; i <= 49; i += 1) pairs.push({ caseId: `f${i}`, personClusterKey: `pf${i}`, x: false, y: i });
    pairs.push({ caseId: 'fo', personClusterKey: 'pfo', x: false, y: 1000 });
    for (let i = 1; i <= 50; i += 1) pairs.push({ caseId: `t${i}`, personClusterKey: `pt${i}`, x: true, y: 100 + i });
    const boxplots = {
      groupBoxplots: [
        { label: false, boxplot: { q1: 12, median: 25, q3: 37, lowerWhisker: 1, upperWhisker: 49, lowerFence: -25.5, upperFence: 74.5, outlierCount: 1, outlierValues: [1000] } },
        { label: true, boxplot: { q1: 112, median: 125, q3: 137, lowerWhisker: 101, upperWhisker: 150, lowerFence: 75.5, upperFence: 174.5, outlierCount: 0, outlierValues: [] } },
      ],
    };
    runBivariateStatsEngine.mockResolvedValue(okEngine({ n: 100, ...boxplots }));

    const restricted = await computeBivariateAnalyzeResult(makeCtx(makePaired(pairs)));
    if (restricted.suppressed) throw new Error('unexpected suppression');
    expect(restricted.groupBreakdown?.[0].boxplot && 'outlierCount' in restricted.groupBreakdown[0].boxplot).toBe(false);

    const lifted = await computeBivariateAnalyzeResult(makeCtx(makePaired(pairs), 'lifted'));
    if (lifted.suppressed) throw new Error('unexpected suppression');
    expect(lifted.groupBreakdown?.[0].boxplot).toMatchObject({ outlierCount: 1 });
  });

  it('Python이 계산 불가(값 상수)로 돌려주면 제한 모드는 사유 없이, 해제 모드는 사유와 함께 억제한다', async () => {
    const pairs = groupPairs([{ label: false, n: 50 }, { label: true, n: 50 }]);
    const nullEngine = {
      n: 100, statistic: null, df: null, pValue: null, effectSizes: [],
      nullReasons: { statistic: 'constant_variable' }, multipleTesting: { method: 'none', adjustedP: null },
      qualityFlags: [], extra: {},
    };
    runBivariateStatsEngine.mockResolvedValue(nullEngine);

    expect(await computeBivariateAnalyzeResult(makeCtx(makePaired(pairs)))).toEqual({ method: 'welch_t', suppressed: true });
    expect(await computeBivariateAnalyzeResult(makeCtx(makePaired(pairs), 'lifted'))).toEqual({
      method: 'welch_t', suppressed: true, unavailableReason: 'constant_variable',
    });
  });
});

describe('isLiftApplicable — 이변량', () => {
  const full = {
    method: 'welch_t', suppressed: false, n: 100, statistic: 1, df: 98, pValue: 0.3, effectSizes: [],
    nullReasons: {}, multipleTesting: { method: 'none', adjustedP: 0.3 }, qualityFlags: [], extra: {},
    excludedCaseCount: 0, exclusions: [],
  };
  const wrap = (bivariate: unknown) => ({ continuous: [], discrete: [], bivariate }) as unknown as AnalyzeResult;

  it('억제 스텁이면 풀 것이 있다', () => {
    expect(isLiftApplicable('bivariate', wrap({ method: 'welch_t', suppressed: true }))).toBe(true);
  });

  it('공개된 결과라도 부분 가림(제외 상세 null / 이상치 수 생략 / 산점도 그리드 생략)이 있으면 풀 것이 있다', () => {
    expect(isLiftApplicable('bivariate', wrap({ ...full, exclusions: null }))).toBe(true);
    expect(isLiftApplicable('bivariate', wrap({
      ...full, groupBreakdown: [{ label: false, n: 50, boxplot: { q1: 1, median: 2, q3: 3, lowerWhisker: 0, upperWhisker: 4 } }],
    }))).toBe(true);
    expect(isLiftApplicable('bivariate', wrap({ ...full, scatter: { displayedCount: 10, totalCount: 10 } }))).toBe(true);
  });

  it('가려진 것이 없는 공개 결과는 재계산하지 않는다', () => {
    expect(isLiftApplicable('bivariate', wrap(full))).toBe(false);
    expect(isLiftApplicable('bivariate', wrap({
      ...full,
      groupBreakdown: [{ label: false, n: 50, boxplot: { q1: 1, median: 2, q3: 3, lowerWhisker: 0, upperWhisker: 4, outlierCount: 0 } }],
      scatter: { displayedCount: 10, totalCount: 10, grid: { xEdges: [], yEdges: [], cells: [] } },
    }))).toBe(false);
    expect(isLiftApplicable('bivariate', { continuous: [], discrete: [] })).toBe(false);
  });
});

describe('resolveEffectiveContext — 이변량', () => {
  const CATALOG = new Map<string, AnalyticsVariableMetadata>([
    ['grp', makeVariable('grp', 'categorical')],
    ['val', makeVariable('val', 'continuous')],
  ]);

  function makeRestricted(pairs: PairedRow[], over: Partial<AnalysisContext> = {}): AnalysisContext {
    const paired = makePaired(pairs);
    const base = {
      orgId: 'org', userId: 'user',
      recipe: { analysisMode: 'bivariate', variableKeys: ['grp', 'val'], requestedMethod: 'welch_t' },
      catalogByKey: CATALOG,
      differencing: { forceSuppress: false, remaining: 10 },
      requestSuppressed: false,
      paired, pairDisclosed: true,
      // 실제 컨텍스트와 같은 정책 버전으로 만들어야 해제 기준 목록과의 비교가 의미를 가진다.
      availableMethods: computeAvailableMethods('grp', 'val', CATALOG, paired, METHOD_POLICY_VERSION),
    };
    return { ...base, ...over } as unknown as AnalysisContext;
  }

  it('쌍 게이트가 닫혀 있으면 가려진 것으로 보고 권한자에게 해제 컨텍스트를 준다', async () => {
    hasCapability.mockResolvedValue(true);
    const lifted = { marker: 'lifted' } as unknown as AnalysisContext;
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: lifted });
    const ctx = makeRestricted(groupPairs([{ label: 'a', n: 50 }, { label: 'b', n: 50 }]), { pairDisclosed: false, availableMethods: [] });
    expect(await resolveEffectiveContext(null as never, ctx)).toEqual({ ctx: lifted, lifted: true });
  });

  it('쌍 게이트는 통과했지만 A-2가 사유를 가린 경우(소수 그룹)도 가려진 것으로 본다', async () => {
    hasCapability.mockResolvedValue(true);
    const lifted = { marker: 'lifted' } as unknown as AnalysisContext;
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: lifted });
    const ctx = makeRestricted(groupPairs([{ label: 'a', n: 50 }, { label: 'b', n: 50 }, { label: 'c', n: 3 }]));
    const out = await resolveEffectiveContext(null as never, ctx);
    expect(out.lifted).toBe(true);
    expect(hasCapability).toHaveBeenCalledTimes(1);
  });

  it('가려진 것이 없으면(모든 그룹 ≥10) 권한 조회조차 하지 않는다', async () => {
    const ctx = makeRestricted(groupPairs([{ label: 'a', n: 50 }, { label: 'b', n: 50 }]));
    const out = await resolveEffectiveContext(null as never, ctx);
    expect(out).toEqual({ ctx, lifted: false });
    expect(hasCapability).not.toHaveBeenCalled();
  });
});

describe('resolveLiftedRecompute — 이변량', () => {
  const stub = { continuous: [], discrete: [], bivariate: { method: 'welch_t', suppressed: true } } as unknown as AnalyzeResult;

  function liftedCtx(availableMethods: unknown[], over: Partial<AnalysisContext> = {}): AnalysisContext {
    return {
      orgId: 'org', userId: 'user',
      recipe: { analysisMode: 'bivariate', variableKeys: ['grp', 'val'], requestedMethod: 'welch_t' },
      differencing: { forceSuppress: false, remaining: 10 },
      pairDisclosed: true, paired: makePaired(groupPairs([{ label: false, n: 50 }, { label: true, n: 5 }])),
      catalogByKey: new Map([['grp', makeVariable('grp', 'boolean')], ['val', makeVariable('val', 'continuous')]]),
      availableMethods, disclosureMode: 'lifted',
      ...over,
    } as unknown as AnalysisContext;
  }

  it('해제 컨텍스트에서 방법이 실행 불가면 계산하지 않고 사유가 붙은 억제 본문을 해제본으로 보낸다(폴백이 아님)', async () => {
    deriveLiftedContext.mockReturnValue({
      ok: true,
      ctx: liftedCtx([{ id: 'welch_t', status: 'unsupported', reasonCode: 'REPEATED_MEASURES_NOT_ALIGNED' }]),
    });
    const out = await resolveLiftedRecompute({} as AnalysisContext, stub, 'exec-1');
    expect(out).toMatchObject({ kind: 'applied', source: 'computed' });
    if (out.kind !== 'applied') return;
    expect(out.result.bivariate).toEqual({ method: 'welch_t', suppressed: true, unavailableReason: 'REPEATED_MEASURES_NOT_ALIGNED' });
    expect(runBivariateStatsEngine).not.toHaveBeenCalled();
  });

  it('요청한 방법이 목록에 없으면 사유 없이 억제 본문을 보낸다', async () => {
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: liftedCtx([]) });
    const out = await resolveLiftedRecompute({} as AnalysisContext, stub, 'exec-1');
    expect(out).toMatchObject({ kind: 'applied' });
    if (out.kind !== 'applied') return;
    expect(out.result.bivariate).toEqual({ method: 'welch_t', suppressed: true });
    expect(runBivariateStatsEngine).not.toHaveBeenCalled();
  });

  it('실행 가능하면 해제 컨텍스트로 계산해 소수 그룹까지 공개한다', async () => {
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: liftedCtx([{ id: 'welch_t', status: 'available', reasonCode: null }]) });
    runBivariateStatsEngine.mockResolvedValueOnce({
      n: 55, statistic: 2.5, df: 53, pValue: 0.01, effectSizes: [], nullReasons: {},
      multipleTesting: { method: 'none', adjustedP: 0.01 }, qualityFlags: [], extra: {},
    });
    const out = await resolveLiftedRecompute({} as AnalysisContext, stub, 'exec-1');
    expect(out).toMatchObject({ kind: 'applied' });
    if (out.kind !== 'applied') return;
    expect(out.result.bivariate).toMatchObject({ suppressed: false, groupBreakdown: [{ label: false, n: 50 }, { label: true, n: 5 }] });
  });

  it('해제 컨텍스트의 쌍 게이트가 닫혀 있으면(호출 순서 위반) 집계본으로 폴백한다', async () => {
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: liftedCtx([], { pairDisclosed: false }) });
    const out = await resolveLiftedRecompute({} as AnalysisContext, stub, 'exec-1');
    expect(out).toEqual({ kind: 'unavailable', status: 'unavailable_method_not_executable' });
  });
});

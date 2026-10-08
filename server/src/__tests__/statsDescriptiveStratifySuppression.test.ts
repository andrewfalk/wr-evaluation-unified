// Table1 스트라티피케이션 — statsDescriptiveStratifySuppression.ts 단위테스트.
// 핵심 검증 대상은 3가지: (1) 합성키 왕복, (2) 최소 DTO 투영이 missingPatterns 같은
// "변수 전체 suppressed 플래그와 독립된 하위 게이트" 필드를 구조적으로 배제하는지
// (3차 리뷰가 지적한 total-그룹 차감 반례 회귀 테스트), (3) total 강제 억제가
// 스프레드 없는 객체 교체인지(수치 필드 잔존 금지).
import { describe, expect, it, vi, beforeEach } from 'vitest';

const runStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runStatsEngine: (...args: unknown[]) => runStatsEngine(...args) };
});

beforeEach(() => { vi.clearAllMocks(); });

import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';
import type { DatasetRow } from '../statsDatasetBuilder';
import { computeDescriptiveSuppression } from '../statsDescriptiveSuppression';
import type { StatsEngineRawResult } from '../statsEngine';
import {
  buildStratifiedStatsEngineRequest,
  compositeKey,
  splitCompositeKey,
  toTable1ContinuousCell,
  toTable1DiscreteCell,
  forceTotalSuppressionWhereAnyGroupSuppressed,
  computeDescriptiveStratifiedAnalyzeResult,
  resolveStratifyGroupLabels,
} from '../statsDescriptiveStratifySuppression';
import type { StratifyRowGroup } from '../statsDescriptiveStratify';
import type { AnalyzeDescriptiveStratifiedGroupResult } from '@wr/contracts';
import type { AnalysisContext } from '../statsAnalysisContext';

function meta(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association'], sensitivity: 'non_sensitive',
    formulaFamily: 'test', supportedFormulaPolicies: ['recompute_current'],
  };
}

function extracted<T>(value: T | null, missing: ExtractedValue<T>['missing'] = null): ExtractedValue<T> {
  return { value, missing, qualityFlags: [] };
}

function rows(
  key: string,
  personPrefix: string,
  entries: Array<{ value: unknown; missing?: ExtractedValue<unknown>['missing'] }>,
): DatasetRow[] {
  return entries.map((e, i) => ({
    caseId: `case-${personPrefix}-${i}`,
    personClusterKey: `person-${personPrefix}-${i}`,
    entityKey: null,
    values: { [key]: extracted(e.missing ? null : e.value, e.missing ?? null) },
  }));
}

describe('compositeKey / splitCompositeKey — 왕복', () => {
  it('groupId와 variableKey를 정확히 복원한다', () => {
    const key = compositeKey('g0', 'case.staff.assignedDoctorUserId');
    expect(splitCompositeKey(key)).toEqual({ groupId: 'g0', variableKey: 'case.staff.assignedDoctorUserId' });
  });

  it('variableKey 자체에 구분자가 없으므로(카탈로그 키는 점 표기 문자열) 여러 그룹을 섞어도 각각 복원된다', () => {
    const keys = ['total', 'g0', 'g1', 'other', 'missing'].map((g) => compositeKey(g, 'v.x'));
    expect(keys.map(splitCompositeKey)).toEqual([
      { groupId: 'total', variableKey: 'v.x' },
      { groupId: 'g0', variableKey: 'v.x' },
      { groupId: 'g1', variableKey: 'v.x' },
      { groupId: 'other', variableKey: 'v.x' },
      { groupId: 'missing', variableKey: 'v.x' },
    ]);
  });
});

describe('buildStratifiedStatsEngineRequest — 그룹별 조립', () => {
  it('그룹 수 × 변수 수만큼 합성키 variable 엔트리를 만든다', () => {
    const key = 'age';
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const groups: StratifyRowGroup[] = [
      { groupId: 'total', kind: 'total', level: null, rows: rows(key, 'total', [{ value: 1 }, { value: 2 }]) },
      { groupId: 'g0', kind: 'level', level: 'A', rows: rows(key, 'a', [{ value: 1 }]) },
    ];
    const request = buildStratifiedStatsEngineRequest(groups, [key], catalogByKey);
    expect(request.variables.map((v) => v.key).sort()).toEqual(['g0\u0000age', 'total\u0000age'].sort());
    expect(request.variables.find((v) => v.key === `total\u0000${key}`)!.values).toEqual([1, 2]);
    expect(request.variables.find((v) => v.key === `g0\u0000${key}`)!.values).toEqual([1]);
  });
});

describe('toTable1ContinuousCell / toTable1DiscreteCell — 최소 DTO 투영(핵심 반례 회귀)', () => {
  it('공개된 continuous 결과에서 missingPatterns/histogram/boxplot/skewness/kurtosis/nullReasons가 전부 빠진다', () => {
    const key = 'x';
    // A: 비결측10, 결측사유①=1(소수셀)·②=9(소수셀) → missingPatterns null이지만
    // 변수 자체(present=10,missing=10)는 suppressed:false.
    const entriesA = [
      ...Array.from({ length: 10 }, (_, i) => ({ value: i })),
      { value: null, missing: 'not_entered' as const },
      ...Array.from({ length: 9 }, () => ({ value: null, missing: 'not_assessed' as const })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const rawA: StatsEngineRawResult = {
      continuous: [{
        variableKey: key, n: 10, mean: 4.5, sd: 3, median: 4.5, q1: 2, q3: 7, iqr: 5,
        skewness: 0, kurtosis: 0, min: 0, max: 9, nullReasons: {}, histogram: null, boxplot: null,
      }],
      discrete: [],
    };
    const fullA = computeDescriptiveSuppression(rows(key, 'a', entriesA), [key], catalogByKey, rawA).continuous[0];
    expect(fullA.suppressed).toBe(false);
    if (fullA.suppressed) throw new Error('unreachable');
    // 옛 설계(완전한 결과 재사용)라면 이 필드가 그대로 노출됐을 것 — 존재 확인.
    expect(fullA.missingPatterns).toBeNull();
    expect('mean' in fullA).toBe(true);

    const cell = toTable1ContinuousCell(fullA);
    expect(cell.suppressed).toBe(false);
    if (cell.suppressed) throw new Error('unreachable');
    // 최소 DTO엔 애초에 이 키들 자체가 없다(값이 undefined인 게 아니라 키 부재).
    expect('missingPatterns' in cell).toBe(false);
    expect('histogram' in cell).toBe(false);
    expect('boxplot' in cell).toBe(false);
    expect('skewness' in cell).toBe(false);
    expect('kurtosis' in cell).toBe(false);
    expect('nullReasons' in cell).toBe(false);
    // 필요한 필드는 그대로 보존.
    expect(cell.mean).toBe(4.5);
    expect(cell.n).toBe(10);
    expect(cell.missingCount).toBe(10);
  });

  it('억제된 continuous/discrete 셀은 variableKey/kind/suppressed 외 아무 키도 없다', () => {
    expect(Object.keys(toTable1ContinuousCell({ variableKey: 'x', kind: 'continuous', suppressed: true })))
      .toEqual(['variableKey', 'kind', 'suppressed']);
    expect(Object.keys(toTable1DiscreteCell({ variableKey: 'x', kind: 'discrete', suppressed: true })))
      .toEqual(['variableKey', 'kind', 'suppressed']);
  });

  it('공개된 discrete 결과는 levels/mode만 남고 missingPatterns는 빠진다', () => {
    const key = 'sex';
    const entries = [
      ...Array.from({ length: 12 }, () => ({ value: 'M' })),
      ...Array.from({ length: 12 }, () => ({ value: 'F' })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'categorical')]]);
    const raw: StatsEngineRawResult = {
      continuous: [],
      discrete: [{ variableKey: key, n: 24, levels: [{ level: 'M', count: 12 }, { level: 'F', count: 12 }] }],
    };
    const full = computeDescriptiveSuppression(rows(key, 's', entries), [key], catalogByKey, raw).discrete[0];
    const cell = toTable1DiscreteCell(full);
    expect(cell.suppressed).toBe(false);
    if (cell.suppressed) throw new Error('unreachable');
    expect('missingPatterns' in cell).toBe(false);
    expect(cell.levels).toEqual([
      { level: 'M', count: 12, proportion: 0.5 },
      { level: 'F', count: 12, proportion: 0.5 },
    ]);
  });

  it('§Context 3 반례 재현 — total−그룹 차감으로 A의 결측사유 분포가 새는 것은 완전한 결과에서만 일어나고, 최소 DTO에는 새어나갈 필드 자체가 없다', () => {
    // 표: A(비결측10/사유①1/사유②9) B(비결측10/사유①10/사유②10) 전체(비결측20/사유①11/사유②19)
    const key = 'x';
    const entriesA = [
      ...Array.from({ length: 10 }, (_, i) => ({ value: i })),
      { value: null, missing: 'not_entered' as const },
      ...Array.from({ length: 9 }, () => ({ value: null, missing: 'not_assessed' as const })),
    ];
    const entriesB = [
      ...Array.from({ length: 10 }, (_, i) => ({ value: i })),
      ...Array.from({ length: 10 }, () => ({ value: null, missing: 'not_entered' as const })),
      ...Array.from({ length: 10 }, () => ({ value: null, missing: 'not_assessed' as const })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const rowsA = rows(key, 'a', entriesA);
    const rowsB = rows(key, 'b', entriesB);
    const rawFor = (n: number): StatsEngineRawResult => ({
      continuous: [{
        variableKey: key, n, mean: 1, sd: 1, median: 1, q1: 0, q3: 2, iqr: 2,
        skewness: 0, kurtosis: 0, min: 0, max: 9, nullReasons: {}, histogram: null, boxplot: null,
      }],
      discrete: [],
    });
    const fullA = computeDescriptiveSuppression(rowsA, [key], catalogByKey, rawFor(10)).continuous[0];
    const fullB = computeDescriptiveSuppression(rowsB, [key], catalogByKey, rawFor(10)).continuous[0];
    const fullTotal = computeDescriptiveSuppression([...rowsA, ...rowsB], [key], catalogByKey, rawFor(20)).continuous[0];
    if (fullA.suppressed || fullB.suppressed || fullTotal.suppressed) throw new Error('unreachable — 셋 다 present/missing이 10 이상이라 변수 자체는 억제되지 않아야 한다');

    // 옛 설계가 이랬을 것 — full 결과를 그대로 노출했다면 A의 결측사유 분포가
    // total과 B의 차감으로 정확히 복원된다(11-10=1, 19-10=9). 이 assert는 "왜
    // 최소 DTO가 필요한가"의 증거로 남겨둔다(회귀 방지, 삭제 금지).
    expect(fullA.missingPatterns).toBeNull(); // A는 그 자체로 이미 숨겨져 있다
    expect(fullB.missingPatterns).toEqual([
      { reasonCode: 'not_entered', count: 10 },
      { reasonCode: 'not_assessed', count: 10 },
    ]);
    expect(fullTotal.missingPatterns).toEqual([
      { reasonCode: 'not_entered', count: 11 },
      { reasonCode: 'not_assessed', count: 19 },
    ]);
    const reconstructedA = {
      not_entered: fullTotal.missingPatterns!.find((p) => p.reasonCode === 'not_entered')!.count
        - fullB.missingPatterns!.find((p) => p.reasonCode === 'not_entered')!.count,
      not_assessed: fullTotal.missingPatterns!.find((p) => p.reasonCode === 'not_assessed')!.count
        - fullB.missingPatterns!.find((p) => p.reasonCode === 'not_assessed')!.count,
    };
    expect(reconstructedA).toEqual({ not_entered: 1, not_assessed: 9 }); // A의 실제 분포와 정확히 일치 — 역산 증명

    // 새 설계 — Table1 셀에는애초에 missingPatterns 키가 없으므로 위 차감 자체가 성립하지 않는다.
    const cellA = toTable1ContinuousCell(fullA);
    const cellB = toTable1ContinuousCell(fullB);
    const cellTotal = toTable1ContinuousCell(fullTotal);
    for (const cell of [cellA, cellB, cellTotal]) {
      expect('missingPatterns' in cell).toBe(false);
    }
  });
});

describe('forceTotalSuppressionWhereAnyGroupSuppressed — total 강제 억제(객체 교체)', () => {
  function group(id: string, continuous: AnalyzeDescriptiveStratifiedGroupResult['continuous']): AnalyzeDescriptiveStratifiedGroupResult {
    return { groupId: id, continuous, discrete: [] };
  }

  it('그룹 중 하나라도 suppressed면 total의 그 변수도 완전히 새 객체로 교체된다(스프레드 잔존 필드 없음)', () => {
    const byGroup = [
      group('total', [{ variableKey: 'age', kind: 'continuous', suppressed: false, n: 30, missingCount: 0, mean: 40, sd: 5, median: 40, q1: 35, q3: 45, iqr: 10, min: 20, max: 60 }]),
      group('g0', [{ variableKey: 'age', kind: 'continuous', suppressed: false, n: 20, missingCount: 0, mean: 42, sd: 4, median: 42, q1: 38, q3: 46, iqr: 8, min: 30, max: 55 }]),
      group('other', [{ variableKey: 'age', kind: 'continuous', suppressed: true }]),
    ];
    forceTotalSuppressionWhereAnyGroupSuppressed(byGroup);
    const total = byGroup.find((g) => g.groupId === 'total')!;
    const cell = total.continuous[0];
    expect(cell.suppressed).toBe(true);
    // 필수 — 스프레드({...cell, suppressed:true})였다면 mean=40 등이 객체에 남아있었을 것.
    expect(Object.keys(cell)).toEqual(['variableKey', 'kind', 'suppressed']);
    expect('mean' in cell).toBe(false);
    expect(JSON.stringify(cell)).not.toContain('40'); // 원래 total의 mean/n 등 어떤 수치도 흔적이 없어야 한다
  });

  it('아무 그룹도 suppressed가 아니면 total은 그대로 노출된다', () => {
    const byGroup = [
      group('total', [{ variableKey: 'age', kind: 'continuous', suppressed: false, n: 30, missingCount: 0, mean: 40, sd: 5, median: 40, q1: 35, q3: 45, iqr: 10, min: 20, max: 60 }]),
      group('g0', [{ variableKey: 'age', kind: 'continuous', suppressed: false, n: 15, missingCount: 0, mean: 41, sd: 4, median: 41, q1: 38, q3: 44, iqr: 6, min: 30, max: 50 }]),
      group('g1', [{ variableKey: 'age', kind: 'continuous', suppressed: false, n: 15, missingCount: 0, mean: 39, sd: 4, median: 39, q1: 36, q3: 42, iqr: 6, min: 25, max: 55 }]),
    ];
    forceTotalSuppressionWhereAnyGroupSuppressed(byGroup);
    const total = byGroup.find((g) => g.groupId === 'total')!;
    expect(total.continuous[0].suppressed).toBe(false);
    expect((total.continuous[0] as { mean: number }).mean).toBe(40);
  });

  it('total 자체가 이미 suppressed면 그대로 둔다(불필요한 재교체 없음)', () => {
    const byGroup = [
      group('total', [{ variableKey: 'age', kind: 'continuous', suppressed: true }]),
      group('g0', [{ variableKey: 'age', kind: 'continuous', suppressed: false, n: 15, missingCount: 0, mean: 41, sd: 4, median: 41, q1: 38, q3: 44, iqr: 6, min: 30, max: 50 }]),
    ];
    forceTotalSuppressionWhereAnyGroupSuppressed(byGroup);
    expect(byGroup[0].continuous[0]).toEqual({ variableKey: 'age', kind: 'continuous', suppressed: true });
  });

  it('discrete 변수에도 동일 규칙이 적용된다', () => {
    const byGroup: AnalyzeDescriptiveStratifiedGroupResult[] = [
      { groupId: 'total', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 30, missingCount: 0, levels: [{ level: 'M', count: 15, proportion: 0.5 }, { level: 'F', count: 15, proportion: 0.5 }], mode: null }] },
      { groupId: 'other', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: true }] },
    ];
    forceTotalSuppressionWhereAnyGroupSuppressed(byGroup);
    expect(byGroup[0].discrete[0]).toEqual({ variableKey: 'sex', kind: 'discrete', suppressed: true });
  });
});

function ctxRows(key: string, personPrefix: string, entries: Array<{ value: unknown }>): DatasetRow[] {
  return entries.map((e, i) => ({
    caseId: `case-${personPrefix}-${i}`,
    personClusterKey: `person-${personPrefix}-${i}`,
    entityKey: null,
    values: { [key]: extracted(e.value) },
  }));
}

function makeCtx(partitionGroups: StratifyRowGroup[], variableKeys: string[], catalogByKey: Map<string, AnalyticsVariableMetadata>): AnalysisContext {
  return {
    orgId: 'org-1', userId: 'user-1',
    recipe: {
      grain: 'case', variableKeys, filters: [], analysisPurpose: 'association',
      formulaPolicies: {}, analysisMode: 'descriptive',
      descriptive: { stratifyByKey: 'case.staff.assignedDoctorUserId' },
    },
    catalogByKey,
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: { rows: partitionGroups.find((g) => g.groupId === 'total')!.rows } as unknown as AnalysisContext['dataset'],
    requestSuppressed: false, reasonCode: null,
    paired: null, pairDisclosed: false, availableMethods: [], methodCatalogVersion: null,
    correlationMatrixPairs: null, correlationMatrixVariables: null,
    regressionDisclosed: false, regressionDesign: null, regressionExcludedRowCount: null, regressionMethod: null,
    predictionDisclosed: false, predictionState: null,
    descriptiveStratifyPartition: { groups: partitionGroups },
  };
}

describe('computeDescriptiveStratifiedAnalyzeResult — 무결성 assertion + 방어적 파싱(정상 흐름 회귀 방지)', () => {
  it('정상 2그룹 시나리오가 예외 없이 유효한 결과를 반환한다', async () => {
    const key = 'age';
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const totalRows = [...ctxRows(key, 'a', Array.from({ length: 12 }, (_, i) => ({ value: i }))),
      ...ctxRows(key, 'b', Array.from({ length: 12 }, (_, i) => ({ value: i })))];
    const groups: StratifyRowGroup[] = [
      { groupId: 'total', kind: 'total', level: null, rows: totalRows },
      { groupId: 'g0', kind: 'level', level: '김민준', rows: totalRows.slice(0, 12) },
      { groupId: 'g1', kind: 'level', level: '이서연', rows: totalRows.slice(12) },
    ];
    runStatsEngine.mockImplementation(async (request: { variables: Array<{ key: string; values: number[] }> }) => ({
      continuous: request.variables.map((v) => ({
        variableKey: v.key, n: v.values.length,
        mean: v.values.reduce((s, x) => s + x, 0) / (v.values.length || 1), sd: 1,
        median: 1, q1: 0, q3: 2, iqr: 2, skewness: 0, kurtosis: 0,
        min: Math.min(...v.values), max: Math.max(...v.values), nullReasons: {},
        histogram: null, boxplot: null,
      })),
      discrete: [],
    }));

    const ctx = makeCtx(groups, [key], catalogByKey);
    const result = await computeDescriptiveStratifiedAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) throw new Error('unreachable');
    expect(result.groups.map((g) => g.groupId)).toEqual(['total', 'g0', 'g1']);
    expect(result.byGroup).toHaveLength(3);
  });

  it('그룹 결과가 variableKeys를 커버하지 못하면(프로그래밍 오류) throw한다', async () => {
    const key = 'age';
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const rows = ctxRows(key, 'a', Array.from({ length: 12 }, (_, i) => ({ value: i })));
    const groups: StratifyRowGroup[] = [{ groupId: 'total', kind: 'total', level: null, rows }];
    // 요청한 변수(key)가 아니라 엉뚱한 키로 결과를 돌려주는 고장난 엔진을 흉내낸다.
    runStatsEngine.mockResolvedValue({
      continuous: [{
        variableKey: 'total\u0000wrong-key', n: 12, mean: 1, sd: 1, median: 1, q1: 0, q3: 2, iqr: 2,
        skewness: 0, kurtosis: 0, min: 0, max: 11, nullReasons: {}, histogram: null, boxplot: null,
      }],
      discrete: [],
    });
    const ctx = makeCtx(groups, [key], catalogByKey);
    await expect(computeDescriptiveStratifiedAnalyzeResult(ctx)).rejects.toThrow();
  });
});

describe('resolveStratifyGroupLabels — 담당의 UUID → 표시명', () => {
  const STAFF_KEY = 'case.staff.assignedDoctorUserId';
  function staffCatalog(): Map<string, AnalyticsVariableMetadata> {
    return new Map([[STAFF_KEY, { ...meta(STAFF_KEY, 'categorical'), sensitivity: 'staff_identifier' }]]);
  }
  function stratifiedFixture(groups: Array<{ groupId: string; kind: 'total' | 'level' | 'other' | 'missing'; level: string | boolean | null }>) {
    return {
      suppressed: false as const,
      stratifyByKey: STAFF_KEY,
      groups,
      byGroup: groups.map((g) => ({ groupId: g.groupId, continuous: [], discrete: [] })),
    };
  }

  it('조직 내 존재하는 사용자 ID를 표시명으로 치환한다', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'uuid-a', name: '김민준' }, { id: 'uuid-b', name: '이서연' }] });
    const pool = { query } as unknown as Parameters<typeof resolveStratifyGroupLabels>[0];
    const stratified = stratifiedFixture([
      { groupId: 'total', kind: 'total', level: null },
      { groupId: 'g0', kind: 'level', level: 'uuid-a' },
      { groupId: 'g1', kind: 'level', level: 'uuid-b' },
    ]);
    const resolved = await resolveStratifyGroupLabels(pool, 'org-1', staffCatalog(), stratified);
    expect(resolved.suppressed).toBe(false);
    if (resolved.suppressed) throw new Error('unreachable');
    expect(resolved.groups.find((g) => g.groupId === 'g0')!.level).toBe('김민준');
    expect(resolved.groups.find((g) => g.groupId === 'g1')!.level).toBe('이서연');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['org-1', ['uuid-a', 'uuid-b']]);
  });

  it('삭제/탈퇴된 사용자는 원본 UUID 대신 중립 폴백 라벨을 쓴다', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'uuid-a', name: '김민준' }] }); // uuid-b는 조회 결과에 없음
    const pool = { query } as unknown as Parameters<typeof resolveStratifyGroupLabels>[0];
    const stratified = stratifiedFixture([
      { groupId: 'total', kind: 'total', level: null },
      { groupId: 'g0', kind: 'level', level: 'uuid-a' },
      { groupId: 'g1', kind: 'level', level: 'uuid-b' },
    ]);
    const resolved = await resolveStratifyGroupLabels(pool, 'org-1', staffCatalog(), stratified);
    if (resolved.suppressed) throw new Error('unreachable');
    expect(resolved.groups.find((g) => g.groupId === 'g1')!.level).toBe('(알 수 없음)');
    expect(resolved.groups.find((g) => g.groupId === 'g1')!.level).not.toBe('uuid-b');
  });

  it('sensitivity가 staff_identifier가 아닌 그룹 변수는 조회 자체를 하지 않는다(성별 등)', async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Parameters<typeof resolveStratifyGroupLabels>[0];
    const genderCatalog = new Map([['sex', meta('sex', 'categorical')]]); // sensitivity: non_sensitive(기본)
    const stratified = { ...stratifiedFixture([{ groupId: 'g0', kind: 'level' as const, level: 'M' }]), stratifyByKey: 'sex' };
    const resolved = await resolveStratifyGroupLabels(pool, 'org-1', genderCatalog, stratified);
    expect(query).not.toHaveBeenCalled();
    expect(resolved.suppressed === false && resolved.groups[0].level).toBe('M');
  });

  it('억제된(suppressed:true) 결과는 그대로 반환한다(조회 자체를 안 함)', async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Parameters<typeof resolveStratifyGroupLabels>[0];
    const suppressed = { suppressed: true as const, stratifyByKey: STAFF_KEY, reasonCode: 'MIN_COHORT_NOT_MET' as const };
    const resolved = await resolveStratifyGroupLabels(pool, 'org-1', staffCatalog(), suppressed);
    expect(query).not.toHaveBeenCalled();
    expect(resolved).toEqual(suppressed);
  });

  it('DB 조회가 실패해도 분석 자체는 실패시키지 않되, 원본 UUID를 노출하지 않고 중립 라벨로 대체한다', async () => {
    // 3차 리뷰 지적 — 이전 판은 catch에서 원본 stratified를 그대로 반환해 UUID가
    // 그대로 새고, 그 결과가 attempt()에 의해 'succeeded'로 영구 저장됐다(DB가
    // 복구돼도 자동 재해석 안 됨). "조회 실패"도 "사용자를 못 찾음"과 동일하게
    // 안전한 쪽으로 실패해야 한다.
    const query = vi.fn().mockRejectedValue(new Error('connection lost'));
    const pool = { query } as unknown as Parameters<typeof resolveStratifyGroupLabels>[0];
    const stratified = stratifiedFixture([{ groupId: 'g0', kind: 'level', level: 'uuid-a' }]);
    const resolved = await resolveStratifyGroupLabels(pool, 'org-1', staffCatalog(), stratified);
    if (resolved.suppressed) throw new Error('unreachable');
    expect(resolved.groups[0].level).toBe('(알 수 없음)');
    expect(resolved.groups[0].level).not.toBe('uuid-a');
    // groupId는 그대로 유지돼 그룹 구분(열 개수·매핑)은 깨지지 않는다.
    expect(resolved.groups[0].groupId).toBe('g0');
  });
});

// 제한데이터 권한자 응답 전용 — unrestricted 층화: 소수 그룹도 개별로, 억제·total 강제 억제 없음,
// 엔진은 정확히 1회만 호출한다. 기본 호출(집계 경로)은 기존과 동일해야 한다.
describe('computeDescriptiveStratifiedAnalyzeResult — unrestricted', () => {
  const key = 'diagnosis.assessment.status';
  const staffKey = 'case.staff.assignedDoctorUserId';

  function discreteRows(prefix: string, highs: number, lows: number, missing: number): DatasetRow[] {
    const out: DatasetRow[] = [];
    let i = 0;
    const push = (v: string | null, miss: ExtractedValue<string>['missing']) => {
      out.push({
        caseId: `case-${prefix}-${i}`, personClusterKey: `person-${prefix}-${i}`, entityKey: null,
        values: { [key]: extracted<string>(v, miss) },
      });
      i += 1;
    };
    for (let n = 0; n < highs; n += 1) push('high', null);
    for (let n = 0; n < lows; n += 1) push('low', null);
    for (let n = 0; n < missing; n += 1) push(null, 'not_entered');
    return out;
  }

  // 엔진 모의: 요청의 (합성키) 변수별로 범주 빈도를 그대로 센다.
  function mockDiscreteEngine() {
    runStatsEngine.mockImplementation(async (request: { variables: Array<{ key: string; values: string[] }> }) => ({
      continuous: [],
      discrete: request.variables.map((v) => {
        const counts = new Map<string, number>();
        for (const x of v.values) counts.set(x, (counts.get(x) ?? 0) + 1);
        return { variableKey: v.key, n: v.values.length, levels: [...counts].map(([level, count]) => ({ level, count })) };
      }),
    }));
  }

  function buildCtx() {
    const catalogByKey = new Map([[key, meta(key, 'categorical')]]);
    const a = discreteRows('a', 60, 40, 3);   // 결측 3명(소수)
    const b = discreteRows('b', 50, 30, 0);
    const c = discreteRows('c', 3, 2, 0);     // 값 있는 인원 5명(소수)
    const total = [...a, ...b, ...c];
    const normalGroups: StratifyRowGroup[] = [
      { groupId: 'total', kind: 'total', level: null, rows: total },
      { groupId: 'g0', kind: 'level', level: 'doctorA', rows: a },
      { groupId: 'g1', kind: 'level', level: 'doctorB', rows: b },
      { groupId: 'other', kind: 'other', level: null, rows: c },
    ];
    const openGroups: StratifyRowGroup[] = [
      { groupId: 'total', kind: 'total', level: null, rows: total },
      { groupId: 'g0', kind: 'level', level: 'doctorA', rows: a },
      { groupId: 'g1', kind: 'level', level: 'doctorB', rows: b },
      { groupId: 'g2', kind: 'level', level: 'doctorC', rows: c },
    ];
    const ctx = makeCtx(normalGroups, [key], catalogByKey);
    ctx.recipe.descriptive = { stratifyByKey: staffKey };
    return { ctx, openGroups };
  }

  it('집계 경로(기본값): 결측 3명인 그룹·소수 그룹이 억제되고 total도 강제 억제된다', async () => {
    mockDiscreteEngine();
    const { ctx } = buildCtx();
    const result = await computeDescriptiveStratifiedAnalyzeResult(ctx);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) throw new Error('unreachable');
    const cell = (groupId: string) => result.byGroup.find((g) => g.groupId === groupId)!.discrete[0];
    expect(cell('g0').suppressed).toBe(true);   // 결측 3명
    expect(cell('other').suppressed).toBe(true); // 값 있는 인원 5명
    expect(cell('total').suppressed).toBe(true); // 하나라도 억제되면 total도
    expect(cell('g1').suppressed).toBe(false);
  });

  it('unrestricted: 모든 그룹·total이 공개되고 엔진은 1회만 호출된다(새 분할 사용)', async () => {
    mockDiscreteEngine();
    const { ctx, openGroups } = buildCtx();
    const result = await computeDescriptiveStratifiedAnalyzeResult(
      ctx, undefined, { unrestricted: true, partition: { groups: openGroups } },
    );
    expect(runStatsEngine).toHaveBeenCalledTimes(1);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) throw new Error('unreachable');

    // 집계용 "기타" 대신 개별 담당의 그룹이 나온다.
    expect(result.groups.map((g) => [g.groupId, g.kind, g.level])).toEqual([
      ['total', 'total', null], ['g0', 'level', 'doctorA'], ['g1', 'level', 'doctorB'], ['g2', 'level', 'doctorC'],
    ]);
    const cell = (groupId: string) => {
      const d = result.byGroup.find((g) => g.groupId === groupId)!.discrete[0];
      if (d.suppressed) throw new Error(`${groupId} must be revealed`);
      return d;
    };
    expect(cell('g0')).toMatchObject({ n: 100, missingCount: 3 });
    expect(cell('g1')).toMatchObject({ n: 80, missingCount: 0 });
    expect(cell('g2')).toMatchObject({ n: 5, missingCount: 0 });
    expect(cell('g2').levels.map((l) => [l.level, l.count])).toEqual([['high', 3], ['low', 2]]);
    // total은 그룹의 합과 정확히 같다(강제 억제 없음).
    expect(cell('total')).toMatchObject({ n: 185, missingCount: 3 });
    // 최상위 continuous/discrete가 비는 계약은 층화 결과 shape(byGroup)로만 노출된다.
    expect(result.byGroup.every((g) => g.continuous.length === 0)).toBe(true);
  });

  it('unrestricted 호출 전에 실제 엔진 요청에 입력 상한 검사를 적용한다(상한 초과 시 엔진을 부르지 않고 throw)', async () => {
    const { ctx, openGroups } = buildCtx();
    // total 그룹의 변수 하나가 MAX_VALUES_PER_VARIABLE(50,000)을 넘기도록 만든다.
    const overLimit: DatasetRow[] = Array.from({ length: 50_001 }, (_, i) => ({
      caseId: `c-${i}`, personClusterKey: `p-${i}`, entityKey: null,
      values: { [key]: extracted('high') },
    }));
    const huge = openGroups.map((g) => (g.groupId === 'total' ? { ...g, rows: overLimit } : g));
    await expect(
      computeDescriptiveStratifiedAnalyzeResult(ctx, undefined, { unrestricted: true, partition: { groups: huge } }),
    ).rejects.toThrow();
    expect(runStatsEngine).not.toHaveBeenCalled();
  });
});

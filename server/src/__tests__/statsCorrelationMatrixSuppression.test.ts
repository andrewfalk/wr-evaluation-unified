// PR3-B 계획서 §4 — computeCorrelationMatrixAnalyzeResult(3단계 순서: Python 계산
// → Node 3중 게이트(소수셀·반복측정·계산불가) → 억제 셀 존재 시 adjustedP 전체
// null). cells는 항상 C(k,2)개(계산불가·억제 포함, 절대 빈 배열이 되지 않음).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCorrelationMatrixStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return {
    ...actual,
    runCorrelationMatrixStatsEngine: (...args: unknown[]) => runCorrelationMatrixStatsEngine(...args),
  };
});

import { computeCorrelationMatrixAnalyzeResult } from '../statsCorrelationMatrixSuppression';
import { buildCorrelationMatrixPairedDatasets, buildCorrelationMatrixVariables } from '../statsCorrelationMatrixDataset';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

function makeVariable(key: string): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type: 'continuous',
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}

// n개의 1:1 person:case 행을 만들고 각 변수에 값 배열을 채운다(길이 불일치 시 결측).
function makeRows(n: number, values: Record<string, number[]>): DatasetRow[] {
  return Array.from({ length: n }, (_, i) => ({
    caseId: `c${i}`,
    personClusterKey: `p${i}`,
    values: Object.fromEntries(
      Object.entries(values).map(([key, arr]) => [
        key,
        i < arr.length ? { value: arr[i], missing: null, qualityFlags: [] } : { value: null, missing: 'not_entered' as const, qualityFlags: [] },
      ]),
    ),
  }));
}

function makeCtx(rows: DatasetRow[], variableKeys: string[], method: 'pearson_correlation' | 'spearman_correlation' = 'pearson_correlation'): AnalysisContext {
  const catalogByKey = new Map(variableKeys.map((k) => [k, makeVariable(k)]));
  return {
    orgId: 'org', userId: 'user',
    recipe: {
      grain: 'case', variableKeys, filters: [], analysisPurpose: 'association',
      formulaPolicies: {}, analysisMode: 'correlation_matrix', requestedMethod: method,
    },
    catalogByKey,
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: { rows, personCount: rows.length, caseCount: rows.length, observationCount: rows.length, distinctAssignedDoctorClusters: 0, internalResultDigest: 'x' } as AnalysisContext['dataset'],
    requestSuppressed: false, reasonCode: null,
    paired: null,
    pairDisclosed: false,
    availableMethods: [],
    methodCatalogVersion: 'v1-bivariate',
    correlationMatrixPairs: buildCorrelationMatrixPairedDatasets(rows, variableKeys),
    correlationMatrixVariables: buildCorrelationMatrixVariables(rows, variableKeys),
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('computeCorrelationMatrixAnalyzeResult', () => {
  it('모든 쌍이 소수셀 없이 깨끗하면 전부 suppressed:false + adjustedPWithheld:false', async () => {
    const n = 50;
    const rows = makeRows(n, {
      a: Array.from({ length: n }, (_, i) => i),
      b: Array.from({ length: n }, (_, i) => i * 2),
      c: Array.from({ length: n }, (_, i) => n - i),
    });
    const ctx = makeCtx(rows, ['a', 'b', 'c']);
    runCorrelationMatrixStatsEngine.mockResolvedValueOnce({
      method: 'pearson_correlation',
      cells: [
        { xKey: 'a', yKey: 'b', n, r: 1.0, pValue: 0.0, adjustedP: 0.0 },
        { xKey: 'a', yKey: 'c', n, r: -1.0, pValue: 0.0, adjustedP: 0.0 },
        { xKey: 'b', yKey: 'c', n, r: -1.0, pValue: 0.0, adjustedP: 0.0 },
      ],
    });
    const result = await computeCorrelationMatrixAnalyzeResult(ctx);
    expect(result.cells).toHaveLength(3); // C(3,2)
    expect(result.adjustedPWithheld).toBe(false);
    for (const cell of result.cells) {
      expect(cell.suppressed).toBe(false);
      if (!cell.suppressed) expect(cell.adjustedP).not.toBeNull();
    }
  });

  it('소수셀 쌍은 suppressed:true, 나머지는 그대로 노출되지만 adjustedP는 전체 null', async () => {
    const n = 50;
    // a-b는 완전 관측(50명), a-c는 c가 5명만 관측(소수셀).
    const rows = makeRows(n, {
      a: Array.from({ length: n }, (_, i) => i),
      b: Array.from({ length: n }, (_, i) => i * 2),
      c: Array.from({ length: 5 }, (_, i) => i), // 나머지 45명은 결측
    });
    const ctx = makeCtx(rows, ['a', 'b', 'c']);
    runCorrelationMatrixStatsEngine.mockResolvedValueOnce({
      method: 'pearson_correlation',
      cells: [
        { xKey: 'a', yKey: 'b', n: 50, r: 1.0, pValue: 0.0001, adjustedP: 0.0002 },
        { xKey: 'a', yKey: 'c', n: 5, r: 0.9, pValue: 0.03, adjustedP: 0.03 },
        { xKey: 'b', yKey: 'c', n: 5, r: 0.9, pValue: 0.03, adjustedP: 0.03 },
      ],
    });
    const result = await computeCorrelationMatrixAnalyzeResult(ctx);
    const byPair = new Map(result.cells.map((c) => [`${c.xKey}::${c.yKey}`, c]));
    expect(byPair.get('a::b')?.suppressed).toBe(false);
    expect(byPair.get('a::c')?.suppressed).toBe(true);
    expect(byPair.get('b::c')?.suppressed).toBe(true);
    // 억제 셀이 있으므로 매트릭스 전체 adjustedPWithheld — a-b도 null이어야 한다.
    expect(result.adjustedPWithheld).toBe(true);
    const ab = byPair.get('a::b');
    if (ab && !ab.suppressed) expect(ab.adjustedP).toBeNull();
  });

  it('§6.1 반복측정 게이트 실패 쌍은 소수셀이 없어도 suppressed:true', async () => {
    // 각 person이 여러 case를 가져 personCount < rowCount가 되는 상황을 person
    // 재사용으로 재현 — a,b 둘 다 채워진 case가 50개지만 person은 10명뿐.
    const n = 50;
    const rows: DatasetRow[] = Array.from({ length: n }, (_, i) => ({
      caseId: `c${i}`,
      personClusterKey: `p${i % 10}`, // 10명이 각 5건씩
      values: {
        a: { value: i, missing: null, qualityFlags: [] },
        b: { value: i * 2, missing: null, qualityFlags: [] },
      },
    }));
    // 최소 3변수 요구 충족을 위해 c도 채운다.
    const rowsWithC = rows.map((r, i) => ({ ...r, values: { ...r.values, c: { value: n - i, missing: null, qualityFlags: [] } } }));
    const ctxWithC = makeCtx(rowsWithC, ['a', 'b', 'c']);
    runCorrelationMatrixStatsEngine.mockResolvedValueOnce({
      method: 'pearson_correlation',
      cells: [
        { xKey: 'a', yKey: 'b', n: 50, r: 1.0, pValue: 0.0001, adjustedP: 0.0001 },
        { xKey: 'a', yKey: 'c', n: 50, r: -1.0, pValue: 0.0001, adjustedP: 0.0001 },
        { xKey: 'b', yKey: 'c', n: 50, r: -1.0, pValue: 0.0001, adjustedP: 0.0001 },
      ],
    });
    const result = await computeCorrelationMatrixAnalyzeResult(ctxWithC);
    // personCount(10) !== rowCount(50) — 모든 쌍이 §6.1 게이트에 걸려 억제돼야 한다.
    expect(result.cells.every((c) => c.suppressed)).toBe(true);
  });

  it('계산 불가(상수 변수) 쌍은 소수셀이 없어도 suppressed:true(불투명, 사유 노출 없음)', async () => {
    const n = 50;
    const rows = makeRows(n, {
      a: Array.from({ length: n }, (_, i) => i),
      b: Array.from({ length: n }, () => 1), // 상수
      c: Array.from({ length: n }, (_, i) => n - i),
    });
    const ctx = makeCtx(rows, ['a', 'b', 'c']);
    runCorrelationMatrixStatsEngine.mockResolvedValueOnce({
      method: 'pearson_correlation',
      cells: [
        { xKey: 'a', yKey: 'b', n: 50, r: null, pValue: null, adjustedP: null }, // 상수라 계산 불가
        { xKey: 'a', yKey: 'c', n: 50, r: -1.0, pValue: 0.0001, adjustedP: 0.0001 },
        { xKey: 'b', yKey: 'c', n: 50, r: null, pValue: null, adjustedP: null },
      ],
    });
    const result = await computeCorrelationMatrixAnalyzeResult(ctx);
    const byPair = new Map(result.cells.map((c) => [`${c.xKey}::${c.yKey}`, c]));
    expect(byPair.get('a::b')?.suppressed).toBe(true);
    expect(byPair.get('b::c')?.suppressed).toBe(true);
    // a-c는 계산 가능했지만 매트릭스에 억제 셀이 있어 adjustedP는 null.
    const ac = byPair.get('a::c');
    expect(ac?.suppressed).toBe(false);
    if (ac && !ac.suppressed) expect(ac.adjustedP).toBeNull();
  });

  it('cells는 항상 C(k,2)개 — 전부 억제여도 빈 배열이 아니다', async () => {
    const n = 3; // 소수셀 유발
    const rows = makeRows(n, {
      a: [1, 2, 3], b: [4, 5, 6], c: [7, 8, 9],
    });
    const ctx = makeCtx(rows, ['a', 'b', 'c']);
    runCorrelationMatrixStatsEngine.mockResolvedValueOnce({
      method: 'pearson_correlation',
      cells: [
        { xKey: 'a', yKey: 'b', n: 3, r: 1.0, pValue: 0.01, adjustedP: 0.01 },
        { xKey: 'a', yKey: 'c', n: 3, r: 1.0, pValue: 0.01, adjustedP: 0.01 },
        { xKey: 'b', yKey: 'c', n: 3, r: 1.0, pValue: 0.01, adjustedP: 0.01 },
      ],
    });
    const result = await computeCorrelationMatrixAnalyzeResult(ctx);
    expect(result.cells).toHaveLength(3);
    expect(result.cells.every((c) => c.suppressed)).toBe(true);
  });
});

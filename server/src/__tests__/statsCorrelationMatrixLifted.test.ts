// 제한데이터(stats.export_limited_rows) 권한자의 상관행렬 해제 — 일반본·해제본 조립 단위 테스트.
// 해제본은 pair별 레이어1(포함/제외 인원 소수 셀)만 끈다. 반복측정 게이트와 Python 계산 불가는 풀리지 않고,
// 대신 해제본의 억제 셀에는 그 사유가 붙는다(일반본에는 사유가 절대 붙지 않는다).
// Python은 공개 정책을 모르고 계산 가능한 모든 쌍으로 BH-FDR을 하므로 엔진은 한 번만 부르면 된다.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

const runCorrelationMatrixStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return {
    ...actual,
    runCorrelationMatrixStatsEngine: (...args: unknown[]) => runCorrelationMatrixStatsEngine(...args),
  };
});

import {
  assembleCorrelationMatrix, computeCorrelationMatrixAnalyzeResult, computeCorrelationMatrixViews,
} from '../statsCorrelationMatrixSuppression';
import { buildCorrelationMatrixPairedDatasets, buildCorrelationMatrixVariables } from '../statsCorrelationMatrixDataset';
import type { AnalysisContext } from '../statsAnalysisContext';
import type { DatasetRow } from '../statsDatasetBuilder';

function makeVariable(key: string): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type: 'continuous',
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}

// n개의 1:1 person:case 행. values 배열이 n보다 짧으면 나머지는 결측.
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

function makeCtx(
  rows: DatasetRow[],
  variableKeys: string[],
  over: { disclosureMode?: 'lifted'; requestSuppressed?: boolean } = {},
): AnalysisContext {
  return {
    orgId: 'org', userId: 'user',
    recipe: {
      grain: 'case', variableKeys, filters: [], analysisPurpose: 'association',
      formulaPolicies: {}, analysisMode: 'correlation_matrix', requestedMethod: 'pearson_correlation',
    },
    catalogByKey: new Map(variableKeys.map((k) => [k, makeVariable(k)])),
    recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    differencing: { forceSuppress: false, remaining: 10 } as AnalysisContext['differencing'],
    snapshot: {} as AnalysisContext['snapshot'],
    dataset: { rows, personCount: rows.length, caseCount: rows.length, observationCount: rows.length, distinctAssignedDoctorClusters: 0, internalResultDigest: 'x' } as AnalysisContext['dataset'],
    requestSuppressed: over.requestSuppressed ?? false,
    reasonCode: over.requestSuppressed ? 'MIN_COHORT_NOT_MET' : null,
    paired: null, pairDisclosed: false, availableMethods: [], methodCatalogVersion: 'v1',
    correlationMatrixPairs: buildCorrelationMatrixPairedDatasets(rows, variableKeys),
    correlationMatrixVariables: buildCorrelationMatrixVariables(rows, variableKeys),
    regressionDisclosed: false, regressionDesign: null, regressionExcludedRowCount: null, regressionMethod: null,
    predictionDisclosed: false, predictionState: null, descriptiveStratifyPartition: null,
    disclosureMode: over.disclosureMode,
  };
}

// c는 5명만 관측 — a-c, b-c는 포함 5명(소수 셀)·제외 45명이라 제한 모드에서 레이어1에 걸린다. a-b는 완전 관측.
const N = 50;
const rowsSmallC = () => makeRows(N, {
  a: Array.from({ length: N }, (_, i) => i),
  b: Array.from({ length: N }, (_, i) => i * 2),
  c: Array.from({ length: 5 }, (_, i) => i),
});
const rawAllComputed = {
  method: 'pearson_correlation',
  cells: [
    { xKey: 'a', yKey: 'b', n: N, r: 1.0, pValue: 0.0, adjustedP: 0.0 },
    { xKey: 'a', yKey: 'c', n: 5, r: 0.9, pValue: 0.04, adjustedP: 0.06 },
    { xKey: 'b', yKey: 'c', n: 5, r: 0.8, pValue: 0.1, adjustedP: 0.1 },
  ],
};

beforeEach(() => { vi.resetAllMocks(); });

describe('assembleCorrelationMatrix — 제한 vs 해제', () => {
  it('제한 모드: 소수 셀 쌍은 사유 없이 억제되고 adjustedP는 전체 null이다(기존 동작)', () => {
    const result = assembleCorrelationMatrix(makeCtx(rowsSmallC(), ['a', 'b', 'c']), rawAllComputed as never);
    expect(result.adjustedPWithheld).toBe(true);
    const byKey = Object.fromEntries(result.cells.map((c) => [`${c.xKey}-${c.yKey}`, c]));
    expect(byKey['a-c']).toEqual({ suppressed: true, xKey: 'a', yKey: 'c' }); // 사유 필드 자체가 없다
    expect(byKey['b-c']).toEqual({ suppressed: true, xKey: 'b', yKey: 'c' });
    expect(byKey['a-b']).toMatchObject({ suppressed: false, adjustedP: null });
  });

  it('해제 모드: 소수 인원 때문에 억제되던 쌍이 풀리고, 억제 셀이 없으면 adjustedP도 공개된다', () => {
    const result = assembleCorrelationMatrix(makeCtx(rowsSmallC(), ['a', 'b', 'c'], { disclosureMode: 'lifted' }), rawAllComputed as never);
    expect(result.adjustedPWithheld).toBe(false);
    const byKey = Object.fromEntries(result.cells.map((c) => [`${c.xKey}-${c.yKey}`, c]));
    expect(byKey['a-c']).toMatchObject({ suppressed: false, n: 5, r: 0.9, adjustedP: 0.06 });
    expect(byKey['b-c']).toMatchObject({ suppressed: false, n: 5, r: 0.8, adjustedP: 0.1 });
  });

  it('해제 모드에서도 Python 계산 불가는 풀리지 않고 NOT_COMPUTABLE 사유가 붙으며, 남은 억제 셀 때문에 adjustedP는 계속 비공개다', () => {
    const raw = {
      method: 'pearson_correlation',
      cells: [
        { xKey: 'a', yKey: 'b', n: N, r: 1.0, pValue: 0.0, adjustedP: 0.0 },
        { xKey: 'a', yKey: 'c', n: 5, r: null, pValue: null, adjustedP: null }, // 계산 불가(예: 분산 0)
        { xKey: 'b', yKey: 'c', n: 5, r: 0.8, pValue: 0.1, adjustedP: 0.1 },
      ],
    };
    const result = assembleCorrelationMatrix(makeCtx(rowsSmallC(), ['a', 'b', 'c'], { disclosureMode: 'lifted' }), raw as never);
    const byKey = Object.fromEntries(result.cells.map((c) => [`${c.xKey}-${c.yKey}`, c]));
    expect(byKey['a-c']).toEqual({ suppressed: true, xKey: 'a', yKey: 'c', reasonCode: 'NOT_COMPUTABLE' });
    expect(byKey['a-b']).toMatchObject({ suppressed: false, adjustedP: null });
    expect(result.adjustedPWithheld).toBe(true);
  });

  it('해제 모드에서도 반복측정 게이트(한 사람이 여러 사례)는 풀리지 않고 REPEATED_MEASURES_NOT_ALIGNED 사유가 붙는다', () => {
    const rows = makeRows(N, {
      a: Array.from({ length: N }, (_, i) => i),
      b: Array.from({ length: N }, (_, i) => i * 2),
      c: Array.from({ length: N }, (_, i) => N - i),
    });
    rows[1] = { ...rows[1], personClusterKey: rows[0].personClusterKey }; // p0이 두 사례
    const raw = {
      method: 'pearson_correlation',
      cells: [
        { xKey: 'a', yKey: 'b', n: N, r: 1.0, pValue: 0.0, adjustedP: 0.0 },
        { xKey: 'a', yKey: 'c', n: N, r: -1.0, pValue: 0.0, adjustedP: 0.0 },
        { xKey: 'b', yKey: 'c', n: N, r: -1.0, pValue: 0.0, adjustedP: 0.0 },
      ],
    };
    const result = assembleCorrelationMatrix(makeCtx(rows, ['a', 'b', 'c'], { disclosureMode: 'lifted' }), raw as never);
    expect(result.cells.every((c) => c.suppressed && c.reasonCode === 'REPEATED_MEASURES_NOT_ALIGNED')).toBe(true);
  });

  it('computeCorrelationMatrixAnalyzeResult(기존 진입점)는 컨텍스트 모드를 따라 같은 조립을 한다', async () => {
    runCorrelationMatrixStatsEngine.mockResolvedValue(rawAllComputed);
    const restricted = await computeCorrelationMatrixAnalyzeResult(makeCtx(rowsSmallC(), ['a', 'b', 'c']));
    const lifted = await computeCorrelationMatrixAnalyzeResult(makeCtx(rowsSmallC(), ['a', 'b', 'c'], { disclosureMode: 'lifted' }));
    expect(restricted.cells.filter((c) => c.suppressed)).toHaveLength(2);
    expect(lifted.cells.filter((c) => c.suppressed)).toHaveLength(0);
  });
});

describe('computeCorrelationMatrixViews — 엔진 1회로 두 표시본', () => {
  it('엔진을 한 번만 호출하고 일반본은 억제, 해제본은 공개로 조립한다', async () => {
    runCorrelationMatrixStatsEngine.mockResolvedValue(rawAllComputed);
    const restricted = makeCtx(rowsSmallC(), ['a', 'b', 'c']);
    const lifted = makeCtx(rowsSmallC(), ['a', 'b', 'c'], { disclosureMode: 'lifted' });

    const views = await computeCorrelationMatrixViews(restricted, lifted);
    expect(runCorrelationMatrixStatsEngine).toHaveBeenCalledTimes(1);
    expect(views.aggregate.correlationMatrix?.cells.filter((c) => c.suppressed)).toHaveLength(2);
    expect(views.limited.correlationMatrix?.cells.filter((c) => c.suppressed)).toHaveLength(0);
    // 일반본에는 해제 수치가 하나도 없어야 한다 — 소수 셀 쌍의 r값이 새면 안 된다.
    expect(JSON.stringify(views.aggregate)).not.toContain('0.9');
    expect(JSON.stringify(views.aggregate)).not.toContain('"r":0.8');
  });

  it('전체 N<10으로 일반본 쪽이 요청 수준 억제면 일반본은 기존 전체 억제 스텁이고, 해제본은 정상 조립된다', async () => {
    runCorrelationMatrixStatsEngine.mockResolvedValue(rawAllComputed);
    const restricted = makeCtx(rowsSmallC(), ['a', 'b', 'c'], { requestSuppressed: true });
    const lifted = makeCtx(rowsSmallC(), ['a', 'b', 'c'], { disclosureMode: 'lifted' });

    const views = await computeCorrelationMatrixViews(restricted, lifted);
    const aggregate = views.aggregate.correlationMatrix!;
    expect(aggregate.cells).toHaveLength(3);
    expect(aggregate.cells.every((c) => c.suppressed)).toBe(true);
    expect(aggregate.adjustedPWithheld).toBe(true);
    expect(views.limited.correlationMatrix?.cells.every((c) => !c.suppressed)).toBe(true);
  });
});

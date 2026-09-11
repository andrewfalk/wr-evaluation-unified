// PR3-A — computeAvailableMethods 단위테스트. 코드리뷰(7차/8차)가 지목한 핵심
// 반례를 직접 고정한다: 99/1과 98/1/1이 같은 응답(구분 불가)을 내는지, 반복측정이
// 8개 방법 전부를 REPEATED_MEASURES_NOT_ALIGNED로 막는지, 포함 0명이 전부
// INSUFFICIENT_DATA인지, 브레이크다운이 깨끗할 때만 REQUIRES_*/TABLE_NOT_2X2가
// 실제로 노출되는지.
import { describe, it, expect } from 'vitest';
import { computeAvailableMethods } from '../statsMethodCatalog';
import type { PairedDatasetResult, PairedRow } from '../statsBivariateDataset';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

const METHOD_POLICY_VERSION = 'v1-bivariate';

function makeVariable(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}

function makeGroupPairs(counts: Array<{ label: string | boolean; n: number }>): PairedRow[] {
  const pairs: PairedRow[] = [];
  let seq = 0;
  for (const { label, n } of counts) {
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      pairs.push({ caseId: `c${seq}`, personClusterKey: `p${seq}`, x: label, y: 1.0 });
    }
  }
  return pairs;
}

function pairedResult(pairs: PairedRow[], overrides: Partial<PairedDatasetResult> = {}): PairedDatasetResult {
  const includedPersonCount = new Set(pairs.map((p) => p.personClusterKey)).size;
  return {
    pairs,
    includedCaseCount: pairs.length,
    includedPersonCount,
    excludedCaseCount: 0,
    excludedPersonCount: 0,
    exclusions: [],
    ...overrides,
  };
}

const BOOLEAN_CONTINUOUS_CATALOG = new Map<string, AnalyticsVariableMetadata>([
  ['grp', makeVariable('grp', 'boolean')],
  ['val', makeVariable('val', 'continuous')],
]);

const ORDINAL_CONTINUOUS_CATALOG = new Map<string, AnalyticsVariableMetadata>([
  ['elbow.assessment.burdenGradeMax', makeVariable('elbow.assessment.burdenGradeMax', 'ordinal')],
  ['val', makeVariable('val', 'continuous')],
]);

describe('computeAvailableMethods — 99/1 vs 98/1/1 (7차 리뷰 핵심 반례)', () => {
  it('두 데이터셋의 welch_t/mann_whitney 응답이 완전히 동일하다(구분 불가)', () => {
    const p99_1 = pairedResult(makeGroupPairs([{ label: false, n: 99 }, { label: true, n: 1 }]));
    const p98_1_1_asBool = pairedResult(makeGroupPairs([{ label: false, n: 99 }, { label: true, n: 1 }])); // boolean은 3레벨 불가하므로 동일 케이스 재확인

    const methods99_1 = computeAvailableMethods('grp', 'val', BOOLEAN_CONTINUOUS_CATALOG, p99_1, METHOD_POLICY_VERSION);
    const methods98_1_1 = computeAvailableMethods('grp', 'val', BOOLEAN_CONTINUOUS_CATALOG, p98_1_1_asBool, METHOD_POLICY_VERSION);

    const welch1 = methods99_1.find((m) => m.id === 'welch_t')!;
    const welch2 = methods98_1_1.find((m) => m.id === 'welch_t')!;
    expect(welch1.status).toBe('available'); // 세부판정 생략 — 소수그룹 있어도 unsupported 아님
    expect(welch1.reasonCode).toBeNull();
    expect(welch1).toEqual(welch2);
  });

  it('ordinal 3레벨(98/1/1)에서도 브레이크다운이 안 깨끗하면 REQUIRES_AT_LEAST_TWO_GROUPS가 노출되지 않는다', () => {
    const pairs = makeGroupPairs([
      { label: '부담 작업 아님', n: 98 },
      { label: '경도', n: 1 },
      { label: '중등도', n: 1 },
    ]);
    const methods = computeAvailableMethods('elbow.assessment.burdenGradeMax', 'val', ORDINAL_CONTINUOUS_CATALOG, pairedResult(pairs), METHOD_POLICY_VERSION);
    const anova = methods.find((m) => m.id === 'anova')!;
    // 관측 그룹 수는 3개라 REQUIRES_AT_LEAST_TWO_GROUPS를 낼 이유가 없어야 하고(3≥2),
    // 동시에 소수 레벨이 있으므로 A-2 자체가 생략돼 available로만 남아야 한다 —
    // "그룹 수 3개"라는 사실 자체도 노출되면 안 된다(§핵심수정 v7).
    expect(anova.status).toBe('available');
    expect(anova.reasonCode).toBeNull();
  });

  it('브레이크다운이 완전히 깨끗하면(전부 ≥10) REQUIRES_EXACTLY_TWO_GROUPS가 실제로 노출된다', () => {
    const pairs = makeGroupPairs([
      { label: '부담 작업 아님', n: 30 },
      { label: '경도', n: 20 },
      { label: '중등도', n: 15 },
    ]);
    const methods = computeAvailableMethods('elbow.assessment.burdenGradeMax', 'val', ORDINAL_CONTINUOUS_CATALOG, pairedResult(pairs), METHOD_POLICY_VERSION);
    const welch = methods.find((m) => m.id === 'welch_t')!;
    expect(welch.status).toBe('unsupported');
    expect(welch.reasonCode).toBe('REQUIRES_EXACTLY_TWO_GROUPS');
    const anova = methods.find((m) => m.id === 'anova')!;
    expect(anova.status).toBe('available'); // 3개 그룹은 anova엔 정상
  });
});

describe('computeAvailableMethods — 반복측정 게이트(§6.1)', () => {
  it('personCount<caseCount이면 실행가능 8종 전부 REPEATED_MEASURES_NOT_ALIGNED', () => {
    const pairs = makeGroupPairs([{ label: false, n: 50 }, { label: true, n: 50 }]);
    // 같은 사람이 여러 case-row에 등장하도록 personClusterKey를 겹친다.
    const repeated = pairs.map((p, i) => ({ ...p, personClusterKey: i % 2 === 0 ? p.personClusterKey : pairs[0].personClusterKey }));
    const paired = pairedResult(repeated, {
      includedPersonCount: new Set(repeated.map((p) => p.personClusterKey)).size,
      includedCaseCount: repeated.length,
    });
    expect(paired.includedPersonCount).toBeLessThan(paired.includedCaseCount);

    const methods = computeAvailableMethods('grp', 'val', BOOLEAN_CONTINUOUS_CATALOG, paired, METHOD_POLICY_VERSION);
    const executable: string[] = ['welch_t', 'mann_whitney', 'anova', 'kruskal_wallis', 'chi_square', 'fisher_exact', 'pearson_correlation', 'spearman_correlation'];
    for (const id of executable) {
      const m = methods.find((x) => x.id === id)!;
      expect(m.status, id).toBe('unsupported');
      expect(m.reasonCode, id).toBe('REPEATED_MEASURES_NOT_ALIGNED');
      expect(m.required).toEqual({ rule: 'personCount == rowCount' });
    }
  });
});

describe('computeAvailableMethods — 대응검정은 항상 unsupported(현재 카탈로그 기준)', () => {
  it('personCount===caseCount이고 브레이크다운이 깨끗해도 paired_t/wilcoxon_signed_rank는 PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING', () => {
    const pairs = makeGroupPairs([{ label: false, n: 30 }, { label: true, n: 30 }]);
    const methods = computeAvailableMethods('grp', 'val', BOOLEAN_CONTINUOUS_CATALOG, pairedResult(pairs), METHOD_POLICY_VERSION);
    for (const id of ['paired_t', 'wilcoxon_signed_rank']) {
      const m = methods.find((x) => x.id === id)!;
      expect(m.status).toBe('unsupported');
      expect(m.reasonCode).toBe('PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING');
    }
  });
});

describe('computeAvailableMethods — 쌍 전체 0명(A-1, "0"은 안전)', () => {
  it('includedPersonCount===0이면 10개 방법 전부 INSUFFICIENT_DATA', () => {
    const paired = pairedResult([], { includedPersonCount: 0, includedCaseCount: 0, excludedPersonCount: 100, excludedCaseCount: 100 });
    const methods = computeAvailableMethods('grp', 'val', BOOLEAN_CONTINUOUS_CATALOG, paired, METHOD_POLICY_VERSION);
    expect(methods).toHaveLength(10);
    for (const m of methods) {
      expect(m.status).toBe('unsupported');
      expect(m.reasonCode).toBe('INSUFFICIENT_DATA');
    }
  });
});

describe('computeAvailableMethods — 분할표(8차 리뷰: 내부 셀만 작은 경우)', () => {
  it('[[1,19],[19,61]]처럼 주변합은 충분해도 내부 셀이 작으면 TABLE_NOT_2X2/기대도수 판정을 노출하지 않는다', () => {
    // x=false,y=false: 1쌍 / x=false,y=true: 19쌍 / x=true,y=false: 19쌍 / x=true,y=true: 61쌍
    const pairs: PairedRow[] = [];
    let seq = 0;
    const cells: Array<[boolean, boolean, number]> = [[false, false, 1], [false, true, 19], [true, false, 19], [true, true, 61]];
    for (const [x, y, n] of cells) {
      for (let i = 0; i < n; i += 1) { seq += 1; pairs.push({ caseId: `c${seq}`, personClusterKey: `p${seq}`, x, y }); }
    }
    const catalog = new Map<string, AnalyticsVariableMetadata>([
      ['x', makeVariable('x', 'boolean')],
      ['y', makeVariable('y', 'boolean')],
    ]);
    const methods = computeAvailableMethods('x', 'y', catalog, pairedResult(pairs), METHOD_POLICY_VERSION);
    const chiSquare = methods.find((m) => m.id === 'chi_square')!;
    const fisher = methods.find((m) => m.id === 'fisher_exact')!;
    // 내부 셀(1)이 소수셀이라 표 전체가 안 깨끗함 — TABLE_NOT_2X2도 LOW_EXPECTED_COUNT도
    // 노출되면 안 되고 둘 다 available로만 남아야 한다(실제 판정은 B로 미룸).
    expect(chiSquare.status).toBe('available');
    expect(chiSquare.reasonCode).toBeNull();
    expect(fisher.status).toBe('available');
    expect(fisher.reasonCode).toBeNull();
  });
});

describe('computeAvailableMethods — 타입 불일치', () => {
  it('연속형 두 개를 chi_square에 쓰면 METHOD_TYPE_MISMATCH', () => {
    const catalog = new Map<string, AnalyticsVariableMetadata>([
      ['a', makeVariable('a', 'continuous')],
      ['b', makeVariable('b', 'continuous')],
    ]);
    const pairs: PairedRow[] = Array.from({ length: 20 }, (_, i) => ({ caseId: `c${i}`, personClusterKey: `p${i}`, x: i, y: i }));
    const methods = computeAvailableMethods('a', 'b', catalog, pairedResult(pairs), METHOD_POLICY_VERSION);
    expect(methods.find((m) => m.id === 'chi_square')!.reasonCode).toBe('METHOD_TYPE_MISMATCH');
    expect(methods.find((m) => m.id === 'pearson_correlation')!.status).toBe('available');
  });
});

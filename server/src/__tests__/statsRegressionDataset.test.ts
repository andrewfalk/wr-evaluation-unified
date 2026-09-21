// PR4-A1 — statsRegressionDataset.ts(①②) 단위테스트. 완전사례 대칭 판정·레벨/
// event 요약이 disclosure gate가 기대하는 입력을 정확히 만드는지 고정한다.
import { describe, it, expect } from 'vitest';
import {
  computeRegressionCompleteCase,
  computeRegressionLevelSummaries,
  computeRegressionEventSummary,
  evaluateRegressionInputLimits,
} from '../statsRegressionDataset';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';

function makeVariable(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}
function makeRow(caseId: string, personClusterKey: string, values: DatasetRow['values']): DatasetRow {
  return { caseId, personClusterKey, values };
}
function presentValue<T>(value: T): ExtractedValue<T> {
  return { value, missing: null, qualityFlags: [] };
}
function missingValue(): ExtractedValue<null> {
  return { value: null, missing: 'not_entered', qualityFlags: [] };
}

describe('evaluateRegressionInputLimits', () => {
  it('상한 이내면 통과', () => {
    expect(evaluateRegressionInputLimits(1000, 5).ok).toBe(true);
  });
  it('행 수가 변수당 상한을 넘으면 VALUES_PER_VARIABLE_EXCEEDED', () => {
    const r = evaluateRegressionInputLimits(60000, 2);
    expect(r).toEqual({ ok: false, violation: 'VALUES_PER_VARIABLE_EXCEEDED' });
  });
  it('총 값 개수가 상한을 넘으면 TOTAL_VALUES_EXCEEDED', () => {
    const r = evaluateRegressionInputLimits(40000, 10);
    expect(r).toEqual({ ok: false, violation: 'TOTAL_VALUES_EXCEEDED' });
  });
});

describe('computeRegressionCompleteCase — 리뷰 #3 대칭 판정', () => {
  it('outcome 또는 predictor 중 하나라도 결측이면 제외된다', () => {
    const rows: DatasetRow[] = [
      makeRow('c1', 'p1', { y: presentValue(1.0), x1: presentValue(2.0) }),
      makeRow('c2', 'p2', { y: missingValue(), x1: presentValue(2.0) }),
      makeRow('c3', 'p3', { y: presentValue(1.0), x1: missingValue() }),
    ];
    const result = computeRegressionCompleteCase(rows, 'y', ['x1']);
    expect(result.completeRows).toHaveLength(1);
    expect(result.completeRows[0].caseId).toBe('c1');
    expect(result.includedPersonCount).toBe(1);
    expect(result.excludedPersonCount).toBe(2);
    expect(result.excludedRowCount).toBe(2);
  });

  it('100명 포함/1명 제외처럼 비대칭이어도 두 카운트를 각각 정확히 낸다(공개통제 입력의 정확성)', () => {
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push(makeRow(`c${i}`, `p${i}`, { y: presentValue(1.0), x1: presentValue(2.0) }));
    }
    rows.push(makeRow('c-missing', 'p-missing', { y: missingValue(), x1: presentValue(2.0) }));
    const result = computeRegressionCompleteCase(rows, 'y', ['x1']);
    expect(result.includedPersonCount).toBe(100);
    expect(result.excludedPersonCount).toBe(1);
  });
});

describe('computeRegressionLevelSummaries', () => {
  it('categorical/ordinal predictor만 레벨-person 요약을 낸다(continuous/boolean 제외)', () => {
    const catalog = new Map([
      ['group', makeVariable('group', 'categorical')],
      ['age', makeVariable('age', 'continuous')],
      ['flag', makeVariable('flag', 'boolean')],
    ]);
    const rows: DatasetRow[] = [
      makeRow('c1', 'p1', { group: presentValue('A'), age: presentValue(20), flag: presentValue(true) }),
      makeRow('c2', 'p2', { group: presentValue('B'), age: presentValue(30), flag: presentValue(false) }),
      makeRow('c3', 'p3', { group: presentValue('A'), age: presentValue(25), flag: presentValue(true) }),
    ];
    const summaries = computeRegressionLevelSummaries(rows, ['group', 'age', 'flag'], catalog);
    expect(summaries).toHaveLength(2); // group=A, group=B만
    const a = summaries.find((s) => s.level === 'A')!;
    const b = summaries.find((s) => s.level === 'B')!;
    expect(a.personCount).toBe(2);
    expect(b.personCount).toBe(1);
    expect(summaries.every((s) => s.variableKey === 'group')).toBe(true);
  });
});

describe('computeRegressionEventSummary', () => {
  it('boolean outcome이 아니면 null', () => {
    const rows: DatasetRow[] = [makeRow('c1', 'p1', { y: presentValue(1.0) })];
    expect(computeRegressionEventSummary(rows, 'y', 'continuous')).toBeNull();
  });

  it('boolean outcome이면 event/non-event person 수를 센다(person 고유, 행 아님)', () => {
    const rows: DatasetRow[] = [
      makeRow('c1', 'p1', { y: presentValue(true) }),
      // 같은 사람 p1이 event 쪽 행을 하나 더 가져도 person 수는 1로 유지되어야 함.
      makeRow('c1b', 'p1', { y: presentValue(true) }),
      makeRow('c2', 'p2', { y: presentValue(false) }),
    ];
    const summary = computeRegressionEventSummary(rows, 'y', 'boolean');
    expect(summary).toEqual({ eventPersonCount: 1, nonEventPersonCount: 1 });
  });
});

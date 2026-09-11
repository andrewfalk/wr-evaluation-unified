// PR3-A — buildPairedDataset/groupPairsByLevel 단위테스트. 코드리뷰(2026-09-12)가
// 지적한 "새 Node 공개통제·HTTP 경로의 핵심 회귀 테스트 누락"에 대응 — 쌍 추출이
// 대칭 억제(§핵심수정5)와 관측순서 보존(§방향규칙)을 실제로 지키는지 확인한다.
import { describe, it, expect } from 'vitest';
import { buildPairedDataset, groupPairsByLevel } from '../statsBivariateDataset';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { ExtractedValue } from '@wr/analytics-core';

function presentValue<T>(value: T): ExtractedValue<T> {
  return { value, missing: null, qualityFlags: [] };
}
function missingValue(): ExtractedValue<null> {
  return { value: null, missing: 'not_entered', qualityFlags: [] };
}
function makeRow(caseId: string, personClusterKey: string, values: DatasetRow['values']): DatasetRow {
  return { caseId, personClusterKey, values };
}

describe('buildPairedDataset — complete-case 추출', () => {
  it('x·y 둘 다 non-missing인 행만 쌍으로 추출한다', () => {
    const rows: DatasetRow[] = [
      makeRow('c1', 'p1', { x: presentValue(1), y: presentValue('a') }),
      makeRow('c2', 'p2', { x: missingValue(), y: presentValue('b') }),
      makeRow('c3', 'p3', { x: presentValue(2), y: missingValue() }),
      makeRow('c4', 'p4', { x: missingValue(), y: missingValue() }),
    ];
    const result = buildPairedDataset(rows, 'x', 'y');
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ caseId: 'c1', personClusterKey: 'p1', x: 1, y: 'a' });
    expect(result.includedCaseCount).toBe(1);
    expect(result.includedPersonCount).toBe(1);
    expect(result.excludedCaseCount).toBe(3);
    expect(result.excludedPersonCount).toBe(3);
  });

  it('제외 사유별로 person count를 따로 센다(사유당 독립 대칭억제 판정의 입력)', () => {
    const rows: DatasetRow[] = [
      makeRow('c1', 'p1', { x: presentValue(1), y: presentValue('a') }),
      makeRow('c2', 'p2', { x: missingValue(), y: presentValue('b') }),      // x_missing
      makeRow('c3', 'p3', { x: presentValue(2), y: missingValue() }),        // y_missing
      makeRow('c4', 'p4', { x: missingValue(), y: missingValue() }),         // both_missing
      makeRow('c5', 'p4', { x: missingValue(), y: missingValue() }),         // p4가 사례 2건(같은 사람)
    ];
    const result = buildPairedDataset(rows, 'x', 'y');
    const byReason = Object.fromEntries(result.exclusions.map((e) => [e.reasonCode, e]));
    expect(byReason.x_missing).toEqual({ reasonCode: 'x_missing', count: 1, personCount: 1 });
    expect(byReason.y_missing).toEqual({ reasonCode: 'y_missing', count: 1, personCount: 1 });
    // both_missing은 case 2건(c4,c5)이지만 person은 1명(p4)뿐 — case count와 person
    // count가 다를 수 있다는 걸 대칭억제 판정이 person 기준으로 해야 하는 이유.
    expect(byReason.both_missing).toEqual({ reasonCode: 'both_missing', count: 2, personCount: 1 });
  });

  it('포함 0명(전부 결측)이어도 크래시하지 않고 0을 반환한다(A-1 INSUFFICIENT_DATA 입력)', () => {
    const rows: DatasetRow[] = Array.from({ length: 12 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { x: missingValue(), y: missingValue() }));
    const result = buildPairedDataset(rows, 'x', 'y');
    expect(result.includedPersonCount).toBe(0);
    expect(result.excludedPersonCount).toBe(12);
    expect(result.pairs).toHaveLength(0);
  });
});

describe('groupPairsByLevel — 고정 순서·관측 레벨', () => {
  it('order 순서대로 그룹을 반환하고(데이터 등장 순서 아님), 미관측 레벨은 excludedEmptyLevels로 보고한다', () => {
    const pairs = [
      { caseId: 'c1', personClusterKey: 'p1', x: true, y: 1 },
      { caseId: 'c2', personClusterKey: 'p2', x: false, y: 2 },
      { caseId: 'c3', personClusterKey: 'p3', x: true, y: 3 },
    ];
    // 데이터는 true가 먼저 등장하지만 order=[false,true]로 고정 순서를 강제한다.
    const { groups, excludedEmptyLevels } = groupPairsByLevel(pairs, 'x', [false, true]);
    expect([...groups.keys()]).toEqual([false, true]); // 등장 순서(true,false,true)가 아니라 order 순서
    expect(groups.get(true)).toHaveLength(2);
    expect(groups.get(false)).toHaveLength(1);
    expect(excludedEmptyLevels).toEqual([]);
  });

  it('관측되지 않은 레벨은 groups에 없고 excludedEmptyLevels에만 나온다', () => {
    const pairs = [{ caseId: 'c1', personClusterKey: 'p1', x: '경도', y: 1 }];
    const order = ['부담 작업 아님', '경도', '중등도', '고도'];
    const { groups, excludedEmptyLevels } = groupPairsByLevel(pairs, 'x', order);
    expect([...groups.keys()]).toEqual(['경도']);
    expect(excludedEmptyLevels).toEqual(['부담 작업 아님', '중등도', '고도']);
  });
});

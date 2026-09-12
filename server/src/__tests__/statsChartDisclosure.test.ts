// PR3-B 계획서 §1/§3 — 히스토그램 bin 전체연결억제 + 이상치 전용 partition
// 게이트(히스토그램 게이트와 완전히 별개). §1의 반례를 정확히 재현해 고정한다.
import { describe, expect, it } from 'vitest';
import type { DatasetRow } from '../statsDatasetBuilder';
import {
  computeOutlierValues,
  isHistogramDisclosable,
  isOutlierCountDisclosable,
} from '../statsChartDisclosure';

const KEY = 'v';

function row(i: number, personKey: string, value: number): DatasetRow {
  return {
    caseId: `case-${i}`,
    personClusterKey: personKey,
    values: { [KEY]: { value, missing: null, qualityFlags: [] } },
  };
}

// 1:1 person:case로 n개의 행을 만든다(각 값이 서로 다른 사람).
function distinctPersonRows(values: number[]): DatasetRow[] {
  return values.map((v, i) => row(i, `person-${i}`, v));
}

function valueOf(r: DatasetRow): number | null {
  const extracted = r.values[KEY];
  if (!extracted || extracted.missing !== null) return null;
  return typeof extracted.value === 'number' ? extracted.value : null;
}

describe('isHistogramDisclosable', () => {
  it('모든 bin이 person 소수셀 없이 깨끗하면 공개 가능', () => {
    const values = [
      ...Array.from({ length: 50 }, () => 0),
      ...Array.from({ length: 50 }, () => 10),
    ];
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 5, count: 50 },
      { lower: 5, upper: 10, count: 0 },
      { lower: 10, upper: 15, count: 50 },
    ];
    expect(isHistogramDisclosable(rows, bins, valueOf)).toBe(true);
  });

  it('어느 한 bin이라도 person 소수셀이면 전체 억제', () => {
    const values = [
      ...Array.from({ length: 95 }, () => 0),
      ...Array.from({ length: 5 }, () => 10), // 5명 — 소수셀
    ];
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 5, count: 95 },
      { lower: 5, upper: 10, count: 0 },
      { lower: 10, upper: 15, count: 5 },
    ];
    expect(isHistogramDisclosable(rows, bins, valueOf)).toBe(false);
  });

  it('마지막 bin은 양끝 포함(numpy.histogram과 동일한 경계 규칙)', () => {
    const values = Array.from({ length: 20 }, () => 10); // 정확히 상단 경계값
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 5, count: 0 },
      { lower: 5, upper: 10, count: 20 }, // 마지막 bin이라 10 포함
    ];
    expect(isHistogramDisclosable(rows, bins, valueOf)).toBe(true);
  });

  it('count===0인 bin은 사람이 없으므로 검사를 건너뛴다(에러 없이 통과)', () => {
    const rows = distinctPersonRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const bins = [{ lower: 0, upper: 100, count: 10 }, { lower: 100, upper: 200, count: 0 }];
    expect(isHistogramDisclosable(rows, bins, valueOf)).toBe(true);
  });
});

describe('isOutlierCountDisclosable — 계획서 §1의 반례', () => {
  it('히스토그램 게이트를 전부 통과해도 이상치가 소수집단이면 억제된다(원 반례)', () => {
    // 0×50 / 1×26 / 2.49×23 / 2.51×1, n=100 — Q1=0, Q3=1(직접 계산 확인).
    const values = [
      ...Array.from({ length: 50 }, () => 0),
      ...Array.from({ length: 26 }, () => 1),
      ...Array.from({ length: 23 }, () => 2.49),
      2.51,
    ];
    const rows = distinctPersonRows(values);
    // fence = Q1-1.5·IQR=-1.5, Q3+1.5·IQR=2.5 — 2.51만 이상치(1명).
    expect(isOutlierCountDisclosable(rows, { q1: 0, q3: 1 }, valueOf)).toBe(false);
    expect(computeOutlierValues(rows, { q1: 0, q3: 1 }, valueOf)).toEqual([2.51]);
  });

  it('반대 방향 반례 — 이상치가 다수, 비이상치가 소수(반복기록으로 가능)', () => {
    // 비이상치 구간[0,1] 안의 값이 1명뿐이고, 이상치 구간 밖 값이 10명 — 비이상치
    // partition이 소수셀이면 (이상치 partition이 크더라도) 전체가 억제돼야 한다.
    const values = [
      0.5, // 비이상치 1명뿐
      ...Array.from({ length: 10 }, () => 100), // 이상치 10명
    ];
    const rows = distinctPersonRows(values);
    // q1=q3=0.5로 두면 iqr=0, fence=[0.5,0.5] — 0.5만 비이상치, 100은 전부 이상치.
    expect(isOutlierCountDisclosable(rows, { q1: 0.5, q3: 0.5 }, valueOf)).toBe(false);
  });

  it('양쪽 partition 모두 충분하면 공개 가능', () => {
    const values = [
      ...Array.from({ length: 20 }, () => 5), // 비이상치 20명
      ...Array.from({ length: 15 }, () => 100), // 이상치 15명
    ];
    const rows = distinctPersonRows(values);
    expect(isOutlierCountDisclosable(rows, { q1: 5, q3: 5 }, valueOf)).toBe(true);
  });

  it('이상치가 0명이면(전부 비이상치) 공개 가능 — isSmallCell(0)은 false', () => {
    const values = Array.from({ length: 20 }, () => 5);
    const rows = distinctPersonRows(values);
    expect(isOutlierCountDisclosable(rows, { q1: 0, q3: 10 }, valueOf)).toBe(true);
  });
});

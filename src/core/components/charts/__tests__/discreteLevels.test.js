// 범주형 "기타" 병합 표시용 가공(buildDiscreteDisplay) — 요약 탭 표와 분포 탭 차트가 같은
// 선택값을 쓰는지, 상위 N개 자르기·합계 막대·원본 우선·중복 집계 방지를 확인한다.
import { describe, expect, it } from 'vitest';
import { buildDiscreteDisplay, OTHER_LEVEL_LABEL, TOP_LEVELS_IN_CHART } from '../discreteLevels';

const lv = (level, count, total = 100) => ({ level, count, proportion: count / total });

describe('buildDiscreteDisplay', () => {
  it('other가 없으면 levels를 그대로 표·차트에 쓴다(과거 결과 호환)', () => {
    const d = buildDiscreteDisplay({ levels: [lv('A', 60), lv('B', 40)], isOrdinal: false });
    expect(d.isRaw).toBe(false);
    expect(d.hasOther).toBe(false);
    expect(d.tableRows.map((r) => [r.label, r.count, r.merged])).toEqual([['A', 60, false], ['B', 40, false]]);
    expect(d.chartRows.map((r) => r.label)).toEqual(['A', 'B']); // 건수 내림차순
  });

  it('other가 있으면 표 마지막에 "기타 (10명 미만 범주 합계)" 줄이 붙고, 차트에는 합계 막대 하나가 붙는다', () => {
    const d = buildDiscreteDisplay({
      levels: [lv('A', 40, 76), lv('B', 20, 76)], other: { count: 16, proportion: 16 / 76 }, isOrdinal: false,
    });
    expect(d.hasOther).toBe(true);
    expect(d.tableRows.map((r) => r.label)).toEqual(['A', 'B', OTHER_LEVEL_LABEL]);
    expect(d.tableRows[2]).toMatchObject({ count: 16, merged: true });
    expect(d.chartRows.map((r) => r.label)).toEqual(['A', 'B', '기타(10명 미만 범주 합계)']);
    expect(d.chartRows[2]).toMatchObject({ count: 16, merged: true });
    // 표 건수 합 = n
    expect(d.tableRows.reduce((s, r) => s + r.count, 0)).toBe(76);
  });

  it(`명목형은 차트에 상위 ${TOP_LEVELS_IN_CHART}개만 건수 순으로 그리고 나머지는 "그 외 N개 범주 + 기타" 막대 하나로 합친다. 표는 전부`, () => {
    const levels = Array.from({ length: 25 }, (_v, i) => lv(`L${i}`, 100 - i, 2000));
    const d = buildDiscreteDisplay({ levels: [...levels].reverse(), other: { count: 30, proportion: 30 / 2000 }, isOrdinal: false });
    expect(d.chartRows).toHaveLength(TOP_LEVELS_IN_CHART + 1);
    expect(d.chartRows.slice(0, 3).map((r) => r.label)).toEqual(['L0', 'L1', 'L2']); // 건수 내림차순
    const rest = d.chartRows[TOP_LEVELS_IN_CHART];
    expect(rest.label).toBe('그 외 5개 범주 + 기타');
    // 상위 밖 5개(L20~L24 = 80+79+78+77+76) + 기타 30
    expect(rest.count).toBe(80 + 79 + 78 + 77 + 76 + 30);
    expect(rest.merged).toBe(true);
    expect(d.tableRows).toHaveLength(26); // 25개 + 기타 줄(자르지 않음)
  });

  it('순서형은 정렬·자르기 없이 서버 순서 그대로다', () => {
    const levels = [lv('경도', 10), lv('중등도', 50), lv('고도', 40)];
    const d = buildDiscreteDisplay({ levels, isOrdinal: true });
    expect(d.chartRows.map((r) => r.label)).toEqual(['경도', '중등도', '고도']);
  });

  it('rawLevels가 있으면 그것을 쓰고 other는 완전히 무시한다 — 중복 집계 없음(표 건수 합 = n, 비율 합 = 100%)', () => {
    // 원본: A 40, B 20, C 12, D 1, E 3 = 76. 공개용은 A·B + 기타(C+D+E = 16).
    const raw = [lv('A', 40, 76), lv('B', 20, 76), lv('C', 12, 76), lv('D', 1, 76), lv('E', 3, 76)];
    const d = buildDiscreteDisplay({
      levels: [lv('A', 40, 76), lv('B', 20, 76)], other: { count: 16, proportion: 16 / 76 }, rawLevels: raw, isOrdinal: false,
    });
    expect(d.isRaw).toBe(true);
    expect(d.hasOther).toBe(false);
    expect(d.tableRows.reduce((s, r) => s + r.count, 0)).toBe(76);
    expect(d.tableRows.reduce((s, r) => s + r.proportion, 0)).toBeCloseTo(1, 10);
    expect(d.tableRows.some((r) => r.merged)).toBe(false);
    expect(d.chartRows.reduce((s, r) => s + r.count, 0)).toBe(76);
    expect(d.chartRows.some((r) => r.merged)).toBe(false); // 20개 이하라 합계 막대 없음
  });

  it('rawLevels가 20개를 넘으면 상위 밖은 "그 외 N개 범주"만(기타 문구 없음)', () => {
    const raw = Array.from({ length: 23 }, (_v, i) => lv(`L${i}`, 50 - i, 1000));
    const d = buildDiscreteDisplay({ levels: [], other: { count: 99, proportion: 0.1 }, rawLevels: raw, isOrdinal: false });
    const rest = d.chartRows[d.chartRows.length - 1];
    expect(rest.label).toBe('그 외 3개 범주');
    expect(rest.count).toBe(50 - 20 + 50 - 21 + 50 - 22);
    expect(d.chartRows.reduce((s, r) => s + r.count, 0)).toBe(raw.reduce((s, l) => s + l.count, 0));
  });

  it('범주 값이 실제로 "기타"여도 합계 막대와 섞이지 않는다(key·라벨 구분)', () => {
    const d = buildDiscreteDisplay({
      levels: [lv('기타', 40, 70), lv('B', 20, 70)], other: { count: 10, proportion: 10 / 70 }, isOrdinal: false,
    });
    const keys = d.chartRows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(d.chartRows.filter((r) => r.merged)).toHaveLength(1);
  });

  it('boolean 값도 문자열로 표시한다', () => {
    const d = buildDiscreteDisplay({ levels: [lv(true, 60), lv(false, 40)], isOrdinal: false });
    expect(d.tableRows.map((r) => r.label)).toEqual(['true', 'false']);
  });
});

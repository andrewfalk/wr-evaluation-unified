import { describe, expect, it, vi } from 'vitest';
import { formatPValue, formatStat } from '../numberFormat';

describe('formatPValue', () => {
  it('0.0001 미만은 "<0.0001", 경계 0.0001은 그대로 표시한다', () => {
    expect(formatPValue(1.4422231634147625e-20)).toBe('<0.0001');
    expect(formatPValue(0.00009999)).toBe('<0.0001');
    expect(formatPValue(0.0001)).toBe('0.0001');
  });
  it('소수 4자리로 맞춘다', () => {
    expect(formatPValue(0.0123456)).toBe('0.0123');
    expect(formatPValue(0.5)).toBe('0.5000');
  });
  it('null·NaN·무한대·문자열은 "—"', () => {
    for (const v of [null, undefined, NaN, Infinity, '0.01']) expect(formatPValue(v)).toBe('—');
  });
});

describe('formatStat', () => {
  it.each([
    [1.234567e-7, '1.235e-7'],
    [12345.6, '12346'],
    [1.23456, '1.235'],
    [0.012345, '0.01235'],
    [2, '2.000'],
    [9.9996, '10.000'],
    [-0.09309751621743677, '-0.09310'],
    [-12.3456, '-12.35'],
  ])('%s → %s', (input, expected) => {
    expect(formatStat(input)).toBe(expected);
  });
  it('0과 -0은 모두 "0"', () => {
    expect(formatStat(0)).toBe('0');
    expect(formatStat(-0)).toBe('0');
  });
  it('비유한·비숫자는 "—"', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, 'abc']) expect(formatStat(v)).toBe('—');
  });
});

// 권한자 원본 히스토그램의 경계 서식 — 축·툴팁·표가 같은 포매터를 쓰고, 폭이 작아도 경계가 뭉치지 않으며,
// 정확한 경계 값을 근삿값으로 보여 주지 않는다.
import { formatNumber, formatFixed, decimalsForEdges, makeEdgeFormatter } from '../numberFormat';

describe('formatFixed', () => {
  it('자릿수를 고정하고 정수부에 천 단위 쉼표를 넣는다', () => {
    expect(formatFixed(1000, 1)).toBe('1,000.0');
    expect(formatFixed(1234567.5, 2)).toBe('1,234,567.50');
    expect(formatFixed(5, 0)).toBe('5');
    expect(formatFixed(0.5, 1)).toBe('0.5');
    expect(formatFixed(999, 0)).toBe('999');
  });

  it('음수와 -0을 처리한다(-0.0 → 0.0, 음수에도 쉼표)', () => {
    expect(formatFixed(-12.5, 1)).toBe('-12.5');
    expect(formatFixed(-1234.5, 1)).toBe('-1,234.5');
    expect(formatFixed(-0, 1)).toBe('0.0');
    expect(formatFixed(-0.04, 1)).toBe('0.0'); // 반올림해서 0이 되는 음수
  });

  it('formatNumber와 달리 소수 3자리에서 잘리지 않는다(0.201~0.209가 서로 다른 라벨)', () => {
    // formatNumber는 toLocaleString() 기본 소수 3자리 제한 때문에 digits를 올려도 0.2015가 0.201이 된다.
    expect(formatNumber(0.2015, 6)).toBe('0.202'); // 알려진 제한(3자리)을 기록
    expect(formatFixed(0.2015, 4)).toBe('0.2015');
    const labels = [0.201, 0.202, 0.203, 0.204, 0.205, 0.206, 0.207, 0.208, 0.209].map((v) => formatFixed(v, 3));
    expect(new Set(labels).size).toBe(9);
    expect(labels[0]).toBe('0.201');
  });

  it('Intl·toLocaleString을 호출하지 않는다(Win7 구형 크롬 호환)', () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    try {
      formatFixed(1234567.891, 3);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('유한수가 아니면 —', () => {
    expect(formatFixed(Number.NaN, 2)).toBe('—');
    expect(formatFixed(Number.POSITIVE_INFINITY, 2)).toBe('—');
    expect(formatFixed(null, 2)).toBe('—');
  });
});

describe('decimalsForEdges', () => {
  it('정확히 왕복하는 가장 작은 자릿수를 찾는다', () => {
    expect(decimalsForEdges([0, 5, 10])).toBe(0);
    expect(decimalsForEdges([0, 0.5, 1])).toBe(1);
    expect(decimalsForEdges([0.201, 0.202, 0.203, 0.209])).toBe(3);
    expect(decimalsForEdges([-12, -10, -8])).toBe(0);
  });

  it('12자리 이하로 왕복하지 않는 경계(서버 폴백 경계)는 null', () => {
    expect(decimalsForEdges([0, 1e-13, 2e-13])).toBeNull();
    expect(decimalsForEdges([0, 1.6666666666666667e-13, 3.3333333333333334e-13])).toBeNull();
  });

  it('1e6 부근의 인접 double 경계는 부동소수점 간격(1.16e-10)이 10자리에서 왕복하므로 고정 소수 10자리가 된다', () => {
    expect(decimalsForEdges([999999.9999999999, 1000000, 1000000.0000000001])).toBe(10);
  });
});

describe('makeEdgeFormatter', () => {
  // 쉼표를 제거한 뒤 숫자로 되돌려 정확히 왕복하는지 확인한다(Number('1,000.0')은 NaN이다).
  const roundTrips = (fmt, edges) => edges.every((e) => Number(fmt(e).replace(/,/g, '')) === e);

  it('고정 소수 경로: 모든 경계가 같은 자릿수로 서로 다른 라벨이 되고 정확히 왕복한다', () => {
    const a = [0, 5, 10];
    expect(a.map(makeEdgeFormatter(a))).toEqual(['0', '5', '10']);
    const b = [0, 0.5, 1];
    expect(b.map(makeEdgeFormatter(b))).toEqual(['0.0', '0.5', '1.0']);
    const c = [1000, 1000.5, 1001];
    const fmtC = makeEdgeFormatter(c);
    expect(c.map(fmtC)).toEqual(['1,000.0', '1,000.5', '1,001.0']);
    expect(roundTrips(fmtC, c)).toBe(true);
    const d = [0.201, 0.202, 0.203, 0.204, 0.205, 0.206, 0.207, 0.208, 0.209];
    const fmtD = makeEdgeFormatter(d);
    expect(new Set(d.map(fmtD)).size).toBe(9);
    expect(roundTrips(fmtD, d)).toBe(true);
  });

  it('유효숫자 경로(폴백 경계): 라벨이 서로 다르고 정확히 왕복하며 0으로 뭉치지 않는다', () => {
    const tiny = [0, 1.6666666666666667e-13, 3.3333333333333334e-13, 5e-13];
    const fmtT = makeEdgeFormatter(tiny);
    const labelsT = tiny.map(fmtT);
    expect(new Set(labelsT).size).toBe(4);
    expect(labelsT.filter((l) => Number(l) === 0)).toHaveLength(1); // 0은 첫 경계 하나뿐
    expect(roundTrips(fmtT, tiny)).toBe(true);

    // 1e6 ± 2^-33(서로 인접한 double)은 고정 소수 10자리에서 왕복하므로 그 경로로 표시된다 — 라벨은 서로 다르고 정확하다.
    const ulp = Math.pow(2, -33);
    const big = [1e6 - ulp, 1e6, 1e6 + ulp];
    const fmtB = makeEdgeFormatter(big);
    expect(new Set(big.map(fmtB)).size).toBe(3);
    expect(roundTrips(fmtB, big)).toBe(true);
  });

  it('리뷰 반례: 경계 8.333333333333334e-14를 8e-14 같은 근삿값으로 표시하지 않는다', () => {
    const edges = [0, 8.333333333333334e-14, 1.6666666666666667e-13];
    const fmt = makeEdgeFormatter(edges);
    expect(fmt(edges[1])).toBe('8.333333333333334e-14');
    expect(Number(fmt(edges[1]))).toBe(edges[1]);
  });
});

import { describe, expect, it } from 'vitest';
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

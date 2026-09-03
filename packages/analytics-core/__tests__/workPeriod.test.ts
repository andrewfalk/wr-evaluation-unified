import { describe, it, expect } from 'vitest';
import {
  calculateWorkPeriod,
  parseWorkPeriodOverride,
  getEffectiveWorkPeriod,
  getEffectiveWorkPeriodText,
} from '../workPeriod';

describe('calculateWorkPeriod', () => {
  it('returns years (with fraction) between two dates', () => {
    expect(calculateWorkPeriod('2020-01-01', '2021-01-01')).toBeCloseTo(1, 1);
  });

  it('returns 0 when either date is missing', () => {
    expect(calculateWorkPeriod('', '2021-01-01')).toBe(0);
    expect(calculateWorkPeriod('2020-01-01', '')).toBe(0);
  });

  it('clamps negative durations (end before start) to 0', () => {
    expect(calculateWorkPeriod('2021-01-01', '2020-01-01')).toBe(0);
  });
});

describe('parseWorkPeriodOverride', () => {
  it('parses "N년 M개월" into fractional years', () => {
    expect(parseWorkPeriodOverride('3년 6개월')).toBeCloseTo(3.5, 5);
  });

  it('returns 0 for empty or non-matching text', () => {
    expect(parseWorkPeriodOverride('')).toBe(0);
    expect(parseWorkPeriodOverride('abc')).toBe(0);
  });
});

describe('getEffectiveWorkPeriod', () => {
  it('prefers workPeriodOverride over start/end dates when present', () => {
    expect(
      getEffectiveWorkPeriod({ startDate: '2020-01-01', endDate: '2021-01-01', workPeriodOverride: '5년' }),
    ).toBe(5);
  });

  it('falls back to start/end dates when no override', () => {
    expect(getEffectiveWorkPeriod({ startDate: '2020-01-01', endDate: '2021-01-01' })).toBeCloseTo(1, 1);
  });
});

describe('getEffectiveWorkPeriodText', () => {
  it('formats "start ~ end (Nyear Mmonth)" when both dates present', () => {
    const text = getEffectiveWorkPeriodText({ startDate: '2020-10-20', endDate: '2024-06-01' });
    expect(text).toMatch(/^2020-10-20 ~ 2024-06-01 \(\d+년 \d+개월\)$/);
  });

  it('shows only the override text when no dates are present', () => {
    expect(getEffectiveWorkPeriodText({ startDate: '', endDate: '', workPeriodOverride: '16년' })).toBe('16년');
  });

  it('shows "-" when neither dates nor override are present', () => {
    expect(getEffectiveWorkPeriodText({ startDate: '', endDate: '' })).toBe('-');
  });
});

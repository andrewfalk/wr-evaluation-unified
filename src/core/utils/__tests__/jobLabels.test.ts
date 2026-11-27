import { describe, expect, it } from 'vitest';
import { EMPTY_JOB_NAME_LABEL, formatJobNumber, formatJobTitle, formatPeriodYears, jobNameOrEmpty } from '../jobLabels';

describe('jobLabels — 화면 직력 표기(결정 4)', () => {
  it('직력 번호는 붙여 쓴다', () => {
    expect(formatJobNumber(1)).toBe('직력1');
    expect(formatJobNumber(12)).toBe('직력12');
  });

  it('빈 직종명은 (미입력)', () => {
    expect(EMPTY_JOB_NAME_LABEL).toBe('(미입력)');
    expect(jobNameOrEmpty('용접공')).toBe('용접공');
    expect(jobNameOrEmpty('')).toBe('(미입력)');
    expect(jobNameOrEmpty(undefined)).toBe('(미입력)');
    expect(jobNameOrEmpty(null)).toBe('(미입력)');
  });

  it('직력 제목은 번호와 직종명', () => {
    expect(formatJobTitle(1, '용접공')).toBe('직력1: 용접공');
    expect(formatJobTitle(2, '')).toBe('직력2: (미입력)');
  });

  it('근무 기간은 X.X년, 0·음수·계산 불가는 -', () => {
    expect(formatPeriodYears(3.25)).toBe('3.3년');
    expect(formatPeriodYears(0.04)).toBe('0.0년');
    expect(formatPeriodYears(0)).toBe('-');
    expect(formatPeriodYears(-1)).toBe('-');
    expect(formatPeriodYears(Number.NaN)).toBe('-');
    expect(formatPeriodYears(Number.POSITIVE_INFINITY)).toBe('-');
    expect(formatPeriodYears(undefined)).toBe('-');
    expect(formatPeriodYears(null)).toBe('-');
  });
});

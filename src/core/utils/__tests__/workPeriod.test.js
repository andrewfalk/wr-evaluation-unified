import { describe, expect, it } from 'vitest';
import { getEffectiveWorkPeriodText } from '../workPeriod';

describe('getEffectiveWorkPeriodText: 근무 기간 범위 표시', () => {
  it('날짜만 있으면 "시작 ~ 종료 (N년 M개월)" 형식', () => {
    const text = getEffectiveWorkPeriodText({ startDate: '2020-10-20', endDate: '2024-06-01' });
    expect(text).toMatch(/^2020-10-20 ~ 2024-06-01 \(\d+년 \d+개월\)$/);
  });

  it('override + 날짜 있으면 범위 뒤에 override 문자열을 괄호로 표시', () => {
    const text = getEffectiveWorkPeriodText({
      startDate: '2020-10-20', endDate: '2024-06-01', workPeriodOverride: '3년 6개월',
    });
    expect(text).toBe('2020-10-20 ~ 2024-06-01 (3년 6개월)');
  });

  it('override만 있고 날짜 없으면 override 문자열만 (범위·괄호 없음)', () => {
    const text = getEffectiveWorkPeriodText({ startDate: '', endDate: '', workPeriodOverride: '16년' });
    expect(text).toBe('16년');
  });

  it('날짜도 override도 없으면 "-"', () => {
    expect(getEffectiveWorkPeriodText({ startDate: '', endDate: '' })).toBe('-');
  });
});

// 어깨 [직력별 기여]의 하루 노출 시간 표기. 분 단위 입력이 시간으로 바뀌어 생기는 끝없는 소수(0.0666…)를
// 결과 화면처럼 소수 둘째 자리로 줄이고, 반올림해 0이 되는 값은 "0.01시간/일 미만"으로 적는다.
import { describe, expect, it } from 'vitest';
import { formatDailyHours, shoulderNarrative } from '../narrative';

describe('formatDailyHours', () => {
  it('소수 둘째 자리에서 반올림하고 끝의 0은 뗀다', () => {
    expect(formatDailyHours(4 / 60)).toBe('0.07시간/일');
    expect(formatDailyHours(1.5)).toBe('1.5시간/일');
    expect(formatDailyHours(2)).toBe('2시간/일');
    expect(formatDailyHours(1.999)).toBe('2시간/일');
  });

  it('0보다 크지만 반올림해 0이 되는 값은 "0.01시간/일 미만"', () => {
    expect(formatDailyHours(0.2 / 60)).toBe('0.01시간/일 미만');
    expect(formatDailyHours(0.004)).toBe('0.01시간/일 미만');
    expect(formatDailyHours(0.005)).toBe('0.01시간/일');
  });
});

describe('[직력별 기여] 줄', () => {
  const calc = {
    totals: [],
    jobBurdens: [
      { id: 'a', jobName: '도장공', periodYears: 10, exposures: [
        { label: '오버헤드 작업', dailyHours: 4 / 60, cumulativeHours: 146.66666 },
        { label: '반복동작(중간)', dailyHours: 0.2 / 60, cumulativeHours: 7.3 },
        { label: '진동', dailyHours: 0, cumulativeHours: 0 },
      ] },
      { id: 'b', jobName: '정비공', periodYears: 2, exposures: [
        { label: '오버헤드 작업', dailyHours: 1.5, cumulativeHours: 660 },
      ] },
    ],
  };

  it.each(['report', 'emrSection'] as const)('%s: 하루 시간이 반올림되어 나온다', variant => {
    const text = shoulderNarrative.render(variant, calc, {});
    expect(text).toContain('  오버헤드 작업: 0.07시간/일, 누적 146.7시간\n');
    expect(text).toContain('  반복동작(중간): 0.01시간/일 미만, 누적 7.3시간\n');
    expect(text).toContain('  오버헤드 작업: 1.5시간/일, 누적 660.0시간\n');
    expect(text).not.toContain('진동');
    expect(text).not.toMatch(/\d\.\d{3,}시간\/일/);
  });
});

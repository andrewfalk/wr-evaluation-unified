import { describe, expect, it } from 'vitest';
import { toLocalDateString } from '../common.js';

describe('toLocalDateString', () => {
  it('빈 값이면 빈 문자열을 반환한다', () => {
    expect(toLocalDateString('')).toBe('');
    expect(toLocalDateString(null)).toBe('');
    expect(toLocalDateString(undefined)).toBe('');
  });

  // KST(UTC+9)에서 자정~오전 사이 등록된 기록은 UTC로는 전날이다. slice(0, 10)처럼
  // ISO 문자열을 그대로 잘라 쓰면 등록일이 하루 전으로 표시되는 회귀가 있었다 —
  // 로컬(런타임) 타임존 기준 캘린더 날짜로 변환해야 한다.
  it('UTC 자정 이전(KST 오전 9시 이전) 타임스탬프도 로컬 날짜 기준으로 변환한다', () => {
    // 2026-08-02T23:47:00Z == 2026-08-03 08:47 KST
    expect(toLocalDateString('2026-08-02T23:47:00.000Z')).toBe('2026-08-03');
  });

  it('KST 오후 시간대 타임스탬프는 UTC 날짜와 같다', () => {
    // 2026-08-03T05:00:00Z == 2026-08-03 14:00 KST
    expect(toLocalDateString('2026-08-03T05:00:00.000Z')).toBe('2026-08-03');
  });

  it('날짜만 있는 값(YYYY-MM-DD)은 그대로 로컬 자정으로 파싱해 원래 날짜를 유지한다', () => {
    expect(toLocalDateString('2026-08-02')).toBe('2026-08-02');
  });

  it('유효하지 않은 값은 빈 문자열을 반환한다', () => {
    expect(toLocalDateString('not-a-date')).toBe('');
  });
});

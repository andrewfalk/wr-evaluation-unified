import { describe, it, expect } from 'vitest';
import { dateOnly } from '../patientPersons';

describe('dateOnly (생년월일 비교 정규화)', () => {
  it('문자열은 앞 10자(YYYY-MM-DD)로 자른다', () => {
    expect(dateOnly('1961-02-15')).toBe('1961-02-15');
    expect(dateOnly('1961-02-15T00:00:00.000Z')).toBe('1961-02-15');
  });

  it('null/undefined/빈값 → null', () => {
    expect(dateOnly(null)).toBeNull();
    expect(dateOnly(undefined)).toBeNull();
    expect(dateOnly('')).toBeNull();
  });

  it('Date(pg DATE=로컬 자정)는 로컬 캘린더 날짜로 포맷 — TZ 무관(toISOString UTC 시프트 회귀 방지)', () => {
    // pg date 파서는 'YYYY-MM-DD'를 로컬 자정 Date(new Date(y, m-1, d))로 만든다.
    // 과거 toISOString().slice(0,10)은 KST(+9)에서 하루 밀려 1961-02-14를 냈다.
    expect(dateOnly(new Date(1961, 1, 15))).toBe('1961-02-15');
    expect(dateOnly(new Date(2024, 0, 1))).toBe('2024-01-01');   // 자정 경계
    expect(dateOnly(new Date(2024, 11, 31))).toBe('2024-12-31');
  });
});

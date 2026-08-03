import { describe, it, expect } from 'vitest';
import {
  MIN_CALENDAR_DATE,
  normalizeCalendarDate,
  todayInSeoul,
  validatePastDate,
} from '../patientDates';

// 고정 기준 시각 — 2026-08-03T00:30:00Z = KST 2026-08-03 09:30
const NOW = new Date('2026-08-03T00:30:00Z');

describe('todayInSeoul', () => {
  it('UTC 자정 직후에도 KST 기준 당일을 돌려준다', () => {
    // 2026-08-03T00:30Z → KST 09:30 같은 날
    expect(todayInSeoul(new Date('2026-08-03T00:30:00Z'))).toBe('2026-08-03');
  });

  it('UTC 기준 전날 오후여도 KST로는 이미 다음 날이다', () => {
    // 2026-08-02T15:30Z → KST 2026-08-03 00:30
    expect(todayInSeoul(new Date('2026-08-02T15:30:00Z'))).toBe('2026-08-03');
  });

  it('KST 자정 직전은 아직 전날이다', () => {
    // 2026-08-02T14:59Z → KST 2026-08-02 23:59
    expect(todayInSeoul(new Date('2026-08-02T14:59:00Z'))).toBe('2026-08-02');
  });
});

describe('normalizeCalendarDate', () => {
  it('구분자와 무관하게 canonical YYYY-MM-DD로 정규화한다', () => {
    expect(normalizeCalendarDate('2020-01-02')).toBe('2020-01-02');
    expect(normalizeCalendarDate('2020/01/02')).toBe('2020-01-02');
    expect(normalizeCalendarDate('2020.01.02')).toBe('2020-01-02');
  });

  it('한 자리 월/일을 zero-pad 한다', () => {
    expect(normalizeCalendarDate('2020-1-2')).toBe('2020-01-02');
  });

  it('실재하지 않는 날짜는 null', () => {
    expect(normalizeCalendarDate('2026-02-30')).toBeNull();
    expect(normalizeCalendarDate('2026-13-01')).toBeNull();
    expect(normalizeCalendarDate('2026-00-10')).toBeNull();
  });

  it('윤년 2월 29일은 연도에 따라 갈린다', () => {
    expect(normalizeCalendarDate('2024-02-29')).toBe('2024-02-29');
    expect(normalizeCalendarDate('2025-02-29')).toBeNull();
  });

  it('형식이 아니면 null', () => {
    expect(normalizeCalendarDate('미상')).toBeNull();
    expect(normalizeCalendarDate('')).toBeNull();
    expect(normalizeCalendarDate(20200102)).toBeNull();
    expect(normalizeCalendarDate(null)).toBeNull();
  });

  it('Date 객체는 로컬 컴포넌트로 읽어 하루 밀림을 피한다', () => {
    // 로컬 자정으로 만든 Date — UTC 변환 시 KST에서는 전날이 될 수 있다.
    const d = new Date(1961, 1, 15); // 1961-02-15 local
    expect(normalizeCalendarDate(d)).toBe('1961-02-15');
  });
});

describe('validatePastDate', () => {
  it('정상 생년월일을 통과시키고 normalized를 돌려준다', () => {
    const r = validatePastDate('1957/12/13', { now: NOW });
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('1957-12-13');
    expect(r.reason).toBeNull();
  });

  it('실제 사고 값 4110-02-12를 미래 날짜로 거부한다', () => {
    const r = validatePastDate('4110-02-12', { now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('future');
    expect(r.normalized).toBe('');
  });

  it('1900 이전은 too_old로 거부한다', () => {
    expect(validatePastDate('1899-12-31', { now: NOW }).reason).toBe('too_old');
    expect(validatePastDate(MIN_CALENDAR_DATE, { now: NOW }).valid).toBe(true);
  });

  it('실재하지 않는 날짜는 not_a_calendar_date로 구분한다', () => {
    const r = validatePastDate('2026-02-30', { now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('not_a_calendar_date');
  });

  it('형식 오류는 format으로 구분한다', () => {
    expect(validatePastDate('미상', { now: NOW }).reason).toBe('format');
  });

  it('오늘(KST)은 통과, 내일은 거부', () => {
    expect(validatePastDate('2026-08-03', { now: NOW }).valid).toBe(true);
    expect(validatePastDate('2026-08-04', { now: NOW }).reason).toBe('future');
  });

  it('KST 경계: UTC로는 아직 어제여도 KST 오늘 날짜는 통과한다', () => {
    // UTC 2026-08-02T15:30 → KST 2026-08-03. UTC 기준으로 비교했다면 미래로 오판됐을 값.
    const r = validatePastDate('2026-08-03', { now: new Date('2026-08-02T15:30:00Z') });
    expect(r.valid).toBe(true);
  });

  it('빈 값은 기본적으로 허용하고 normalized는 빈 문자열', () => {
    expect(validatePastDate('', { now: NOW })).toEqual({ valid: true, normalized: '', reason: null });
    expect(validatePastDate(null, { now: NOW }).valid).toBe(true);
    expect(validatePastDate(undefined, { now: NOW }).valid).toBe(true);
    expect(validatePastDate('   ', { now: NOW }).valid).toBe(true);
  });

  it('allowEmpty:false면 빈 값을 거부한다 (정정 API용)', () => {
    const r = validatePastDate('', { now: NOW, allowEmpty: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('empty');
  });
});

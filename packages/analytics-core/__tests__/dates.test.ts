import { describe, it, expect } from 'vitest';
import { parseStrictIsoDate, compareDate, calculateAgeStrict, isValidStrictDateTime } from '../dates';

describe('parseStrictIsoDate', () => {
  it('parses a well-formed YYYY-MM-DD date', () => {
    expect(parseStrictIsoDate('2020-03-01')).toEqual({ y: 2020, m: 3, d: 1 });
  });

  it('rejects non-strict formats', () => {
    expect(parseStrictIsoDate('2020/03/01')).toBeNull();
    expect(parseStrictIsoDate('2020-3-1')).toBeNull();
    expect(parseStrictIsoDate('')).toBeNull();
    expect(parseStrictIsoDate('not-a-date')).toBeNull();
  });

  it('rejects calendar-invalid dates via round-trip day-count check (2021-02-31)', () => {
    expect(parseStrictIsoDate('2021-02-31')).toBeNull();
  });

  it('accepts leap-day 2020-02-29 (2020 is a leap year) and rejects 2021-02-29', () => {
    expect(parseStrictIsoDate('2020-02-29')).toEqual({ y: 2020, m: 2, d: 29 });
    expect(parseStrictIsoDate('2021-02-29')).toBeNull();
  });

  it('rejects month/day out of range', () => {
    expect(parseStrictIsoDate('2020-13-01')).toBeNull();
    expect(parseStrictIsoDate('2020-00-01')).toBeNull();
    expect(parseStrictIsoDate('2020-01-32')).toBeNull();
    expect(parseStrictIsoDate('2020-01-00')).toBeNull();
  });
});

describe('compareDate', () => {
  it('orders dates lexicographically by y, m, d', () => {
    expect(compareDate({ y: 2020, m: 1, d: 1 }, { y: 2020, m: 1, d: 1 })).toBe(0);
    expect(compareDate({ y: 2019, m: 12, d: 31 }, { y: 2020, m: 1, d: 1 })).toBeLessThan(0);
    expect(compareDate({ y: 2020, m: 1, d: 2 }, { y: 2020, m: 1, d: 1 })).toBeGreaterThan(0);
  });
});

describe('calculateAgeStrict', () => {
  it('computes age with no timezone/Date dependency', () => {
    expect(calculateAgeStrict('1990-03-01', '2020-03-01')).toBe(30);
    expect(calculateAgeStrict('1990-03-02', '2020-03-01')).toBe(29); // birthday not yet reached this year
    expect(calculateAgeStrict('1990-02-28', '2020-03-01')).toBe(30);
  });

  it('returns null for unparseable input', () => {
    expect(calculateAgeStrict('bad', '2020-03-01')).toBeNull();
    expect(calculateAgeStrict('1990-03-01', 'bad')).toBeNull();
  });

  it('returns null when refDate is before birthDate (negative age)', () => {
    expect(calculateAgeStrict('2020-03-01', '1990-03-01')).toBeNull();
  });

  it('returns 0 for refDate === birthDate', () => {
    expect(calculateAgeStrict('2020-03-01', '2020-03-01')).toBe(0);
  });
});

describe('isValidStrictDateTime', () => {
  it('accepts RFC3339 with explicit Z or offset', () => {
    expect(isValidStrictDateTime('2024-01-15T09:30:00.000Z')).toBe(true);
    expect(isValidStrictDateTime('2024-01-15T09:30:00Z')).toBe(true);
    expect(isValidStrictDateTime('2024-01-15T09:30:00+09:00')).toBe(true);
    expect(isValidStrictDateTime('2024-01-15T09:30:00-08:00')).toBe(true);
  });

  it('rejects timestamps without explicit timezone', () => {
    expect(isValidStrictDateTime('2024-01-15T09:30:00')).toBe(false);
    expect(isValidStrictDateTime('2024-01-15')).toBe(false);
  });

  it('rejects format-valid but value-invalid timestamps (calendar/time/offset out of range)', () => {
    expect(isValidStrictDateTime('2026-99-99T99:99:99+99:99')).toBe(false);
    expect(isValidStrictDateTime('2021-02-31T00:00:00Z')).toBe(false); // no such calendar day
    expect(isValidStrictDateTime('2024-01-15T24:00:00Z')).toBe(false); // hour out of range
    expect(isValidStrictDateTime('2024-01-15T09:60:00Z')).toBe(false); // minute out of range
    expect(isValidStrictDateTime('2024-01-15T09:30:60Z')).toBe(false); // second out of range
    expect(isValidStrictDateTime('2024-01-15T09:30:00+24:00')).toBe(false); // offset hour out of range
    expect(isValidStrictDateTime('2024-01-15T09:30:00+09:60')).toBe(false); // offset minute out of range
  });

  it('rejects garbage strings', () => {
    expect(isValidStrictDateTime('not-a-timestamp')).toBe(false);
    expect(isValidStrictDateTime('')).toBe(false);
  });
});

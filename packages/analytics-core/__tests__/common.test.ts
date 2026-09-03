import { describe, it, expect } from 'vitest';
import { calculateBMI, calculateAge, stableStringify, escapeHtml } from '../common';

describe('calculateBMI', () => {
  it('computes BMI to one decimal place', () => {
    expect(calculateBMI(170, 65)).toBe('22.5');
  });

  it('returns 0 for missing or non-positive height', () => {
    expect(calculateBMI('', 65)).toBe(0);
    expect(calculateBMI(0, 65)).toBe(0);
    expect(calculateBMI(170, '')).toBe(0);
  });
});

describe('calculateAge — UI hybrid (strict fast path + lenient fallback)', () => {
  it('computes age for well-formed YYYY-MM-DD dates', () => {
    expect(calculateAge('1990-03-01', '2020-03-01')).toBe(30);
    expect(calculateAge('1990-03-02', '2020-03-01')).toBe(29);
  });

  it('returns 0 when either date is missing', () => {
    expect(calculateAge('', '2020-03-01')).toBe(0);
    expect(calculateAge('1990-03-01', '')).toBe(0);
  });

  it('falls back to lenient Date parsing for non-strict formats (legacy compat)', () => {
    // ISO datetime with an explicit time component isn't strict YYYY-MM-DD; original
    // behavior (new Date(string)) is preserved for this path.
    expect(calculateAge('1990-03-01T00:00:00Z', '2020-03-01T00:00:00Z')).toBe(30);
  });
});

describe('stableStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('sorts keys of nested objects too', () => {
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order (only object keys are sorted)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('escapeHtml', () => {
  it('escapes the five XSS-relevant characters', () => {
    expect(escapeHtml(`<script>"'&</script>`)).toBe(
      '&lt;script&gt;&quot;&#039;&amp;&lt;/script&gt;',
    );
  });

  it('passes non-string values through unchanged', () => {
    expect(escapeHtml(42)).toBe(42);
    expect(escapeHtml(null)).toBe(null);
  });
});

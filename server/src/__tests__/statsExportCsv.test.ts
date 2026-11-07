// CSV formula-injection escaping of string cells (stats export, §7.5 + SEC-A L14).
import { describe, expect, it } from 'vitest';
import { escapeCsvString } from '../statsExportHandler';

describe('escapeCsvString', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
  ])('prefixes the existing formula triggers: %j → %j', (input, expected) => {
    expect(escapeCsvString(input)).toBe(expected);
  });

  it('a leading TAB is a formula trigger and the value is quoted (L14)', () => {
    expect(escapeCsvString('\t=1+1')).toBe(`"'\t=1+1"`);
  });

  it('a leading CR is a formula trigger and the value is quoted (L14)', () => {
    expect(escapeCsvString('\r=cmd')).toBe(`"'\r=cmd"`);
  });

  it('a TAB in the middle is quoted but not prefixed (L14)', () => {
    expect(escapeCsvString('a\tb')).toBe('"a\tb"');
  });

  it('quotes commas, quotes and newlines, and leaves plain text alone', () => {
    expect(escapeCsvString('a,b')).toBe('"a,b"');
    expect(escapeCsvString('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvString('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvString('근골격계')).toBe('근골격계');
  });
});

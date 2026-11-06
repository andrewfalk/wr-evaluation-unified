// scripts/verify-browser-compat.mjs — detection rules and comment stripping (REFACTORING_ROADMAP P0-5).
import { describe, expect, it } from 'vitest';
import { scanSource, stripComments } from './verify-browser-compat.mjs';

const FLOOR = 108;
const names = (content, ext) => scanSource(content, ext, FLOOR).map((v) => v.name);

describe('verify-browser-compat — JS rules', () => {
  it('flags array/promise/view-transition APIs newer than the floor', () => {
    const found = names('const s = [1].toSorted(); Promise.withResolvers(); document.startViewTransition();', '.jsx');
    expect(found).toEqual(expect.arrayContaining([
      'Array.prototype.toSorted/toReversed/toSpliced',
      'Promise.withResolvers()',
      'document.startViewTransition()',
    ]));
  });

  it('flags Set methods whatever the argument is (Codex review: `a.union(b)` was missed)', () => {
    expect(names('const a = new Set([1]); const b = new Set([2]); a.union(b);', '.js')).toContain('Set methods (union/intersection/…)');
    expect(names('seen.isSubsetOf(\n  other);', '.js')).toContain('Set methods (union/intersection/…)');
  });

  it('allows whitespace and line breaks between the name and the call (Codex review round 4)', () => {
    expect(names('const result = [2, 1].toSorted ();', '.js')).toContain('Array.prototype.toSorted/toReversed/toSpliced');
    const multi = scanSource('const r = items\n  .toSorted\n  ((a, b) => a - b);\nconst p = Promise\n  .withResolvers();', '.js', FLOOR);
    expect(multi.map((v) => [v.line, v.name])).toEqual([
      [3, 'Array.prototype.toSorted/toReversed/toSpliced'],
      [5, 'Promise.withResolvers()'],
    ]);
  });

  it('a comment between the name and the call does not hide it', () => {
    expect(names('const r = arr.toSorted /* asc */ ();', '.js')).toContain('Array.prototype.toSorted/toReversed/toSpliced');
  });

  it("does not flag zod's z.union()/z.intersection()", () => {
    expect(names('const S = z\n  .union([A, B]);', '.js')).toEqual([]);
    expect(names('const S = z.union([A, B]); const T = z.intersection(A, B);', '.js')).toEqual([]);
  });

  it('still checks code after `//` inside a string (Codex review: it used to be stripped as a comment)', () => {
    expect(names("export const sorted = ['a//b', 'c'].toSorted();", '.js')).toContain('Array.prototype.toSorted/toReversed/toSpliced');
    expect(names('const u = `http://x`; [1].toReversed();', '.js')).toContain('Array.prototype.toSorted/toReversed/toSpliced');
  });

  it('quotes inside a regex literal do not hide a later string `//` (Codex review round 2)', () => {
    const src = "const quotes = /['\"]/g;\nconst result = ['a//b', 'c'].toSorted();";
    expect(scanSource(src, '.js', FLOOR).map((v) => v.line)).toEqual([2]);
  });

  it('an apostrophe in JSX text does not hide a later string `//`', () => {
    const src = "const el = <p>Patient's note</p>;\nconst x = ['http://a'].toSorted();";
    expect(scanSource(src, '.jsx', FLOOR).map((v) => v.line)).toEqual([2]);
  });

  it('if a file does not parse, nothing is stripped (no hidden code; a comment may raise a false alarm)', () => {
    const src = 'const = ; // [1].toSorted()';
    expect(stripComments(src, '.js')).toBe(src);
    expect(names(src, '.js')).toContain('Array.prototype.toSorted/toReversed/toSpliced');
  });

  it('ignores real comments and lines marked browser-compat-ignore', () => {
    expect(names('// [1].toSorted() would break Chrome 108\n/* Promise.withResolvers() */', '.js')).toEqual([]);
    expect(names('const s = [1].toSorted(); // browser-compat-ignore -- feature-detected', '.js')).toEqual([]);
  });

  it('does not treat JSX `&&` as CSS nesting', () => {
    expect(names('return ok && <div />;', '.jsx')).toEqual([]);
  });

  it('keeps line numbers across multi-line block comments', () => {
    const found = scanSource('/* one\n two */\nconst s = [1].toSorted();', '.js', FLOOR);
    expect(found.map((v) => v.line)).toEqual([3]);
  });
});

describe('verify-browser-compat — CSS rules', () => {
  it('flags color-mix and nesting', () => {
    expect(names('.a { background: color-mix(in srgb, red 10%, blue); }\n.b {\n  & .x { color: red; }\n}', '.css'))
      .toEqual(['color-mix()', 'CSS nesting (&)']);
  });

  it('does not treat `//` in CSS as a comment, but does strip /* */', () => {
    expect(names('.a { background: url(//cdn/x.png); color: color-mix(in srgb, red, blue); }', '.css')).toEqual(['color-mix()']);
    expect(names('/* color-mix() is Chrome 111+ */ .a { color: red; }', '.css')).toEqual([]);
  });

  it('flags nesting written on the same line as the parent block (Codex review round 4)', () => {
    expect(names('.card { & .title { color: red; } }', '.css')).toEqual(['CSS nesting (&)']);
    expect(names('.card { color: blue; & .title { color: red; } }', '.css')).toEqual(['CSS nesting (&)']);
    expect(names('.a::after { content: "&"; }', '.css')).toEqual([]);
  });

  it('an ignore marker on the previous declaration does not exempt the next nested rule (Codex review round 5)', () => {
    const src = '.card {\n color: red;\n color: color-mix(in srgb, red, blue); /* browser-compat-ignore -- fallback above */\n &:hover { color: blue; }\n}';
    expect(scanSource(src, '.css', FLOOR).map((v) => [v.line, v.name])).toEqual([[4, 'CSS nesting (&)']]);
  });

  it('a comment marker inside a CSS string does not hide later rules (Codex review round 3)', () => {
    const src = '.label::before { content: "/*"; }\n.panel { background: color-mix(in srgb, red, blue); }';
    expect(scanSource(src, '.css', FLOOR).map((v) => v.line)).toEqual([2]);
    expect(names(".a::after { content: '\\'/*'; }\n.b { color: color-mix(in srgb, red, blue); }", '.css')).toEqual(['color-mix()']);
  });

  it('a comment containing a quote does not start a CSS string', () => {
    expect(names("/* don't use color-mix here */\n.b { color: color-mix(in srgb, red, blue); }", '.css')).toEqual(['color-mix()']);
  });

  it('applies only rules newer than the floor', () => {
    expect(scanSource('.a { color: color-mix(in srgb, red, blue); }', '.css', 111)).toEqual([]);
  });
});

describe('stripComments', () => {
  it('blanks comments but preserves newlines and string contents', () => {
    const src = "const a = 'x//y'; // gone\n/* b\nc */ const d = 1;";
    const out = stripComments(src, '.js');
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain("'x//y'");
    expect(out).not.toContain('gone');
    expect(out).toContain('const d = 1;');
  });
});

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

  it("does not flag zod's z.union()/z.intersection()", () => {
    expect(names('const S = z.union([A, B]); const T = z.intersection(A, B);', '.js')).toEqual([]);
  });

  it('still checks code after `//` inside a string (Codex review: it used to be stripped as a comment)', () => {
    expect(names("export const sorted = ['a//b', 'c'].toSorted();", '.js')).toContain('Array.prototype.toSorted/toReversed/toSpliced');
    expect(names('const u = `http://x`; [1].toReversed();', '.js')).toContain('Array.prototype.toSorted/toReversed/toSpliced');
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

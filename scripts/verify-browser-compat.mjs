#!/usr/bin/env node
/**
 * scripts/verify-browser-compat.mjs — browser floor guard (REFACTORING_ROADMAP D2/P0-5).
 *
 * The web build must run on the oldest browser that loads it: Win7 Chrome 109 and the
 * intranet installer (Electron 22 = Chromium 108), so the floor is Chrome 108. Vite's
 * `build.target` only transpiles syntax — newer APIs, methods and CSS features pass
 * through untouched and break silently on old browsers (2026-06: Object.hasOwn white
 * screen). This script greps the browser sources for features newer than the floor.
 *
 * Single source of truth: package.json "browserslist" (`chrome >= N`). The script also
 * fails if vite.config.js `build.target` is not `chrome<N>`.
 *
 * Why a curated list and not eslint-plugin-compat: tried on 2026-11-06 — its bundled data
 * has only ~36 APIs newer than Chrome 108 (MathML, audio sinks…) and misses the ones this
 * app could plausibly use (startViewTransition, Array.fromAsync, …). It also cannot see
 * instance methods such as `.toSorted()`. Keep the list below to features the app could
 * realistically pick up; add an entry when a new feature tempts you.
 *
 * Scope: src/**\/*.{js,jsx,ts,tsx,css}, tests excluded (they run in jsdom/Node). TypeScript was added in
 * REFACTORING_ROADMAP Phase 2 P2-00 — new client code is .ts/.tsx and must stay under the same floor.
 * Comments are ignored. To allow a deliberate, feature-detected use, put
 * `browser-compat-ignore` in a comment on the reported line (the line with the call's `(` or
 * the nesting `&`) with the reason.
 *
 * Usage: node scripts/verify-browser-compat.mjs   (also run by `npm run check`)
 * Exit codes: 0 = pass, 1 = violation or misconfiguration.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import { parse as parseTypeScript } from '@typescript-eslint/typescript-estree';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(root, 'src');
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

// [where, pattern, first Chrome version that supports it, name]
// 'css' rules run on .css only (so JSX `&&` cannot look like CSS nesting);
// 'js' rules run on .js/.jsx/.ts/.tsx. Patterns are matched against the whole file with comments
// blanked (not line by line), so `\s` also spans line breaks: `arr\n  .toSorted ()` is caught.
// This is a grep heuristic, not a type-aware parser: dynamic access such as `arr['toSorted']()`
// or aliasing (`const s = arr.toSorted; s()`) is not detected.
const FEATURES = [
  // CSS
  ['css', /color-mix\s*\(/, 111, 'color-mix()'],
  ['css', /(?:^|[{;])\s*&/m, 112, 'CSS nesting (&)'],
  ['css', /text-wrap\s*:/, 114, 'text-wrap'],
  ['css', /@starting-style/, 117, '@starting-style'],
  ['css', /\bsubgrid\b/, 117, 'subgrid'],
  ['css', /@scope\b/, 118, '@scope'],
  ['css', /:user-(?:in)?valid\b/, 119, ':user-valid / :user-invalid'],
  ['css', /\(\s*from\s/, 119, 'relative color syntax (rgb(from …))'],
  ['css', /light-dark\s*\(/, 123, 'light-dark()'],
  ['css', /field-sizing/, 123, 'field-sizing'],
  ['css', /anchor-name|position-anchor|\banchor\s*\(/, 125, 'CSS anchor positioning'],
  ['css', /\b(?:round|mod|rem)\s*\(/, 125, 'CSS round()/mod()/rem()'],
  // JS — instance/static methods and web APIs
  ['js', /\.\s*(?:toSorted|toReversed|toSpliced)\s*\(/, 110, 'Array.prototype.toSorted/toReversed/toSpliced'],
  ['js', /\.\s*(?:isWellFormed|toWellFormed)\s*\(/, 111, 'String.prototype.isWellFormed/toWellFormed'],
  ['js', /\.\s*startViewTransition\s*\(/, 111, 'document.startViewTransition()'],
  ['js', /navigator\s*\.\s*gpu\b/, 113, 'WebGPU (navigator.gpu)'],
  ['js', /\.\s*(?:showPopover|hidePopover|togglePopover)\s*\(|\bpopover\s*=/, 114, 'Popover API'],
  ['js', /AbortSignal\s*\.\s*any\s*\(/, 116, 'AbortSignal.any()'],
  ['js', /\b(?:Object|Map)\s*\.\s*groupBy\s*\(/, 117, 'Object.groupBy / Map.groupBy'],
  ['js', /Promise\s*\.\s*withResolvers\s*\(/, 119, 'Promise.withResolvers()'],
  ['js', /URL\s*\.\s*canParse\s*\(/, 120, 'URL.canParse()'],
  ['js', /Array\s*\.\s*fromAsync\s*\(/, 121, 'Array.fromAsync()'],
  // Any receiver/argument. zod's z.union()/z.intersection() (the only current users of these
  // names in src) are excluded by the lookbehind; another library with the same method names
  // would need a `browser-compat-ignore` marker.
  ['js', /(?<!\bz\s*)\.\s*(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/, 122, 'Set methods (union/intersection/…)'],
  ['js', /URL\s*\.\s*parse\s*\(/, 126, 'URL.parse()'],
  ['js', /\bCloseWatcher\b/, 126, 'CloseWatcher'],
  ['js', /Promise\s*\.\s*try\s*\(/, 128, 'Promise.try()'],
  ['js', /scheduler\s*\.\s*yield\s*\(/, 129, 'scheduler.yield()'],
  ['js', /Intl\s*\.\s*DurationFormat/, 129, 'Intl.DurationFormat'],
];

function fail(message) {
  console.error(`verify-browser-compat: ${message}`);
  process.exit(1);
}

function readFloor() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const list = pkg.browserslist;
  if (!Array.isArray(list) || list.length !== 1) fail('package.json "browserslist" must be exactly ["chrome >= N"].');
  const m = /^chrome\s*>=\s*(\d+)$/.exec(list[0].trim());
  if (!m) fail(`package.json "browserslist" must be "chrome >= N" (got "${list[0]}").`);
  return Number(m[1]);
}

function checkViteTarget(floor) {
  const vite = readFileSync(path.join(root, 'vite.config.js'), 'utf8');
  const m = /target:\s*\[([^\]]*)\]/.exec(vite);
  if (!m) fail('vite.config.js: cannot find build.target.');
  const targets = [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]);
  if (targets.length !== 1 || targets[0] !== `chrome${floor}`) {
    fail(`vite.config.js build.target is [${targets.join(', ')}], expected ['chrome${floor}'] (package.json browserslist).`);
  }
}

// Replace [start, end) ranges with spaces, keeping line breaks so line numbers stay put.
function blankRanges(content, ranges) {
  let out = '';
  let pos = 0;
  for (const [start, end] of ranges) {
    out += content.slice(pos, start) + content.slice(start, end).replace(/[^\n]/g, ' ');
    pos = end;
  }
  return out + content.slice(pos);
}

// CSS comment ranges, skipping "…"/'…' strings so `content: "/*"` cannot open a comment that
// swallows the rest of the file (Codex review of #191, round 3). Per CSS syntax, a backslash
// escapes the next character and an unescaped newline ends an (invalid) string.
function cssCommentRanges(content) {
  const ranges = [];
  let quote = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote || ch === '\n') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end === -1 ? content.length : end + 2;
      ranges.push([i, stop]);
      i = stop - 1;
    }
  }
  return ranges;
}

// TypeScript-only syntax that sits between a method name and its call: type arguments
// (`Promise.withResolvers<number>()`, `arr.toSorted<T>()`) and the non-null `!` (`a.toSorted!()`).
// Vite strips both, so the call still runs on the old browser; blank them so the rules see
// `Promise.withResolvers   ()` (Codex review of #284). Walks the typescript-estree AST.
function typeOnlyRanges(ast) {
  const ranges = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'TSTypeParameterInstantiation') {
      ranges.push(node.range);
      return;
    }
    if (node.type === 'TSNonNullExpression') ranges.push([node.range[1] - 1, node.range[1]]);
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  return ranges;
}

// Sort and merge overlapping [start, end) ranges (a comment may sit inside type arguments).
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// Blank out comments only — never string, template, regex or JSX text contents — so code after
// `'a//b'` or `/['"]/` is still checked. JS comment positions come from espree (ESLint's parser,
// JSX enabled; .ts/.tsx through typescript-estree, the parser typescript-eslint uses): a hand-written
// scanner cannot tell regex literals and JSX text from strings (Codex review of #191). For .ts/.tsx
// the type arguments and non-null `!` between a name and its call are blanked too (typeOnlyRanges).
// If a file does not parse, nothing is stripped: a comment may then cause a false alarm, but real
// code is never hidden. CSS has only /* */ comments.
export function stripComments(content, ext) {
  if (ext === '.css') return blankRanges(content, cssCommentRanges(content));
  let ranges;
  try {
    if (TS_EXTENSIONS.has(ext)) {
      const ast = parseTypeScript(content, { jsx: ext === '.tsx', comment: true, range: true });
      ranges = [...ast.comments.map((c) => c.range), ...typeOnlyRanges(ast)];
    } else {
      ranges = espree.parse(content, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        comment: true,
        range: true,
      }).comments.map((c) => c.range);
    }
  } catch {
    return content;
  }
  return blankRanges(content, mergeRanges(ranges));
}

// Violations in one file's source. Exported for scripts/verifyBrowserCompat.test.mjs.
export function scanSource(content, ext, floor) {
  const kind = ext === '.css' ? 'css' : 'js';
  const active = FEATURES.filter(([where, , since]) => where === kind && since > floor);
  const raw = content.split('\n');
  const code = stripComments(content, ext); // same length and line breaks as content
  const lineStarts = [0];
  for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const found = [];
  const seen = new Set();
  for (const [, pattern, since, name] of active) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of code.matchAll(re)) {
      // Report the line of the last matched character (the '(' or '&'), i.e. where the call is.
      // The ignore marker counts only on that reported line — a match can start on the previous
      // line (CSS nesting matches from the preceding `;`), and a marker there must not exempt
      // the next rule (Codex review of #191, round 5).
      const line = lineOf(m.index + Math.max(m[0].length - 1, 0));
      if (raw[line - 1].includes('browser-compat-ignore')) continue;
      const key = `${line}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ line, name, since, text: raw[line - 1].trim() });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...collectFiles(full));
    } else if (EXTENSIONS.has(path.extname(entry)) && !/\.test\.[jt]sx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const floor = readFloor();
  checkViteTarget(floor);
  const active = FEATURES.filter(([, , since]) => since > floor);
  const files = collectFiles(SRC_DIR);
  const violations = [];

  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    for (const v of scanSource(readFileSync(file, 'utf8'), path.extname(file), floor)) {
      violations.push({ file: rel, ...v });
    }
  }

  if (violations.length > 0) {
    console.error(`\nverify-browser-compat: ${violations.length} feature(s) newer than the Chrome ${floor} floor:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — ${v.name} (Chrome ${v.since}+)`);
      console.error(`    ${v.text}`);
    }
    console.error(`\nUse an alternative that works on Chrome ${floor}, or feature-detect and mark the line with a`);
    console.error('`browser-compat-ignore` comment explaining why (REFACTORING_ROADMAP D2/P0-5).');
    process.exit(1);
  }

  console.log(`verify-browser-compat: floor Chrome ${floor}, ${active.length} rules, ${files.length} files — no violations.`);
}

// Run only when executed directly (the test file imports scanSource/stripComments).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

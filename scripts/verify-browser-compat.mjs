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
 * Scope: src/**\/*.{js,jsx,css}, tests excluded (they run in jsdom/Node).
 * Comments are ignored. To allow a deliberate, feature-detected use, put
 * `browser-compat-ignore` in a comment on the same line with the reason.
 *
 * Usage: node scripts/verify-browser-compat.mjs   (also run by `npm run check`)
 * Exit codes: 0 = pass, 1 = violation or misconfiguration.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(root, 'src');
const EXTENSIONS = new Set(['.js', '.jsx', '.css']);

// [where, pattern, first Chrome version that supports it, name]
// 'css' rules run on .css only (so JSX `&&` cannot look like CSS nesting);
// 'js' rules run on .js/.jsx only.
const FEATURES = [
  // CSS
  ['css', /color-mix\(/, 111, 'color-mix()'],
  ['css', /^\s*&/, 112, 'CSS nesting (&)'],
  ['css', /text-wrap\s*:/, 114, 'text-wrap'],
  ['css', /@starting-style/, 117, '@starting-style'],
  ['css', /\bsubgrid\b/, 117, 'subgrid'],
  ['css', /@scope\b/, 118, '@scope'],
  ['css', /:user-(?:in)?valid\b/, 119, ':user-valid / :user-invalid'],
  ['css', /\(\s*from\s/, 119, 'relative color syntax (rgb(from …))'],
  ['css', /light-dark\(/, 123, 'light-dark()'],
  ['css', /field-sizing/, 123, 'field-sizing'],
  ['css', /anchor-name|position-anchor|\banchor\(/, 125, 'CSS anchor positioning'],
  ['css', /\b(?:round|mod|rem)\(/, 125, 'CSS round()/mod()/rem()'],
  // JS — instance/static methods and web APIs
  ['js', /\.(?:toSorted|toReversed|toSpliced)\(/, 110, 'Array.prototype.toSorted/toReversed/toSpliced'],
  ['js', /\.(?:isWellFormed|toWellFormed)\(/, 111, 'String.prototype.isWellFormed/toWellFormed'],
  ['js', /\.startViewTransition\(/, 111, 'document.startViewTransition()'],
  ['js', /navigator\.gpu\b/, 113, 'WebGPU (navigator.gpu)'],
  ['js', /\.showPopover\(|\.hidePopover\(|\.togglePopover\(|\bpopover=/, 114, 'Popover API'],
  ['js', /AbortSignal\.any\(/, 116, 'AbortSignal.any()'],
  ['js', /\b(?:Object|Map)\.groupBy\(/, 117, 'Object.groupBy / Map.groupBy'],
  ['js', /Promise\.withResolvers\(/, 119, 'Promise.withResolvers()'],
  ['js', /URL\.canParse\(/, 120, 'URL.canParse()'],
  ['js', /Array\.fromAsync\(/, 121, 'Array.fromAsync()'],
  // Any receiver/argument. zod's z.union()/z.intersection() (the only current users of these
  // names in src) are excluded by the lookbehind; another library with the same method names
  // would need a `browser-compat-ignore` marker.
  ['js', /(?<!\bz)\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/, 122, 'Set methods (union/intersection/…)'],
  ['js', /URL\.parse\(/, 126, 'URL.parse()'],
  ['js', /\bCloseWatcher\b/, 126, 'CloseWatcher'],
  ['js', /Promise\.try\(/, 128, 'Promise.try()'],
  ['js', /scheduler\.yield\(/, 129, 'scheduler.yield()'],
  ['js', /Intl\.DurationFormat/, 129, 'Intl.DurationFormat'],
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

// Blank out comments only — never string, template, regex or JSX text contents — so code after
// `'a//b'` or `/['"]/` is still checked. JS comment positions come from espree (ESLint's parser,
// JSX enabled): a hand-written scanner cannot tell regex literals and JSX text from strings
// (Codex review of #191). If a file does not parse, nothing is stripped: a comment may then
// cause a false alarm, but real code is never hidden. CSS has only /* */ comments.
export function stripComments(content, ext) {
  if (ext === '.css') return blankRanges(content, cssCommentRanges(content));
  let comments;
  try {
    comments = espree.parse(content, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
      comment: true,
      range: true,
    }).comments;
  } catch {
    return content;
  }
  return blankRanges(content, comments.map((c) => c.range));
}

// Violations in one file's source. Exported for scripts/verifyBrowserCompat.test.mjs.
export function scanSource(content, ext, floor) {
  const kind = ext === '.css' ? 'css' : 'js';
  const active = FEATURES.filter(([where, , since]) => where === kind && since > floor);
  const raw = content.split('\n');
  const code = stripComments(content, ext).split('\n');
  const found = [];
  code.forEach((line, i) => {
    if (raw[i].includes('browser-compat-ignore')) return;
    for (const [, pattern, since, name] of active) {
      if (pattern.test(line)) found.push({ line: i + 1, name, since, text: raw[i].trim() });
    }
  });
  return found;
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

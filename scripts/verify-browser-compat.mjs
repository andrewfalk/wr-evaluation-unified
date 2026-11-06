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
  ['js', /\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(\s*new Set\b/, 122, 'Set methods (union/intersection/…)'],
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

// Blank out comments but keep line numbers. `//` is only a comment in JS.
function stripComments(content, ext) {
  let out = content.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  if (ext !== '.css') out = out.replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
  return out;
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
    const ext = path.extname(file);
    const kind = ext === '.css' ? 'css' : 'js';
    const raw = readFileSync(file, 'utf8').split('\n');
    const code = stripComments(raw.join('\n'), ext).split('\n');
    code.forEach((line, i) => {
      if (raw[i].includes('browser-compat-ignore')) return;
      for (const [where, pattern, since, name] of active) {
        if (where === kind && pattern.test(line)) {
          violations.push({ file: path.relative(root, file).replace(/\\/g, '/'), line: i + 1, name, since, text: raw[i].trim() });
        }
      }
    });
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

main();

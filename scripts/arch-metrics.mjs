#!/usr/bin/env node
/**
 * scripts/arch-metrics.mjs — client structure ratchet (REFACTORING_ROADMAP Phase 2 P2-01).
 *
 * Counts the structural debts Phase 2 removes, so they can only go down. The baseline lives in
 * scripts/arch-baseline.json; src/__tests__/architecture.ratchet.test.js (part of `npm test`, so
 * of `npm run check`) fails when a count goes UP, and also when it goes DOWN without the baseline
 * being lowered — a PR that removes debt locks the gain in by lowering the number
 * (`node scripts/arch-metrics.mjs --lower`). stylelint is not used (user decision); this replaces
 * the roadmap's "forbid with stylelint" items together with verify-css-rules (P2-89).
 *
 * Product code = src/**\/*.{js,jsx,ts,tsx} minus tests (`__tests__/`, `*.test.*`), the test
 * helpers in src/testing/, and declaration files (*.d.ts). Fixtures under src/core/fixtures are
 * counted (createTestPatients.js is reached from the app's "테스트" button). Comments are ignored
 * (stripped with the same parsers verify-browser-compat uses).
 *
 * Metrics:
 *   windowElectronLines / windowElectronFiles — `window.electron` outside the bridge adapter
 *       (src/platform/bridge.ts, P2-10). Target 0 at P2-15.
 *   coreToModulesImports — import/export-from/import() lines in src/core/** whose specifier
 *       resolves into src/modules/. Target 0 at P2-64.
 *   rawFetch — `fetch(` calls outside the request layer (src/core/services/httpClient.js,
 *       src/core/api/**). Target 0 at P2-17.
 *   webStorageFiles — product files touching localStorage/sessionStorage outside the storage
 *       registry (src/core/storage/**). Allowed list fixed at P2-18.
 *   cssRawHex — #rgb…#rrggbbaa literals in src/**\/*.css outside src/styles/tokens.css (P2-92~93).
 *   inlineStyleHex — hex colour literals inside JSX `style={{…}}` in product code (P2-92~93).
 *
 * Usage:
 *   node scripts/arch-metrics.mjs           # print current counts vs baseline
 *   node scripts/arch-metrics.mjs --lower   # lower baseline entries that went down (never raises)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './verify-browser-compat.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = path.join(ROOT, 'scripts', 'arch-baseline.json');
const SRC = path.join(ROOT, 'src');
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx']);

const BRIDGE_FILES = new Set(['src/platform/bridge.ts']);
const REQUEST_LAYER = (rel) => rel === 'src/core/services/httpClient.js' || rel.startsWith('src/core/api/');
const STORAGE_LAYER = (rel) => rel.startsWith('src/core/storage/');
const TOKENS_CSS = new Set(['src/styles/tokens.css']);

const toRel = (full) => path.relative(ROOT, full).replace(/\\/g, '/');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

export function isProductCode(rel) {
  const ext = path.extname(rel);
  if (!CODE_EXT.has(ext)) return false;
  if (rel.endsWith('.d.ts')) return false;
  if (/(^|\/)__tests__\//.test(rel)) return false;
  if (/\.test\.[jt]sx?$/.test(rel)) return false;
  if (rel.startsWith('src/testing/')) return false;
  return true;
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** Lines (1-based) of `code` that match `re` (global regex). */
function matchingLines(code, re) {
  const lines = new Set();
  const lineStarts = [0];
  for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') lineStarts.push(i + 1);
  for (const m of code.matchAll(re)) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= m.index) lo = mid; else hi = mid - 1;
    }
    lines.add(lo + 1);
  }
  return lines;
}

/** Module specifiers on each line: static import/export-from, side-effect import, dynamic import(). */
// A template literal counts when it has no `${…}` (a static path — Codex review of #285).
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`\n$]+)\1/g;

export function coreToModulesLines(rel, code) {
  if (!rel.startsWith('src/core/')) return 0;
  const lines = new Set();
  const lineStarts = [0];
  for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') lineStarts.push(i + 1);
  for (const m of code.matchAll(SPECIFIER)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    if (target === 'src/modules' || target.startsWith('src/modules/')) {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= m.index) line += 1;
      lines.add(line);
    }
  }
  return lines.size;
}

export function inlineStyleHexCount(code) {
  let count = 0;
  // Any whitespace JSX allows: `style={{`, `style = { {` (Codex review of #285).
  const re = /\bstyle\s*=\s*\{\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 2;
    let i = m.index + m[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') depth -= 1;
      i += 1;
    }
    count += (code.slice(m.index, i).match(HEX) || []).length;
  }
  return count;
}

/** Per-file contributions. Exported for the ratchet test's failure messages. */
export function scanFile(rel, content) {
  const ext = path.extname(rel);
  const result = {};
  if (ext === '.css') {
    if (!TOKENS_CSS.has(rel)) result.cssRawHex = (stripComments(content, '.css').match(HEX) || []).length;
    return result;
  }
  if (!isProductCode(rel)) return result;
  const code = stripComments(content, ext);
  if (!BRIDGE_FILES.has(rel)) {
    const lines = matchingLines(code, /\bwindow\s*\.\s*electron\b/g).size;
    if (lines) { result.windowElectronLines = lines; result.windowElectronFiles = 1; }
  }
  const imports = coreToModulesLines(rel, code);
  if (imports) result.coreToModulesImports = imports;
  if (!REQUEST_LAYER(rel)) {
    const fetches = matchingLines(code, /(?<![.\w$])fetch\s*\(/g).size;
    if (fetches) result.rawFetch = fetches;
  }
  if (!STORAGE_LAYER(rel) && /\b(?:localStorage|sessionStorage)\b/.test(code)) result.webStorageFiles = 1;
  const inlineHex = inlineStyleHexCount(code);
  if (inlineHex) result.inlineStyleHex = inlineHex;
  return result;
}

export const METRICS = [
  'windowElectronLines',
  'windowElectronFiles',
  'coreToModulesImports',
  'rawFetch',
  'webStorageFiles',
  'cssRawHex',
  'inlineStyleHex',
];

export function computeMetrics() {
  const totals = Object.fromEntries(METRICS.map((k) => [k, 0]));
  const byFile = Object.fromEntries(METRICS.map((k) => [k, {}]));
  for (const full of walk(SRC)) {
    const rel = toRel(full);
    const ext = path.extname(rel);
    if (ext !== '.css' && !CODE_EXT.has(ext)) continue;
    const contributions = scanFile(rel, readFileSync(full, 'utf8'));
    for (const [key, value] of Object.entries(contributions)) {
      totals[key] += value;
      byFile[key][rel] = value;
    }
  }
  return { totals, byFile };
}

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function main() {
  const { totals } = computeMetrics();
  const baseline = readBaseline();
  const lower = process.argv.includes('--lower');
  let changed = false;
  for (const key of METRICS) {
    const base = baseline.metrics[key];
    const mark = totals[key] > base ? '  ↑ OVER BASELINE' : totals[key] < base ? '  ↓ lower the baseline' : '';
    console.log(`${key.padEnd(22)} ${String(totals[key]).padStart(5)} / baseline ${base}${mark}`);
    if (lower && totals[key] < base) {
      baseline.metrics[key] = totals[key];
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nLowered ${path.relative(ROOT, BASELINE_PATH)}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

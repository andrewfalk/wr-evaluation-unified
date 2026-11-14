#!/usr/bin/env node
/**
 * scripts/ts-progress.mjs — client TypeScript progress (REFACTORING_ROADMAP Phase 2 P2-01, C11).
 *
 * Measures how much of the client product code (same definition as scripts/arch-metrics.mjs:
 * src/**\/*.{js,jsx,ts,tsx} minus tests, src/testing/ and *.d.ts) is TypeScript, by lines.
 *
 * Always enforced (part of `npm run check`): the new Phase 2 layers are TypeScript only — no .js/.jsx
 * under src/platform, src/core/api, src/core/state, src/core/sync, src/core/storage, src/core/modules
 * (user decision 6, 2026-11-14: "새 계층 100% TS").
 *
 * Optional floor: `--min-lines-pct N` fails when the TS share of product lines is below N. Phase 2
 * ends at ≥45 (P2-99); ≥80 is Phase 5 D6.
 *
 * Usage:
 *   node scripts/ts-progress.mjs                    # report + new-layer check
 *   node scripts/ts-progress.mjs --min-lines-pct 45 # also enforce the line floor
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProductCode } from './arch-metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TS_ONLY_LAYERS = [
  'src/platform/',
  'src/core/api/',
  'src/core/state/',
  'src/core/sync/',
  'src/core/storage/',
  'src/core/modules/',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const lineCount = (text) => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/** files: [{ rel, lines }] → summary. Exported for scripts/tsProgress.test.mjs. */
export function summarize(files) {
  const summary = { tsFiles: 0, tsLines: 0, jsFiles: 0, jsLines: 0, jsInTsOnlyLayers: [] };
  for (const { rel, lines } of files) {
    if (!isProductCode(rel)) continue;
    const isTs = /\.tsx?$/.test(rel);
    if (isTs) { summary.tsFiles += 1; summary.tsLines += lines; } else { summary.jsFiles += 1; summary.jsLines += lines; }
    if (!isTs && TS_ONLY_LAYERS.some((dir) => rel.startsWith(dir))) summary.jsInTsOnlyLayers.push(rel);
  }
  const total = summary.tsLines + summary.jsLines;
  // linesRatio is exact (the floor compares this); linesPct is rounded for display only (Codex review of #285).
  summary.linesRatio = total === 0 ? 0 : summary.tsLines / total;
  summary.linesPct = Math.round(summary.linesRatio * 1000) / 10;
  return summary;
}

function main() {
  const args = process.argv.slice(2);
  const minIdx = args.indexOf('--min-lines-pct');
  const minPct = minIdx === -1 ? null : Number(args[minIdx + 1]);
  if (minIdx !== -1 && !Number.isFinite(minPct)) {
    console.error('ts-progress: --min-lines-pct needs a number');
    process.exit(1);
  }
  const files = walk(path.join(ROOT, 'src')).map((full) => ({
    rel: path.relative(ROOT, full).replace(/\\/g, '/'),
    lines: lineCount(readFileSync(full, 'utf8')),
  }));
  const s = summarize(files);
  console.log(`ts-progress: TS ${s.tsFiles} files / ${s.tsLines} lines, JS ${s.jsFiles} files / ${s.jsLines} lines — TS ${s.linesPct}% of product lines.`);
  let failed = false;
  if (s.jsInTsOnlyLayers.length > 0) {
    console.error(`ts-progress: JavaScript in a TS-only layer (${TS_ONLY_LAYERS.join(', ')}):`);
    for (const rel of s.jsInTsOnlyLayers) console.error(`  ${rel}`);
    failed = true;
  }
  if (minPct !== null && s.linesRatio * 100 < minPct) {
    console.error(`ts-progress: ${s.linesPct}% is below --min-lines-pct ${minPct}.`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

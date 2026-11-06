#!/usr/bin/env node
// `npm run check` — run the local pre-merge checks in one go (REFACTORING_ROADMAP P0-1 / D9).
//
// CI is deferred (D9), so this bundles the checks that were run by hand before a merge.
// It adds no new checks. Every step runs even if an earlier one fails (so one run shows
// everything that is broken), except step 0: without fresh shared builds the later
// type checks and tests would run against missing or stale dist files.
//
// Heavier checks (DB integration tests forced on, pytest, docker build) belong to a
// future `check:full` (P0-2 / P0-10 / P0-12) and are not run here.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [label, command]. Commands run through the shell from the repository root.
const prerequisite = [
  // server/tsconfig.json resolves @wr/contracts and @wr/analytics-core to their dist
  // .d.cts files, the server typecheck has no pre-hook, and the root pretest only
  // rebuilds analytics-core — so build both packages first.
  ['build shared packages', 'node scripts/prebuild-shared.mjs && node scripts/prebuild-analytics-core.mjs'],
];
const steps = [
  ['lint (root)', 'npm run lint'],
  ['lint (server)', 'npm --prefix server run lint'],
  ['browser floor (Chrome 108)', 'npm run verify:browser-compat'],
  ['typecheck (root)', 'npm run typecheck'],
  ['test (root)', 'npm test'],
  ['typecheck (server)', 'npm --prefix server run typecheck'],
  ['test (server)', 'npm --prefix server test'],
  ['build:web', 'npm run build:web'],
];

function run([label, command]) {
  process.stdout.write(`\n=== ${label}: ${command}\n`);
  const started = Date.now();
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0 && !result.error;
  if (result.error) process.stdout.write(`(could not start: ${result.error.message})\n`);
  return { label, ok, seconds, status: result.error ? 'error' : result.status };
}

const results = [];
for (const step of prerequisite) results.push(run(step));
if (results.every((r) => r.ok)) {
  for (const step of steps) results.push(run(step));
} else {
  for (const [label] of steps) results.push({ label, ok: false, seconds: '-', status: 'skipped' });
}

const width = Math.max(...results.map((r) => r.label.length));
process.stdout.write('\n=== check summary\n');
for (const r of results) {
  const mark = r.ok ? 'PASS' : r.status === 'skipped' ? 'SKIP' : 'FAIL';
  process.stdout.write(`  ${mark}  ${r.label.padEnd(width)}  ${String(r.seconds).padStart(6)}s\n`);
}
const failed = results.filter((r) => !r.ok);
process.stdout.write(failed.length === 0 ? '\nAll checks passed.\n' : `\n${failed.length} step(s) did not pass.\n`);
process.exit(failed.length === 0 ? 0 : 1);

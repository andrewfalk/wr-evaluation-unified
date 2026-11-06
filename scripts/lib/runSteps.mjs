// Shared step runner for scripts/check.mjs and scripts/check-full.mjs (REFACTORING_ROADMAP D9).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The quick pre-merge bundle (`npm run check`). [label, command]; commands run through the
// shell from the repository root.
export const CHECK_PREREQUISITE = [
  // server/tsconfig.json resolves @wr/contracts and @wr/analytics-core to their dist
  // .d.cts files, the server typecheck has no pre-hook, and the root pretest only
  // rebuilds analytics-core — so build both packages first.
  ['build shared packages', 'node scripts/prebuild-shared.mjs && node scripts/prebuild-analytics-core.mjs'],
];
export const CHECK_STEPS = [
  ['lint (root)', 'npm run lint'],
  ['lint (server)', 'npm --prefix server run lint'],
  ['browser floor (Chrome 108)', 'npm run verify:browser-compat'],
  ['typecheck (root)', 'npm run typecheck'],
  ['test (root)', 'npm test'],
  ['typecheck (server)', 'npm --prefix server run typecheck'],
  ['test (server)', 'npm --prefix server test'],
  ['build:web', 'npm run build:web'],
];

export function runStep(label, command, { env = {}, cwd = root } = {}) {
  process.stdout.write(`\n=== ${label}: ${command}\n`);
  const started = Date.now();
  const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0 && !result.error;
  if (result.error) process.stdout.write(`(could not start: ${result.error.message})\n`);
  return { label, ok, seconds, status: result.error ? 'error' : result.status };
}

export function skipped(label) {
  return { label, ok: false, seconds: '-', status: 'skipped' };
}

// Runs the prerequisite, then every check step even if some fail (one run shows everything
// that is broken). If the prerequisite fails, the steps are reported as SKIP.
export function runCheckSteps({ env = {} } = {}) {
  const results = CHECK_PREREQUISITE.map(([label, command]) => runStep(label, command, { env }));
  const ready = results.every((r) => r.ok);
  for (const [label, command] of CHECK_STEPS) {
    results.push(ready ? runStep(label, command, { env }) : skipped(label));
  }
  return results;
}

export function printSummary(title, results) {
  const width = Math.max(...results.map((r) => r.label.length));
  process.stdout.write(`\n=== ${title} summary\n`);
  for (const r of results) {
    const mark = r.ok ? 'PASS' : r.status === 'skipped' ? 'SKIP' : 'FAIL';
    process.stdout.write(`  ${mark}  ${r.label.padEnd(width)}  ${String(r.seconds).padStart(6)}s\n`);
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(failed.length === 0 ? '\nAll checks passed.\n' : `\n${failed.length} step(s) did not pass.\n`);
  return failed.length === 0 ? 0 : 1;
}

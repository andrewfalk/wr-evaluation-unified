// Shared step runner for scripts/check.mjs and scripts/check-full.mjs (REFACTORING_ROADMAP D9).
//
// Steps run one at a time as child processes, asynchronously, so Ctrl+C / SIGTERM is handled
// while a step is running: the running step's process tree is stopped and the remaining steps
// are reported as SKIP (Codex review of #192 — with synchronous spawns the handler never ran and
// later steps kept starting).
import { spawn, spawnSync } from 'node:child_process';
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
  ['migrations immutable (vs origin/main)', 'npm run verify:migrations-immutable'],
  ['typecheck (root)', 'npm run typecheck'],
  ['ts ratchet (@ts-nocheck baseline)', 'npm run verify:ts-ratchet'],
  ['ts progress (new layers TS-only)', 'npm run verify:ts-progress'],
  ['test (root)', 'npm test'],
  ['typecheck (server)', 'npm --prefix server run typecheck'],
  ['test (server)', 'npm --prefix server test'],
  ['build:web', 'npm run build:web'],
];

let aborted = false;
let current = null; // the running step's child process

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // shell:true runs cmd.exe → npm → node…; kill the whole tree.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

// Stop the running step and skip the rest. Safe to call more than once.
export function requestAbort() {
  aborted = true;
  stopTree(current);
}

export function isAborted() {
  return aborted;
}

// Ctrl+C / termination → abort. A second Ctrl+C exits immediately ('exit' handlers still run).
export function installAbortHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (aborted) process.exit(130);
      process.stdout.write(`\n${signal} — stopping the current step and skipping the rest.\n`);
      requestAbort();
    });
  }
}

export function skipped(label) {
  return { label, ok: false, seconds: '-', status: 'skipped' };
}

export function runStep(label, command, { env = {}, cwd = root } = {}) {
  if (aborted) return Promise.resolve(skipped(label));
  process.stdout.write(`\n=== ${label}: ${command}\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...env },
      // Own process group on POSIX so the whole tree can be signalled; on Windows stay in the
      // console so Ctrl+C reaches the step too.
      detached: process.platform !== 'win32',
    });
    current = child;
    const finish = (status, error) => {
      current = null;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (error) process.stdout.write(`(could not start: ${error.message})\n`);
      const ok = status === 0 && !error && !aborted;
      resolve({ label, ok, seconds, status: aborted ? 'aborted' : error ? 'error' : status });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code, null));
  });
}

// Runs the prerequisite, then every check step even if some fail (one run shows everything
// that is broken). If the prerequisite fails, the steps are reported as SKIP.
export async function runCheckSteps({ env = {} } = {}) {
  const results = [];
  for (const [label, command] of CHECK_PREREQUISITE) results.push(await runStep(label, command, { env }));
  const ready = results.every((r) => r.ok);
  for (const [label, command] of CHECK_STEPS) {
    results.push(ready ? await runStep(label, command, { env }) : skipped(label));
  }
  return results;
}

export function printSummary(title, results) {
  const width = Math.max(...results.map((r) => r.label.length));
  process.stdout.write(`\n=== ${title} summary\n`);
  for (const r of results) {
    const mark = r.ok ? 'PASS' : r.status === 'skipped' ? 'SKIP' : r.status === 'aborted' ? 'STOP' : 'FAIL';
    process.stdout.write(`  ${mark}  ${r.label.padEnd(width)}  ${String(r.seconds).padStart(6)}s\n`);
  }
  if (aborted) {
    process.stdout.write('\nStopped by a signal.\n');
    return 130;
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(failed.length === 0 ? '\nAll checks passed.\n' : `\n${failed.length} step(s) did not pass.\n`);
  return failed.length === 0 ? 0 : 1;
}

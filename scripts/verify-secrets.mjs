#!/usr/bin/env node
/**
 * scripts/verify-secrets.mjs — secret scan of the git history with gitleaks (REFACTORING_ROADMAP,
 * 보안 훅 / D9). The repository is public: a password, key or token committed even once stays
 * readable in the history.
 *
 *   npm run verify:secrets      (also step 6 of `npm run check:full`) — run it before pushing.
 *
 * Runs gitleaks in Docker (nothing to install), pinned by digest, against the current branch's
 * history — including commits that have not been pushed yet. The repository is mounted read-only
 * and found values are redacted in the output. Reviewed false positives are listed in
 * .gitleaksignore at the repository root.
 *
 * Exit codes: 0 = no findings; 1 = findings, Docker unavailable, or the scan could not run.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// gitleaks v8.30.1 — pinned by digest so the scanner cannot change underneath us.
const IMAGE = 'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';

function fail(message, code = 1) {
  console.error(`verify-secrets: ${message}`);
  process.exit(code);
}

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  fail('Docker is not running. Start Docker Desktop and run `npm run verify:secrets` again.');
}

const result = spawnSync('docker', [
  'run', '--rm',
  // The mounted repository belongs to another user inside the container; let git read it
  // without writing any config.
  '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=*',
  '-v', `${root}:/repo:ro`,
  IMAGE,
  'git', '/repo', '--redact', '--no-banner', '--gitleaks-ignore-path', '/repo',
], { stdio: 'inherit' });

if (result.error) fail(`could not start docker: ${result.error.message}`);
if (result.status === 0) {
  console.log('verify-secrets: no secrets found in the git history.');
  process.exit(0);
}
if (result.status === 1) {
  fail(
    'gitleaks reported possible secrets (values redacted above).\n' +
    '  - A real secret: ROTATE it first (change the password / revoke the key). Deleting the commit does not\n' +
    '    help once it is pushed — this repository is public. If it is not pushed yet, also remove it from the\n' +
    '    commits before pushing.\n' +
    '  - A false positive: confirm the value is not a secret, then add the printed fingerprint to\n' +
    '    .gitleaksignore with a comment saying why.',
  );
}
fail(`gitleaks could not complete the scan (exit ${result.status}).`);

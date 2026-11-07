// Pre-build hook for the shared/contracts workspace package (@wr/contracts).
// Builds shared/dist (ESM + CJS + .d.ts) before the web/Electron build, tests and typecheck.
// npm workspaces (REFACTORING_ROADMAP P0-7 W3): the root `npm install`/`npm ci` installs every
// workspace's dependencies (tsup included), so there is no per-package install fallback here.

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npm', ['run', 'build', '--workspace', '@wr/contracts'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);

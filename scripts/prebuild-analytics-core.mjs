// Pre-build hook for the packages/analytics-core workspace package (@wr/analytics-core).
// Mirrors scripts/prebuild-shared.mjs — builds packages/analytics-core/dist before builds/tests.
// npm workspaces (REFACTORING_ROADMAP P0-7 W3): dependencies come from the root install.

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npm', ['run', 'build', '--workspace', '@wr/analytics-core'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);

// Safe pre-build hook for the packages/analytics-core package. Mirrors
// scripts/prebuild-shared.mjs exactly — runs `npm --prefix packages/analytics-core run
// build` only when packages/analytics-core/package.json exists.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pkgPath = resolve(repoRoot, 'packages', 'analytics-core', 'package.json');

if (!existsSync(pkgPath)) {
  process.exit(0);
}

const spawnOpts = { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' };

const tsupBin = resolve(repoRoot, 'packages', 'analytics-core', 'node_modules', '.bin', 'tsup');
if (!existsSync(tsupBin)) {
  const install = spawnSync('npm', ['--prefix', 'packages/analytics-core', 'install'], spawnOpts);
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const result = spawnSync('npm', ['--prefix', 'packages/analytics-core', 'run', 'build'], spawnOpts);
process.exit(result.status ?? 1);

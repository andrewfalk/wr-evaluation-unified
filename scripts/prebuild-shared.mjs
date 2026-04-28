// Safe pre-build hook for the shared/contracts package.
// Runs `npm --prefix shared run build` only when shared/package.json exists.
// While T01 has not yet created the shared package, this script is a no-op so
// that build:web / electron:build keep working.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sharedPkg = resolve(repoRoot, 'shared', 'package.json');

if (!existsSync(sharedPkg)) {
  // Shared package not introduced yet — silently skip.
  process.exit(0);
}

const spawnOpts = { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' };

// In a clean checkout root `npm install` does not install shared/node_modules.
// Install only when tsup is absent to keep incremental builds fast.
const tsupBin = resolve(repoRoot, 'shared', 'node_modules', '.bin', 'tsup');
if (!existsSync(tsupBin)) {
  const install = spawnSync('npm', ['--prefix', 'shared', 'install'], spawnOpts);
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const result = spawnSync('npm', ['--prefix', 'shared', 'run', 'build'], spawnOpts);
process.exit(result.status ?? 1);

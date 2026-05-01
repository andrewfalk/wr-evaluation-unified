// scripts/set-build-target.mjs
// Usage: node scripts/set-build-target.mjs [standalone|intranet]
// Writes electron/build-target.json so main.js can detect the build target
// even when WR_BUILD_TARGET env is not set at runtime.
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];

if (target !== 'standalone' && target !== 'intranet') {
  console.error('Usage: node scripts/set-build-target.mjs [standalone|intranet]');
  process.exit(1);
}

const outPath = join(__dirname, '..', 'electron', 'build-target.json');
writeFileSync(outPath, JSON.stringify({ target }, null, 2) + '\n', 'utf-8');
console.log(`[set-build-target] electron/build-target.json → target=${target}`);

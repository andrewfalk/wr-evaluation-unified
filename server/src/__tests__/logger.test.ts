// S11: the logger reads only LOG_LEVEL / NODE_ENV — not the whole config — so modules a CLI reaches without the
// server's required settings (db/client.ts, db/migrate.ts) can import it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLogLevel } from '../config/schema';

const SRC = path.resolve(__dirname, '..');
const CONFIG = path.join(SRC, 'config.ts');

/**
 * Every file reachable from `entry` through relative imports: `from '…'`, side-effect `import '…'`, dynamic `import('…')`
 * and `require('…')`, in either quote style.
 */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)) {
      const base = path.resolve(path.dirname(file), m[2].replace(/\.js$/, ''));
      const target = [`${base}.ts`, path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
      if (target) queue.push(target);
    }
  }
  return seen;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('logger', () => {
  it.each(['logger.ts', 'db/client.ts', 'db/migrate.ts'])('%s does not reach src/config.ts through its imports', (file) => {
    const files = reachable(path.join(SRC, file));
    expect(files.size).toBeGreaterThan(1); // the walk follows imports (the entry alone would prove nothing)
    expect([...files].map((f) => path.relative(SRC, f))).not.toContain('config.ts');
    expect(files.has(CONFIG)).toBe(false);
  });

  it('the walk follows every import form (side-effect, dynamic, require, double quotes)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-import-walk-'));
    try {
      const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
      write('a.ts', 'import "./b";\n');
      write('b.ts', "import './c';\n");
      write('c.ts', "export const load = () => import('./d');\n");
      write('d.ts', 'const e = require("./e");\nexport { e };\n');
      write('e.ts', 'export {};\n');
      expect([...reachable(path.join(dir, 'a.ts'))].map((f) => path.basename(f)).sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the walk does see config.ts where it is imported (control)', () => {
    expect(reachable(path.join(SRC, 'boot.ts')).has(CONFIG)).toBe(true);
  });

  it('takes its level from LOG_LEVEL', async () => {
    vi.resetModules();
    vi.stubEnv('LOG_LEVEL', 'warn');
    const { logger } = await import('../logger.js');
    expect(logger.level).toBe('warn');
  });
});

describe('resolveLogLevel', () => {
  it('defaults by NODE_ENV and rejects an unknown level', () => {
    expect(resolveLogLevel({})).toBe('info');
    expect(resolveLogLevel({ NODE_ENV: 'test' })).toBe('silent');
    expect(resolveLogLevel({ NODE_ENV: 'production', LOG_LEVEL: 'debug' })).toBe('debug');
    expect(() => resolveLogLevel({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL must be one of/);
  });
});

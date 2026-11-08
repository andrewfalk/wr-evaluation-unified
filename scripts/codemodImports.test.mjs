// scripts/codemod-imports.mjs (S6 P1-33): rewrites relative paths after files move. Each case builds a
// throw-away git repository, moves files with --apply-moves and checks the rewritten sources.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, 'codemod-imports.mjs');
const dirs = [];

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemod-'));
  dirs.push(dir);
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

function run(dir, moves, ...flags) {
  fs.writeFileSync(path.join(dir, 'moves.json'), JSON.stringify(moves));
  const r = spawnSync(process.execPath, [SCRIPT, 'moves.json', '--root', 'src', ...flags], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const read = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');

afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('codemod-imports', () => {
  it('rewrites imports of a moved module and the moved file\'s own imports, incl. vi.mock and importActual<…>', () => {
    const dir = repo({
      'src/config.ts': 'export default {};\n',
      'src/statsEngine.ts': "import config from './config';\nexport const run = () => config;\n",
      'src/app.ts': "import { run } from './statsEngine';\nexport const x = run;\n",
      'src/__tests__/statsEngine.test.ts': [
        "import { run } from '../statsEngine';",
        "vi.mock('../config', () => ({ default: {} }));",
        "const a = await vi.importActual<typeof import('../statsEngine')>('../statsEngine');",
        "const p = path.resolve(__dirname, '../../services/x');",
        '',
      ].join('\n'),
      'services/x/.keep': '',
    });
    const r = run(dir, {
      'src/statsEngine.ts': 'src/stats/engine/index.ts',
      'src/__tests__/statsEngine.test.ts': 'src/stats/engine/__tests__/engine.test.ts',
    }, '--apply-moves');
    expect(r.code).toBe(0);
    expect(read(dir, 'src/app.ts')).toContain("from './stats/engine'");
    expect(read(dir, 'src/stats/engine/index.ts')).toContain("import config from '../../config'");
    const t = read(dir, 'src/stats/engine/__tests__/engine.test.ts');
    expect(t).toContain("import { run } from '..';");
    expect(t).toContain("vi.mock('../../../config'");
    expect(t).toContain("vi.importActual<typeof import('..')>('..')");
    expect(t).toContain("path.resolve(__dirname, '../../../../services/x')");
  });

  it('a moved file whose old relative path now lands on a different sibling keeps its original meaning (Codex R1)', () => {
    const dir = repo({
      'src/config.ts': 'export default { real: true };\n',
      'src/routes/config.ts': 'export const routeConfig = 1;\n',
      'src/app.ts': "import config from './config';\nexport default config;\n",
    });
    const r = run(dir, { 'src/app.ts': 'src/routes/app.ts' }, '--apply-moves');
    expect(r.code).toBe(0);
    expect(read(dir, 'src/routes/app.ts')).toContain("import config from '../config'");
  });

  it('keeps a .mjs / .js extension and spells out index when an extension is used', () => {
    const dir = repo({
      'src/a.mjs': 'export const a = 1;\n',
      'src/b.mjs': "import { a } from './a.mjs';\n",
      'src/statsEngine.ts': 'export const e = 1;\n',
      'src/c.ts': "const m = await import('./statsEngine.js');\n",
    });
    const r = run(dir, { 'src/a.mjs': 'src/lib/a.mjs', 'src/statsEngine.ts': 'src/stats/engine/index.ts' }, '--apply-moves');
    expect(r.code).toBe(0);
    expect(read(dir, 'src/b.mjs')).toContain("from './lib/a.mjs'");
    expect(read(dir, 'src/c.ts')).toContain("import('./stats/engine/index.js')");
  });

  it('is idempotent: a second run changes nothing and reports no ambiguity', () => {
    const dir = repo({
      'src/index.ts': 'export {};\n',
      'src/statsEngine.ts': 'export const e = 1;\n',
      'src/__tests__/statsEngine.test.ts': "import { e } from '../statsEngine.js';\n",
    });
    const moves = {
      'src/statsEngine.ts': 'src/stats/engine/index.ts',
      'src/__tests__/statsEngine.test.ts': 'src/stats/engine/__tests__/engine.test.ts',
    };
    expect(run(dir, moves, '--apply-moves').code).toBe(0);
    const after = read(dir, 'src/stats/engine/__tests__/engine.test.ts');
    expect(after).toContain("from '../index.js'");
    // From the old directory '../index.js' would mean src/index.ts — must not be flagged or changed.
    const second = run(dir, moves);
    expect(second.code).toBe(0);
    expect(second.out).toContain('0 path(s) rewritten');
    expect(second.out).not.toContain('AMBIGUOUS');
    expect(read(dir, 'src/stats/engine/__tests__/engine.test.ts')).toBe(after);
  });

  it('a file moved earlier with mixed old/new paths: a path that means different files before and after is reported, not guessed', () => {
    const dir = repo({
      'src/config.ts': 'export default {};\n',
      'src/routes/config.ts': 'export const c = 1;\n',
      'src/routes/app.ts': "import config from './config';\nimport { gone } from './old-sibling';\n",
    });
    // app.ts was moved by an earlier run (not --apply-moves now) and still has an unresolved old path.
    const r = run(dir, { 'src/app.ts': 'src/routes/app.ts', 'src/old-sibling.ts': 'src/routes/sibling.ts' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("AMBIGUOUS");
    expect(r.out).toContain("src/routes/app.ts: './config'");
    expect(read(dir, 'src/routes/app.ts')).toContain("import config from './config'");
    expect(read(dir, 'src/routes/app.ts')).toContain("from './sibling'"); // the unambiguous one is fixed
  });

  it('after a rebase, a moved file whose only import now resolves to a different pre-existing file is reported (Codex R2)', () => {
    const dir = repo({
      'src/config.ts': 'export default {};\n',
      'src/routes/config.ts': 'export const c = 1;\n',
      'src/routes/app.ts': "import config from './config';\n",
    });
    const r = run(dir, { 'src/app.ts': 'src/routes/app.ts' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/routes/app.ts: './config'");
    expect(read(dir, 'src/routes/app.ts')).toContain("from './config'");
  });

  it('a moved file without relative imports still gets its __dirname paths fixed (Codex R2)', () => {
    const dir = repo({
      'services/x/input.json': '{}\n',
      'src/stats/engine/reader.ts': "const p = path.resolve(__dirname, '../services/x/input.json');\n",
    });
    // reader.ts was moved by an earlier run from src/reader.ts; its __dirname path still has the old depth.
    const r = run(dir, { 'src/reader.ts': 'src/stats/engine/reader.ts' });
    expect(r.code).toBe(0);
    expect(read(dir, 'src/stats/engine/reader.ts')).toContain("path.resolve(__dirname, '../../../services/x/input.json')");
  });

  it('after a rebase, an old path that now lands on a moved-in file is reported, not trusted (Codex R3)', () => {
    const dir = repo({
      'src/config.ts': 'export default { real: true };\n',
      'src/routes/config.ts': 'export default { other: true };\n', // moved in from src/otherConfig.ts
      'src/routes/app.ts': "import config from './config';\n",
    });
    const r = run(dir, { 'src/app.ts': 'src/routes/app.ts', 'src/otherConfig.ts': 'src/routes/config.ts' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/routes/app.ts: './config'");
    expect(read(dir, 'src/routes/app.ts')).toContain("from './config'");
  });

  it('keeps the folder index when the shorter path would load a same-named file instead (Codex R3)', () => {
    const dir = repo({
      'src/old.ts': 'export const value = "old";\n',
      'src/lib.ts': 'export const value = "lib";\n',
      'src/app.ts': "import { value } from './old';\n",
    });
    const r = run(dir, { 'src/old.ts': 'src/lib/index.ts' }, '--apply-moves');
    expect(r.code).toBe(0);
    expect(read(dir, 'src/app.ts')).toContain("from './lib/index'");
  });

  it('--apply-moves writes a record; a later run trusts the recorded paths but still checks new ones', () => {
    const dir = repo({
      'src/index.ts': 'export {};\n',
      'src/config.ts': 'export default {};\n',
      'src/statsEngine.ts': 'export const e = 1;\n',
      'src/__tests__/statsEngine.test.ts': "import { e } from '../statsEngine.js';\n",
    });
    const moves = {
      'src/statsEngine.ts': 'src/stats/engine/index.ts',
      'src/__tests__/statsEngine.test.ts': 'src/stats/engine/__tests__/engine.test.ts',
    };
    expect(run(dir, moves, '--apply-moves').code).toBe(0);
    const rec = JSON.parse(read(dir, 'moves.applied.json'));
    expect(rec['src/stats/engine/__tests__/engine.test.ts']).toEqual({ 'm:../index.js': 1 });
    // A rebased branch adds an old-style import to the moved test: '../config' meant src/config.ts.
    const t = 'src/stats/engine/__tests__/engine.test.ts';
    fs.writeFileSync(path.join(dir, t), read(dir, t) + "import config from '../config';\n");
    const r = run(dir, moves);
    expect(r.code).toBe(0);
    expect(read(dir, t)).toContain("from '../index.js'"); // trusted, untouched
    expect(read(dir, t)).toContain("import config from '../../../config';"); // fixed from its old meaning
  });

  it('a rebased import with the same text as a recorded one is checked again, not trusted (Codex R4)', () => {
    const dir = repo({
      'src/index.ts': 'export const e = "root";\n',
      'src/statsEngine.ts': 'export const e = 1;\n',
      'src/__tests__/statsEngine.test.ts': "import { e } from '../statsEngine.js';\n",
    });
    const moves = {
      'src/statsEngine.ts': 'src/stats/engine/index.ts',
      'src/__tests__/statsEngine.test.ts': 'src/stats/engine/__tests__/engine.test.ts',
    };
    expect(run(dir, moves, '--apply-moves').code).toBe(0);
    // The branch (written before the move) imported the ROOT index as '../index.js' — same text as the
    // recorded, rewritten engine import, but it meant src/index.ts.
    const t = 'src/stats/engine/__tests__/engine.test.ts';
    fs.writeFileSync(path.join(dir, t), read(dir, t) + "import { e as rootE } from '../index.js';\n");
    const r = run(dir, moves);
    expect(r.code).toBe(1);
    expect(r.out).toContain('AMBIGUOUS');
    expect(r.out).toContain(`${t}: '../index.js'`);
  });

  it("'--root ./src' behaves like '--root src' (Codex R4)", () => {
    const files = {
      'src/config.ts': 'export default {};\n',
      'src/routes/config.ts': 'export const c = 1;\n',
      'src/app.ts': "import config from './config';\n",
    };
    for (const root of ['src', './src', 'src/', './src//']) {
      const dir = repo(files);
      fs.writeFileSync(path.join(dir, 'moves.json'), JSON.stringify({ 'src/app.ts': 'src/routes/app.ts' }));
      const r = spawnSync(process.execPath, [SCRIPT, 'moves.json', '--apply-moves', '--root', root], { cwd: dir, encoding: 'utf8' });
      expect(r.status, root).toBe(0);
      expect(read(dir, 'src/routes/app.ts'), root).toContain("import config from '../config'");
    }
  });

  it('--write-record records an already-moved tree and refuses paths that do not resolve', () => {
    const dir = repo({
      'src/index.ts': 'export {};\n',
      'src/stats/engine/index.ts': 'export const e = 1;\n',
      'src/stats/engine/__tests__/engine.test.ts': "import { e } from '../index.js';\n",
    });
    const moves = {
      'src/statsEngine.ts': 'src/stats/engine/index.ts',
      'src/__tests__/statsEngine.test.ts': 'src/stats/engine/__tests__/engine.test.ts',
    };
    expect(run(dir, moves, '--write-record').code).toBe(0);
    expect(JSON.parse(read(dir, 'moves.applied.json'))['src/stats/engine/__tests__/engine.test.ts']).toEqual({ 'm:../index.js': 1 });
    const again = run(dir, moves);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain('AMBIGUOUS');
    fs.writeFileSync(path.join(dir, 'src/stats/engine/__tests__/engine.test.ts'), "import { x } from './missing';\n");
    expect(run(dir, moves, '--write-record').code).toBe(1);
  });

  it("a module moved next to its folder index imports it as '.' (not './')", () => {
    const dir = repo({
      'src/statsEngine.ts': 'export const e = 1;\n',
      'src/statsErrors.ts': "import { e } from './statsEngine';\n",
    });
    const r = run(dir, { 'src/statsEngine.ts': 'src/stats/engine/index.ts', 'src/statsErrors.ts': 'src/stats/engine/errors.ts' }, '--apply-moves');
    expect(r.code).toBe(0);
    expect(read(dir, 'src/stats/engine/errors.ts')).toContain("import { e } from '.';");
    expect(run(dir, { 'src/statsEngine.ts': 'src/stats/engine/index.ts', 'src/statsErrors.ts': 'src/stats/engine/errors.ts' }).code).toBe(0);
  });

  it("bare '.' and '..' specifiers are rewritten too (Codex R2)", () => {
    const dir = repo({
      'src/index.ts': 'export const value = 1;\n',
      'src/feature/index.ts': 'export const f = 1;\n',
      'src/feature/a.ts': "import { value } from '..';\nimport { f } from '.';\n",
    });
    const r = run(dir, { 'src/feature/a.ts': 'src/stats/engine/a.ts' }, '--apply-moves');
    expect(r.code).toBe(0);
    const a = read(dir, 'src/stats/engine/a.ts');
    expect(a).toContain("import { value } from '../..';");
    expect(a).toContain("import { f } from '../../feature';");
  });
});

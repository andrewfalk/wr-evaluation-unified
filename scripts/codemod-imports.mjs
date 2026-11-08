#!/usr/bin/env node
// Rewrite relative module paths after files move (S6 P1-33 — server/src/stats*.ts → server/src/stats/**).
//
//   node scripts/codemod-imports.mjs <moves.json> [--apply-moves] [--root <dir>]...
//
// moves.json maps repo-relative old paths to new paths. With --apply-moves the files are moved first
// (`git mv`). Then every .ts/.tsx/.js/.mjs file under the roots (default: server/src) is rewritten:
//   - import/export … from '…', import('…'), require('…'), typeof import('…')
//   - vi.mock('…'), vi.doMock('…'), vi.importActual('…'), vi.unmock('…')
//   - path.resolve(__dirname, '…') / path.join(__dirname, '…') and toMatchFileSnapshot('…')
// A specifier is resolved from the file's ORIGINAL location (its old path when the file itself moved),
// mapped through moves.json if its target moved, and written relative to the file's current location.
// Extension style ('.js' or none) is kept. Run it again on a feature branch after rebasing onto the
// move to fix that branch's new imports too (files already pointing at the new paths are left alone).
//
// The roadmap's "move conflict" note points here: keep the moves.json of each move PR next to it in
// scripts/moves/ so a branch can be rebased with the same map.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mapFile = args.find((a) => !a.startsWith('--') && !isRootValue(a));
function isRootValue(a) {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1] === '--root';
}
if (!mapFile) {
  console.error('usage: codemod-imports.mjs <moves.json> [--apply-moves] [--root <dir>]...');
  process.exit(2);
}
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const roots = [];
args.forEach((a, i) => { if (a === '--root') roots.push(args[i + 1]); });
if (roots.length === 0) roots.push('server/src');

const moves = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const norm = (p) => p.split(path.sep).join('/');
const abs = (p) => path.join(repo, p);
const forward = new Map(Object.entries(moves).map(([a, b]) => [norm(a), norm(b)]));
const backward = new Map([...forward].map(([a, b]) => [b, a]));

if (args.includes('--apply-moves')) {
  for (const [from, to] of forward) {
    if (!fs.existsSync(abs(from))) continue; // already moved
    fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
    execFileSync('git', ['mv', from, to], { cwd: repo });
  }
}

const exists = (repoRel) => fs.existsSync(abs(repoRel));
const CODE_EXT = ['.ts', '.tsx', '.js', '.mjs'];

// Resolve a relative module specifier against an (old) directory to a repo-relative file path, as it
// was before the moves: an old path that has moved no longer exists on disk but is a key of the map.
function resolveModule(fromDirRel, spec) {
  const base = norm(path.posix.normalize(path.posix.join(fromDirRel, spec)));
  const known = (p) => forward.has(p) || (exists(p) && !backward.has(p));
  const stripped = base.replace(/\.(js|mjs)$/, '');
  const candidates = [base, ...CODE_EXT.map((e) => stripped + e), ...CODE_EXT.map((e) => `${stripped}/index${e}`)];
  for (const c of candidates) if (known(c)) return c;
  return null;
}

function resolvePlain(fromDirRel, spec) {
  const p = norm(path.posix.normalize(path.posix.join(fromDirRel, spec)));
  return forward.has(p) || exists(p) ? p : null;
}

// Does the specifier already point at an existing file from the file's current directory? Then it is
// correct (or was fixed by an earlier run) and is left alone — this makes the codemod idempotent.
function resolvesNow(dirRel, spec, isModule) {
  const base = norm(path.posix.normalize(path.posix.join(dirRel, spec)));
  if (!isModule) return exists(base);
  const stripped = base.replace(/\.(js|mjs)$/, '');
  return [base, ...CODE_EXT.map((e) => stripped + e), ...CODE_EXT.map((e) => `${stripped}/index${e}`)]
    .some((c) => exists(c) && fs.statSync(abs(c)).isFile());
}

function relativeSpec(fromDirRel, targetRel, originalSpec, isModule) {
  let target = targetRel;
  if (isModule) {
    const hadJs = /\.(js|mjs)$/.test(originalSpec);
    const wasIndex = /\/index\.(ts|tsx|js|mjs)$/.test(targetRel) && !/\/index(\.(js|mjs))?$/.test(originalSpec);
    target = target.replace(/\.(ts|tsx|js|mjs)$/, '');
    // A folder index target is written as the folder unless the original spelled out "index".
    // With a '.js' extension the index must stay spelled out ('…/engine/index.js', not '…/engine.js').
    if (!hadJs && (wasIndex || (/\/index$/.test(target) && !/index(\.js)?$/.test(originalSpec)))) target = target.replace(/\/index$/, '');
    if (hadJs) target += '.js';
  }
  let rel = path.posix.relative(fromDirRel, target);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

const MODULE_PATTERNS = [
  /(\bfrom\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
  /(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
  /(\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
  // optional type argument: vi.importActual<typeof import('…')>('…')
  /(\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^;]*?>)?\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
  /(^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\2/gm,
];
const PLAIN_PATTERNS = [
  /(\bpath\.(?:resolve|join)\s*\(\s*__dirname\s*,\s*)(['"])([^'"]+)\2/g,
  /(\btoMatchFileSnapshot\s*\(\s*)(['"])([^'"]+)\2/g,
];

function walk(dirRel, out) {
  for (const e of fs.readdirSync(abs(dirRel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = `${dirRel}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (CODE_EXT.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

let changedFiles = 0;
let changedSpecs = 0;
const unresolved = [];
for (const root of roots) {
  for (const fileRel of walk(norm(root), [])) {
    const originalRel = backward.get(fileRel) ?? fileRel;
    const oldDir = path.posix.dirname(originalRel);
    const newDir = path.posix.dirname(fileRel);
    const src = fs.readFileSync(abs(fileRel), 'utf8');
    let out = src;
    const rewrite = (pattern, isModule) => {
      out = out.replace(pattern, (whole, pre, q, spec) => {
        if (!isModule && spec.startsWith('/')) return whole;
        if (resolvesNow(newDir, spec, isModule)) return whole;
        const target = isModule ? resolveModule(oldDir, spec) : resolvePlain(oldDir, spec);
        if (!target) {
          if (isModule || oldDir !== newDir) unresolved.push(`${fileRel}: ${spec}`);
          return whole;
        }
        const moved = forward.get(target) ?? target;
        const next = relativeSpec(newDir, moved, spec, isModule);
        const plainSame = !isModule && path.posix.normalize(spec) === path.posix.normalize(next);
        if (next === spec || plainSame) return whole;
        changedSpecs += 1;
        return `${pre}${q}${next}${q}`;
      });
    };
    for (const p of MODULE_PATTERNS) rewrite(p, true);
    for (const p of PLAIN_PATTERNS) rewrite(p, false);
    if (out !== src) {
      fs.writeFileSync(abs(fileRel), out);
      changedFiles += 1;
    }
  }
}
console.log(`codemod-imports: ${changedSpecs} path(s) rewritten in ${changedFiles} file(s)`);
if (unresolved.length > 0) {
  console.log(`unresolved relative paths (left as is, ${unresolved.length}):`);
  for (const u of unresolved) console.log(`  ${u}`);
}

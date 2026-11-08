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

// Files moved by this invocation still hold their pre-move specifiers (relative to the old location).
const movedNow = new Set();
if (args.includes('--apply-moves')) {
  for (const [from, to] of forward) {
    if (!fs.existsSync(abs(from))) continue; // already moved
    fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
    execFileSync('git', ['mv', from, to], { cwd: repo });
    movedNow.add(to);
  }
}

const exists = (repoRel) => fs.existsSync(abs(repoRel));
const CODE_EXT = ['.ts', '.tsx', '.js', '.mjs'];

// Resolve a relative module specifier against an (old) directory to a repo-relative file path, as it
// was before the moves: an old path that has moved no longer exists on disk but is a key of the map.
function candidates(fromDirRel, spec, isModule) {
  const base = norm(path.posix.normalize(path.posix.join(fromDirRel, spec))).replace(/\/+$/, '');
  if (!isModule) return [base];
  const stripped = base.replace(/\.(js|mjs)$/, '');
  return [base, ...CODE_EXT.map((e) => stripped + e), ...CODE_EXT.map((e) => `${stripped}/index${e}`)];
}
const isFile = (p) => exists(p) && fs.statSync(abs(p)).isFile();
// Module specifiers name files; __dirname paths may name a directory (e.g. services/stats-engine).
const isTarget = (p, isModule) => (isModule ? isFile(p) : exists(p));

// A: what the specifier meant before the moves — resolved from the file's original directory against
// the pre-move tree (a moved-away path is a key of the map; a moved-in path did not exist yet).
function resolveOriginal(fromDirRel, spec, isModule) {
  const known = (p) => forward.has(p) || (isTarget(p, isModule) && !backward.has(p));
  return candidates(fromDirRel, spec, isModule).find(known) ?? null;
}

// B: what the specifier points at now, from the file's current directory.
function resolveCurrent(dirRel, spec, isModule) {
  return candidates(dirRel, spec, isModule).find((p) => isTarget(p, isModule)) ?? null;
}

function relativeSpec(fromDirRel, targetRel, originalSpec, isModule) {
  let target = targetRel;
  if (isModule) {
    const ext = (originalSpec.match(/\.(js|mjs)$/) ?? [''])[0]; // keep '.js' / '.mjs' / none
    target = target.replace(/\.(ts|tsx|js|mjs)$/, '');
    // A folder index target is written as the folder unless the original spelled out "index".
    // With an extension the index must stay spelled out ('…/engine/index.js', not '…/engine.js').
    if (!ext && /\/index$/.test(target) && !/(^|\/)index$/.test(originalSpec)) target = target.replace(/\/index$/, '');
    target += ext;
  }
  let rel = path.posix.relative(fromDirRel, target);
  if (rel === '') rel = '.';
  else if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

const MODULE_PATTERNS = [
  /(\bfrom\s+)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g,
  /(\bimport\s*\(\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g,
  /(\brequire\s*\(\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g,
  // optional type argument: vi.importActual<typeof import('…')>('…')
  /(\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^;]*?>)?\s*\(\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g,
  /(^\s*import\s+)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/gm,
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
const ambiguous = [];
for (const root of roots) {
  for (const fileRel of walk(norm(root), [])) {
    const originalRel = backward.get(fileRel) ?? fileRel;
    const oldDir = path.posix.dirname(originalRel);
    const newDir = path.posix.dirname(fileRel);
    const src = fs.readFileSync(abs(fileRel), 'utf8');
    // A file moved by this run is known to hold pre-move specifiers: the old meaning wins outright.
    const preMove = movedNow.has(fileRel);
    let out = src;
    const rewrite = (pattern, isModule) => {
      out = out.replace(pattern, (whole, pre, q, spec) => {
        if (!isModule && spec.startsWith('/')) return whole;
        const original = resolveOriginal(oldDir, spec, isModule);
        const current = preMove ? null : resolveCurrent(newDir, spec, isModule);
        const intended = original ? (forward.get(original) ?? original) : null;
        if (current && (!intended || intended === current)) return whole; // correct, or fixed by an earlier run
        // Points at a file that only exists because of the moves: written after the move (an earlier run
        // or new code on the moved layout) — already right.
        if (current && backward.has(current)) return whole;
        if (current && intended && intended !== current) {
          // Before the move it meant one existing file, now it resolves to another one that was already
          // there (e.g. a moved file's './config' now lands on a sibling config.ts) — that cannot be
          // decided from the tree alone: report and leave it for a person.
          ambiguous.push(`${fileRel}: '${spec}' → now ${current}, before the move ${intended}`);
          return whole;
        }
        if (!intended) {
          if (isModule || oldDir !== newDir) unresolved.push(`${fileRel}: ${spec}`);
          return whole;
        }
        const moved = intended;
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
if (ambiguous.length > 0) {
  console.log(`AMBIGUOUS — fix by hand (${ambiguous.length}):`);
  for (const a of ambiguous) console.log(`  ${a}`);
  process.exitCode = 1;
}

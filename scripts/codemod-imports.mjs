#!/usr/bin/env node
// Rewrite relative module paths after files move (S6 P1-33 — server/src/stats*.ts → server/src/stats/**).
//
//   node scripts/codemod-imports.mjs <moves.json> [--apply-moves | --write-record] [--root <dir>]...
//
// moves.json maps repo-relative old paths to new paths. With --apply-moves the files are moved first
// (`git mv`). Then every .ts/.tsx/.js/.mjs file under the roots (default: server/src) is rewritten:
//   - import/export … from '…', import('…'), require('…'), typeof import('…'), bare '.' / '..'
//   - vi.mock / doMock / unmock / doUnmock / importActual<…>(…) / importMock
//   - path.resolve(__dirname, '…') / path.join(__dirname, '…') and toMatchFileSnapshot('…')
// A specifier is resolved from the file's ORIGINAL location (its old path when the file itself moved),
// mapped through moves.json if its target moved, and written relative to the file's current location.
// Extension style ('.js', '.mjs' or none) is kept; a folder index is written as the folder only when
// that shorter path really resolves to the index (not to a same-named file next to the folder).
//
// Record file: <moves>.applied.json lists, per moved file, the relative paths it holds after a run —
// paths the codemod wrote or verified for the moved layout. A later run (a rerun, or a feature branch
// rebased onto the move) trusts exactly those. Any other path in a moved file is judged by its meaning:
// unresolvable now but resolvable from the old location → rewritten; resolvable both ways to different
// files → AMBIGUOUS (reported, exit 1, left for a person). --write-record records an already-moved tree
// (every relative path in the moved files must resolve now). Commit the record next to the map.
//
// The roadmap's "move conflict" note points here: keep the moves.json of each move PR in scripts/moves/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const isRootValue = (a, i) => i > 0 && args[i - 1] === '--root';
const mapFile = args.find((a, i) => !a.startsWith('--') && !isRootValue(a, i));
if (!mapFile) {
  console.error('usage: codemod-imports.mjs <moves.json> [--apply-moves | --write-record] [--root <dir>]...');
  process.exit(2);
}
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// Repo-relative paths in one form everywhere (map keys, roots, walked files): '/' separators, no
// leading './', no repeated or trailing '/' — so '--root ./src' and '--root src' behave the same.
const clean = (p) => path.posix.normalize(p.split(path.sep).join('/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const roots = [];
args.forEach((a, i) => { if (a === '--root') roots.push(clean(args[i + 1])); });
if (roots.length === 0) roots.push('server/src');
const writeRecordOnly = args.includes('--write-record');

const moves = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const recordFile = mapFile.replace(/\.json$/, '') + '.applied.json';
const record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : {};
const norm = (p) => p.split(path.sep).join('/');
const abs = (p) => path.join(repo, p);
const forward = new Map(Object.entries(moves).map(([a, b]) => [clean(a), clean(b)]));
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

// B: what the specifier points at now, from the file's current directory (resolution order as the
// module loader: the exact name, name + extension, then the folder index).
function resolveCurrent(dirRel, spec, isModule) {
  return candidates(dirRel, spec, isModule).find((p) => isTarget(p, isModule)) ?? null;
}

function relativeSpec(fromDirRel, targetRel, originalSpec, isModule, keepIndex) {
  let target = targetRel;
  if (isModule) {
    const ext = (originalSpec.match(/\.(js|mjs)$/) ?? [''])[0]; // keep '.js' / '.mjs' / none
    target = target.replace(/\.(ts|tsx|js|mjs)$/, '');
    // A folder index is written as the folder unless the original spelled out "index", an extension is
    // kept ('…/engine/index.js', not '…/engine.js'), or the shorter path would hit a same-named file.
    if (!keepIndex && !ext && /\/index$/.test(target) && !/(^|\/)index$/.test(originalSpec)) target = target.replace(/\/index$/, '');
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
const recordKey = (spec, isModule) => `${isModule ? 'm' : 'p'}:${spec}`;
// Occurrence count of each relative path in a file: the record keeps counts, so a rebased branch that
// adds another import with the same text as a recorded one gets that extra occurrence checked again.
function relativeSpecCounts(src) {
  const out = {};
  const add = (k) => { out[k] = (out[k] ?? 0) + 1; };
  for (const p of MODULE_PATTERNS) for (const m of src.matchAll(p)) add(recordKey(m[3], true));
  for (const p of PLAIN_PATTERNS) for (const m of src.matchAll(p)) if (!m[3].startsWith('/')) add(recordKey(m[3], false));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

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
const files = roots.flatMap((r) => walk(r, [])).map(clean);

if (writeRecordOnly) {
  const broken = [];
  for (const fileRel of files) {
    if (!backward.has(fileRel)) continue;
    const specs = relativeSpecCounts(fs.readFileSync(abs(fileRel), 'utf8'));
    const dir = path.posix.dirname(fileRel);
    for (const k of Object.keys(specs)) {
      const isModule = k.startsWith('m:');
      if (!resolveCurrent(dir, k.slice(2), isModule)) broken.push(`${fileRel}: ${k.slice(2)}`);
    }
    record[fileRel] = specs;
  }
  if (broken.length > 0) {
    console.error(`--write-record: these paths do not resolve, fix them first (${broken.length}):`);
    for (const b of broken) console.error(`  ${b}`);
    process.exit(1);
  }
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 1) + '\n');
  console.log(`codemod-imports: recorded ${Object.keys(record).length} moved file(s) in ${norm(path.relative(repo, path.resolve(recordFile)))}`);
  process.exit(0);
}

let recordChanged = false;
for (const fileRel of files) {
  const originalRel = backward.get(fileRel) ?? fileRel;
  const oldDir = path.posix.dirname(originalRel);
  const newDir = path.posix.dirname(fileRel);
  const src = fs.readFileSync(abs(fileRel), 'utf8');
  // A file moved by this run is known to hold pre-move specifiers: the old meaning wins outright.
  const preMove = movedNow.has(fileRel);
  const trusted = preMove ? {} : (record[fileRel] ?? {});
  const seen = {}; // occurrences met so far per path — those beyond the recorded count are new
  const leftOpen = {}; // occurrences reported as ambiguous/unresolved — not recorded as verified
  const open = (k) => { leftOpen[k] = (leftOpen[k] ?? 0) + 1; };
  let out = src;
  const rewrite = (pattern, isModule) => {
    out = out.replace(pattern, (whole, pre, q, spec) => {
      if (!isModule && spec.startsWith('/')) return whole;
      const key = recordKey(spec, isModule);
      seen[key] = (seen[key] ?? 0) + 1;
      if (seen[key] <= (trusted[key] ?? 0)) return whole; // written/verified for the moved layout
      const original = resolveOriginal(oldDir, spec, isModule);
      const current = preMove ? null : resolveCurrent(newDir, spec, isModule);
      const intended = original ? (forward.get(original) ?? original) : null;
      if (current && (!intended || intended === current)) return whole; // already right
      if (current && intended && intended !== current) {
        // Before the move it meant one file, now it resolves to another (e.g. a moved file's './config'
        // now lands on a sibling config.ts, moved in or not) — cannot be decided from the tree: report.
        ambiguous.push(`${fileRel}: '${spec}' → now ${current}, before the move ${intended}`);
        open(key);
        return whole;
      }
      if (!intended) {
        if (isModule || oldDir !== newDir) unresolved.push(`${fileRel}: ${spec}`);
        open(key);
        return whole;
      }
      let next = relativeSpec(newDir, intended, spec, isModule, false);
      if (isModule && isFile(intended) && resolveCurrent(newDir, next, true) !== intended) {
        // e.g. './lib' would load an existing lib.ts instead of the moved lib/index.ts — keep the index.
        next = relativeSpec(newDir, intended, spec, isModule, true);
        if (resolveCurrent(newDir, next, true) !== intended) {
          ambiguous.push(`${fileRel}: '${spec}' → no relative path reaches ${intended} unambiguously`);
          open(key);
          return whole;
        }
      }
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
  if (backward.has(fileRel)) {
    const verified = Object.fromEntries(Object.entries(relativeSpecCounts(out))
      .map(([k, n]) => [k, n - (leftOpen[k] ?? 0)]).filter(([, n]) => n > 0));
    if (JSON.stringify(record[fileRel] ?? null) !== JSON.stringify(verified)) {
      record[fileRel] = verified;
      recordChanged = true;
    }
  }
}
if (recordChanged) fs.writeFileSync(recordFile, JSON.stringify(record, null, 1) + '\n');

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

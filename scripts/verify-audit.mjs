#!/usr/bin/env node
/**
 * scripts/verify-audit.mjs — production-dependency vulnerability gate (REFACTORING_ROADMAP, 보안 훅 / D9).
 *
 * Runs `npm audit --omit=dev --json` once for the whole npm-workspaces tree (one lockfile, P0-7 W3)
 * and attributes each advisory to a workspace only when one of the advisory's vulnerable install
 * locations (`nodes`, e.g. `node_modules/tar`, `server/node_modules/x`) is reachable from that
 * workspace through production dependencies in package-lock.json — "root" (client + Electron:
 * package.json dependencies) and "server" (server/package.json dependencies, following workspace
 * links). Install locations, not package names: the same package can be installed in two versions,
 * one safe and one vulnerable. npm's own `--workspace` filter cannot isolate the root (every
 * workspace is linked under it), and `npm ls --json` omits the children of deduplicated nodes.
 * Each workspace's advisories are compared with scripts/audit-allowlist.json
 * (advisories that were reviewed and judged not applicable / covered by a decision / deferred).
 *   - high or critical advisory not in the allow list → FAIL (new, unreviewed risk)
 *   - moderate or low advisory not in the allow list   → warning only
 *   - allow-listed advisory no longer reported          → note (remove it from the list)
 *   - npm audit cannot reach the registry / bad output  → FAIL (never pass silently)
 *
 * Run by `npm run check:full`; standalone: `node scripts/verify-audit.mjs`.
 * Needs network access to the npm registry (the development PC, not the air-gapped server).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Workspace name → its location (package-lock.json `packages` key) where production traversal starts.
const WORKSPACES = { root: '', server: 'server' };
const BLOCKING = new Set(['high', 'critical']);

// Does `version` (x.y.z[-pre]) fall in an advisory `range` as npm audit reports it — comparator sets
// joined by `||`, each a space-separated AND of `<`, `<=`, `>`, `>=`, `=` (or bare) x.y.z bounds, or `*`?
// Returns null when either side cannot be parsed — including any prerelease version or bound, whose
// SemVer ordering (identifier-wise, numeric parts as numbers) this small comparator does not implement —
// so the caller keeps the location (unknown = vulnerable) instead of wrongly dropping it.
export function versionInRange(version, range) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  const v = parse(version);
  if (!v || typeof range !== 'string' || range.trim() === '') return null;
  let anyParsed = false;
  for (const set of range.split('||')) {
    const parts = set.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    let ok = true;
    for (const part of parts) {
      if (part === '*') continue;
      const m = /^(<=|>=|<|>|=)?(.+)$/.exec(part);
      const bound = m && parse(m[2]);
      if (!bound) return null;
      const c = cmp(v, bound);
      const op = m[1] || '=';
      const pass = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
      if (!pass) ok = false;
    }
    anyParsed = true;
    if (ok) return true;
  }
  return anyParsed ? false : null;
}

// Advisories reported by one `npm audit --json` result: [{ package, id, severity, title, nodes }].
// `nodes` are the install locations (package-lock.json keys) vulnerable to THIS advisory: npm audit's
// per-package `nodes` is the union over all of that package's advisories, so when a lockfile is given
// each location is kept only if its installed version is in the advisory's `range` (a location whose
// version or range cannot be read stays — unknown counts as vulnerable).
export function advisoriesFrom(auditJson, lock = null) {
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlainObject(auditJson) || auditJson.error || !isPlainObject(auditJson.vulnerabilities)) {
    const why = auditJson?.error?.summary || auditJson?.error?.code || '"vulnerabilities" is missing or not an object';
    throw new Error(`npm audit did not return a usable report (${why}).`);
  }
  const out = [];
  for (const [pkg, vuln] of Object.entries(auditJson.vulnerabilities)) {
    if (!isPlainObject(vuln) || !Array.isArray(vuln.via) || !Array.isArray(vuln.nodes)) {
      throw new Error(`npm audit did not return a usable report (entry "${pkg}" has no "via"/"nodes" list).`);
    }
    for (const via of vuln.via) {
      if (typeof via !== 'object' || !via.url) continue; // string = inherited from another package
      const nodes = lock
        ? vuln.nodes.filter((node) => versionInRange(lock.packages?.[node]?.version, via.range) !== false)
        : vuln.nodes;
      out.push({ package: pkg, id: via.url.split('/').pop(), severity: via.severity, title: via.title, nodes });
    }
  }
  return out;
}

// Node's module resolution walks up from the requiring location: <loc>/node_modules/<name>, then the
// parent package's location, … up to the root's node_modules. Parent of "node_modules/a/node_modules/b"
// is "node_modules/a"; of "node_modules/a" or "node_modules/@s/a" is ""; of a workspace "server" is "".
function parentLocation(loc) {
  const i = loc.lastIndexOf('/node_modules/');
  if (i !== -1) return loc.slice(0, i);
  if (loc === '' || loc.startsWith('node_modules/')) return '';
  const j = loc.lastIndexOf('/');
  return j === -1 ? '' : loc.slice(0, j);
}

function resolveLocation(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (base === '') return null;
    base = parentLocation(base);
  }
}

// package-lock.json → set of install locations reachable from `start` through production
// dependencies (dependencies + optionalDependencies + peerDependencies; never devDependencies),
// following workspace links (`link: true` → `resolved`). Missing optional/peer targets are skipped.
export function reachableLocations(lock, start) {
  const packages = lock?.packages || {};
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const loc = stack.pop();
    if (seen.has(loc)) continue;
    seen.add(loc);
    const entry = packages[loc];
    if (!entry) continue;
    if (entry.link) {
      if (typeof entry.resolved === 'string') stack.push(entry.resolved);
      continue;
    }
    const names = new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
      ...Object.keys(entry.peerDependencies || {}),
    ]);
    for (const name of names) {
      const target = resolveLocation(packages, loc, name);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

// Advisories with at least one vulnerable install location inside the workspace's production tree.
export function advisoriesFor(reachable, advisories) {
  return advisories.filter((a) => a.nodes.some((node) => reachable.has(node)));
}

// Compare one workspace's advisories with the allow list.
export function evaluate(workspace, advisories, allowlist) {
  const allowed = new Set();
  for (const entry of allowlist.entries || []) {
    if (entry.workspace !== workspace) continue;
    for (const id of entry.advisories || []) allowed.add(`${entry.package}|${id}`);
  }
  const reported = new Set(advisories.map((a) => `${a.package}|${a.id}`));
  const unreviewed = advisories.filter((a) => !allowed.has(`${a.package}|${a.id}`));
  return {
    failures: unreviewed.filter((a) => BLOCKING.has(a.severity)),
    warnings: unreviewed.filter((a) => !BLOCKING.has(a.severity)),
    stale: [...allowed].filter((key) => !reported.has(key)),
  };
}

function runAudit() {
  const res = spawnSync('npm audit --omit=dev --json', { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // npm audit exits 1 when it finds vulnerabilities, so judge by the JSON, not the exit code.
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`npm audit produced no JSON (exit ${res.status}). ${String(res.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  }
}

function main() {
  const allowlist = JSON.parse(readFileSync(path.join(root, 'scripts', 'audit-allowlist.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  let failed = false;
  let advisories;
  try {
    advisories = advisoriesFrom(runAudit(), lock);
  } catch (err) {
    console.error(`verify-audit: ${err.message}`);
    process.exit(1);
  }
  const reach = Object.fromEntries(Object.entries(WORKSPACES).map(([ws, start]) => [ws, reachableLocations(lock, start)]));
  const unattributed = advisories.filter((a) => !Object.values(reach).some((set) => a.nodes.some((n) => set.has(n))));
  for (const a of unattributed) {
    console.error(`verify-audit: ${a.package} ${a.id} (${a.nodes.join(', ')}) is not reachable from any workspace's production dependencies — cannot attribute it`);
    failed = true;
  }
  for (const workspace of Object.keys(WORKSPACES)) {
    const result = evaluate(workspace, advisoriesFor(reach[workspace], advisories), allowlist);
    for (const a of result.failures) {
      console.error(`verify-audit [${workspace}]: UNREVIEWED ${a.severity} ${a.package} ${a.id} — ${a.title}`);
    }
    for (const a of result.warnings) {
      console.warn(`verify-audit [${workspace}]: (warning) unreviewed ${a.severity} ${a.package} ${a.id} — ${a.title}`);
    }
    for (const key of result.stale) {
      console.log(`verify-audit [${workspace}]: no longer reported, remove from the allow list: ${key.replace('|', ' ')}`);
    }
    if (result.failures.length) failed = true;
    else console.log(`verify-audit [${workspace}]: no unreviewed high/critical advisories.`);
  }
  if (failed) {
    console.error('\nReview each new advisory: upgrade, or add it to scripts/audit-allowlist.json with the reason it does not apply.');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

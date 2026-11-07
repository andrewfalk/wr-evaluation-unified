#!/usr/bin/env node
/**
 * scripts/verify-audit.mjs — production-dependency vulnerability gate (REFACTORING_ROADMAP, 보안 훅 / D9).
 *
 * Runs `npm audit --omit=dev --json` once for the whole npm-workspaces tree (one lockfile, P0-7 W3)
 * and attributes each advisory to the workspace(s) whose production dependency tree contains the
 * package — "server" (anything reached through @wr/server) and "root" (client + Electron: everything
 * else). npm's own `--workspace` filter cannot isolate the root, because every workspace is linked
 * under the root. Each workspace's advisories are compared with scripts/audit-allowlist.json
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
const WORKSPACES = ['root', 'server'];
const SERVER_PACKAGE = '@wr/server';
const BLOCKING = new Set(['high', 'critical']);

// Advisories reported by one `npm audit --json` result: [{ package, id, severity, title }].
export function advisoriesFrom(auditJson) {
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlainObject(auditJson) || auditJson.error || !isPlainObject(auditJson.vulnerabilities)) {
    const why = auditJson?.error?.summary || auditJson?.error?.code || '"vulnerabilities" is missing or not an object';
    throw new Error(`npm audit did not return a usable report (${why}).`);
  }
  const out = [];
  for (const [pkg, vuln] of Object.entries(auditJson.vulnerabilities)) {
    if (!isPlainObject(vuln) || !Array.isArray(vuln.via)) {
      throw new Error(`npm audit did not return a usable report (entry "${pkg}" has no "via" list).`);
    }
    for (const via of vuln.via) {
      if (typeof via !== 'object' || !via.url) continue; // string = inherited from another package
      out.push({ package: pkg, id: via.url.split('/').pop(), severity: via.severity, title: via.title });
    }
  }
  return out;
}

// `npm ls --all --omit=dev --json` tree → Map(package name → Set of owning workspaces).
// Anything under the @wr/server node belongs to "server"; every other production node to "root".
// Workspace link nodes themselves (@wr/*) are not packages that npm audit reports, so they are skipped.
export function ownersFrom(lsJson) {
  const owners = new Map();
  const add = (name, ws) => {
    if (!owners.has(name)) owners.set(name, new Set());
    owners.get(name).add(ws);
  };
  const walk = (deps, ws) => {
    for (const [name, node] of Object.entries(deps || {})) {
      if (!node || typeof node !== 'object') continue;
      const owner = name === SERVER_PACKAGE ? 'server' : ws;
      if (!name.startsWith('@wr/')) add(name, owner);
      walk(node.dependencies, owner);
    }
  };
  walk(lsJson?.dependencies, 'root');
  return owners;
}

// Advisories whose package appears in the given workspace's production tree.
export function advisoriesFor(workspace, advisories, owners) {
  return advisories.filter((a) => owners.get(a.package)?.has(workspace));
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

function runLs() {
  // npm ls exits non-zero for extraneous/missing packages but still prints the tree.
  const res = spawnSync('npm ls --all --omit=dev --json', { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`npm ls produced no JSON (exit ${res.status}). ${String(res.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  }
}

function main() {
  const allowlist = JSON.parse(readFileSync(path.join(root, 'scripts', 'audit-allowlist.json'), 'utf8'));
  let failed = false;
  let advisories;
  let owners;
  try {
    advisories = advisoriesFrom(runAudit());
    owners = ownersFrom(runLs());
  } catch (err) {
    console.error(`verify-audit: ${err.message}`);
    process.exit(1);
  }
  const unattributed = advisories.filter((a) => !owners.has(a.package));
  for (const a of unattributed) {
    console.error(`verify-audit: ${a.package} ${a.id} is reported but not found in any production tree — cannot attribute it`);
    failed = true;
  }
  for (const workspace of WORKSPACES) {
    const result = evaluate(workspace, advisoriesFor(workspace, advisories, owners), allowlist);
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

#!/usr/bin/env node
/**
 * scripts/verify-audit.mjs — production-dependency vulnerability gate (REFACTORING_ROADMAP, 보안 훅 / D9).
 *
 * Runs `npm audit --omit=dev --json` for the repository root (client + Electron) and server/,
 * and compares every reported advisory with scripts/audit-allowlist.json (advisories that were
 * reviewed and judged not applicable / covered by a decision / deferred, each with a reason).
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
const WORKSPACES = [['root', root], ['server', path.join(root, 'server')]];
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

function runAudit(cwd) {
  const res = spawnSync('npm audit --omit=dev --json', { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // npm audit exits 1 when it finds vulnerabilities, so judge by the JSON, not the exit code.
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`npm audit produced no JSON (exit ${res.status}). ${String(res.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  }
}

function main() {
  const allowlist = JSON.parse(readFileSync(path.join(root, 'scripts', 'audit-allowlist.json'), 'utf8'));
  let failed = false;
  for (const [workspace, cwd] of WORKSPACES) {
    let result;
    try {
      result = evaluate(workspace, advisoriesFrom(runAudit(cwd)), allowlist);
    } catch (err) {
      console.error(`verify-audit [${workspace}]: ${err.message}`);
      failed = true;
      continue;
    }
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

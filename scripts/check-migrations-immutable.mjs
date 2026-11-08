#!/usr/bin/env node
// Applied migrations are immutable (REFACTORING_ROADMAP S10 / P1-36). A branch may add new files
// under server/migrations/, but must not edit, delete or rename one that main already has — the
// server compares the checksum of every applied file at start-up (server/src/db/migrate.ts), so
// an edit would warn (7.2.0) or stop the server (enforce, from 7.3.0) on every database that
// already ran it. Change the schema with a new migration instead.
//
//   node scripts/check-migrations-immutable.mjs [--base <ref>]     (default: origin/main)
//
// Compares the merge base with <ref> against the working tree, so committed and uncommitted
// changes are both caught. Renames are reported as a delete plus an add. Skipped on main itself
// (there is no branch to compare). Run by `npm run check`.
import { execFileSync } from 'node:child_process';

const MIGRATIONS = 'server/migrations/*.sql';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function parseArgs(argv) {
  let base = 'origin/main';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base' && argv[i + 1]) {
      base = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { base };
}

function main() {
  const { base } = parseArgs(process.argv.slice(2));
  const branch = git(['branch', '--show-current']);
  if (branch === 'main') {
    console.log('check-migrations-immutable: on main — skipped (nothing to compare against).');
    return 0;
  }
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    console.error(`check-migrations-immutable: base "${base}" not found — run \`git fetch origin main\` or pass --base <ref>.`);
    return 1;
  }
  const mergeBase = git(['merge-base', base, 'HEAD']);
  const out = git(['diff', '--name-status', '--no-renames', mergeBase, '--', MIGRATIONS]);
  const changes = out ? out.split('\n').map((line) => line.split('\t')) : [];
  const violations = changes.filter(([status]) => status !== 'A');
  if (violations.length === 0) {
    const added = changes.length;
    console.log(`check-migrations-immutable: OK (${added} new migration file(s) since ${base}, none changed).`);
    return 0;
  }
  console.error(`check-migrations-immutable: migration files that ${base} already has were changed:`);
  for (const [status, file] of violations) {
    console.error(`  ${status === 'D' ? 'deleted ' : 'modified'}  ${file}`);
  }
  console.error('Applied migrations must not change — restore them and add a new migration instead.');
  return 1;
}

process.exitCode = main();

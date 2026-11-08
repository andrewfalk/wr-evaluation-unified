// scripts/check-migrations-immutable.mjs (S10 P1-36). Each case builds a throw-away git repository
// with a `main` holding one migration, then checks a branch against it.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, 'check-migrations-immutable.mjs');
const dirs = [];

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

// A repository on a feature branch off `main`, which has 0001 applied.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-immutable-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, 'server/migrations/0001_init.sql', 'CREATE TABLE a (id int);\n');
  write(dir, 'server/migrations/README.md', 'notes\n');
  commitAll(dir, 'init');
  git(dir, 'checkout', '-q', '-b', 'feature');
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--base', 'main', ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('check-migrations-immutable', () => {
  it('passes when the branch only adds migrations', () => {
    const dir = repo();
    write(dir, 'server/migrations/0002_next.sql', 'CREATE TABLE b (id int);\n');
    commitAll(dir, 'add 0002');
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 new migration file(s)');
  });

  it('fails when a committed change edits a migration main already has', () => {
    const dir = repo();
    write(dir, 'server/migrations/0001_init.sql', 'CREATE TABLE a (id int, x int);\n');
    commitAll(dir, 'edit 0001');
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/modified\s+server\/migrations\/0001_init\.sql/);
  });

  it('fails on an uncommitted edit too', () => {
    const dir = repo();
    write(dir, 'server/migrations/0001_init.sql', 'CREATE TABLE a (id bigint);\n');
    expect(run(dir).code).toBe(1);
  });

  it('fails when a migration is deleted', () => {
    const dir = repo();
    git(dir, 'rm', '-q', 'server/migrations/0001_init.sql');
    git(dir, 'commit', '-q', '-m', 'delete 0001');
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deleted\s+server\/migrations\/0001_init\.sql/);
  });

  it('fails when a migration is renamed (reported as a delete)', () => {
    const dir = repo();
    git(dir, 'mv', 'server/migrations/0001_init.sql', 'server/migrations/0001_renamed.sql');
    git(dir, 'commit', '-q', '-m', 'rename 0001');
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deleted\s+server\/migrations\/0001_init\.sql/);
  });

  it('ignores files in the folder that are not migrations', () => {
    const dir = repo();
    write(dir, 'server/migrations/README.md', 'more notes\n');
    commitAll(dir, 'edit readme');
    expect(run(dir).code).toBe(0);
  });

  it('compares against the merge base, so migrations main adds later are not reported', () => {
    const dir = repo();
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'server/migrations/0002_main.sql', 'CREATE TABLE m (id int);\n');
    commitAll(dir, 'main adds 0002');
    git(dir, 'checkout', '-q', 'feature');
    expect(run(dir).code).toBe(0);
  });

  it('skips on main', () => {
    const dir = repo();
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'server/migrations/0001_init.sql', 'edited\n');
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('skipped');
  });

  it('fails clearly when the base ref does not exist', () => {
    const dir = repo();
    const r = spawnSync(process.execPath, [SCRIPT, '--base', 'origin/nope'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('base "origin/nope" not found');
  });
});

// No new local test doubles (REFACTORING_ROADMAP S3 / P1-14). Server tests use the shared harness in
// src/testing/ — createFakePool, makeRouterApp, testConfig, makeAccessToken — instead of each file
// defining its own `makePool` / `makeApp` or a hand-written config mock. This test fails when a test
// file adds one back.
//
// ALLOWED: the S7 targets. S7 changes the SQL order of these routes and replaces their order-based
// unit tests with real-database integration tests, so they are not migrated (Phase 1 plan §3).
// When S7 migrates one, remove it here — an entry whose file no longer has a local double fails too.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const SELF = 'testing/__tests__/noLocalHarness.test.ts'; // its detector examples would match

const ALLOWED = new Set([
  'routes/__tests__/patients.test.ts',
  'routes/__tests__/videoAnalysis.test.ts',
  'routes/__tests__/workspaces.test.ts',
]);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Local doubles found in a test file's source (empty = uses the shared harness). */
export function localDoubles(source: string): string[] {
  const found: string[] = [];
  if (/\bfunction\s+makePool\s*\(/.test(source)) found.push('function makePool');
  if (/\bfunction\s+makeApp\s*\(/.test(source)) found.push('function makeApp');
  // A vi.mock / vi.doMock of the config module whose factory neither builds it with testConfig() nor
  // wraps the real config (importOriginal — integration tests that override one value of it).
  const configMock = /vi\.(?:mock|doMock)\(\s*['"](?:\.\.?\/)+config(?:\.js)?['"]\s*,/g;
  for (const m of source.matchAll(configMock)) {
    const factory = source.slice(m.index! + m[0].length, m.index! + m[0].length + 300);
    if (!/testConfig\(|importOriginal/.test(factory)) found.push(`hand-written config mock (${m[0].trim()})`);
  }
  return found;
}

describe('no local test harness (S3 / P1-14)', () => {
  const files = testFiles(SRC)
    .map((full) => ({ full, rel: path.relative(SRC, full).split(path.sep).join('/') }))
    .filter((f) => f.rel !== SELF)
    .map((f) => ({ rel: f.rel, doubles: localDoubles(fs.readFileSync(f.full, 'utf8')) }));

  it('test files outside the S7 list use the shared harness (src/testing/)', () => {
    const offenders = files
      .filter((f) => f.doubles.length > 0 && !ALLOWED.has(f.rel))
      .map((f) => `${f.rel}: ${f.doubles.join(', ')}`);
    expect(offenders, 'use createFakePool / makeRouterApp / testConfig from src/testing/ instead').toEqual([]);
  });

  it('every allowed S7 file still has a local double (remove it from ALLOWED once migrated)', () => {
    const stale = [...ALLOWED].filter((rel) => !files.some((f) => f.rel === rel && f.doubles.length > 0));
    expect(stale).toEqual([]);
  });

  it('the detector recognises each kind of local double and the harness forms', () => {
    expect(localDoubles('function makePool(): Pool {}')).toEqual(['function makePool']);
    expect(localDoubles('function makeApp(pool: Pool) {}')).toEqual(['function makeApp']);
    expect(localDoubles("vi.mock('../../config', () => ({ default: { env: 'test' } }));")).toHaveLength(1);
    expect(localDoubles("vi.doMock('../config', () => ({ default: {} }));")).toHaveLength(1);
    expect(localDoubles(
      "vi.mock('../../config', async () => ({ default: (await import('../../testing/configMock.js')).testConfig({}) }));",
    )).toEqual([]);
    expect(localDoubles("vi.doMock('../../config', () => ({ default: testConfig({ env: 'development' }) }));")).toEqual([]);
    expect(localDoubles("vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn() }));")).toEqual([]);
    expect(localDoubles(
      "vi.mock('../config', async (importOriginal) => { const a = await importOriginal(); return { ...a }; });",
    )).toEqual([]);
  });
});

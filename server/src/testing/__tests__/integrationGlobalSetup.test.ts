// The dedicated-test-database guard of the integration test setup (REFACTORING_ROADMAP P0-10).
import { describe, expect, it } from 'vitest';
import { assertDedicatedTestDatabase, testDatabaseName } from '../integrationGlobalSetup';

describe('integration setup — dedicated test database guard', () => {
  it('accepts databases whose name starts with wr_test', () => {
    expect(() => assertDedicatedTestDatabase('postgres://u:p@127.0.0.1:5432/wr_test')).not.toThrow();
    expect(() => assertDedicatedTestDatabase('postgresql://u:p@localhost/wr_test_hf1')).not.toThrow();
  });

  it('refuses the development/production database', () => {
    expect(() => assertDedicatedTestDatabase('postgres://u:p@localhost:5432/wr_evaluation')).toThrow(/"wr_evaluation"/);
  });

  it('refuses socket URLs whose db parameter is not a test database (Codex review of #192)', () => {
    // pg reads the database from ?db= here; the path is the socket directory.
    expect(() => assertDedicatedTestDatabase('socket:/wr_test?db=wr_evaluation')).toThrow(/postgres:\/\/ or postgresql:\/\//);
  });

  it('uses the name pg will connect to, not the raw URL path', () => {
    expect(testDatabaseName('postgresql://u@h/wr_test%5Fx')).toBe('wr_test_x');
  });

  it('with no database in the URL, checks the name pg falls back to (PGDATABASE)', () => {
    // Pin PGDATABASE so the result does not depend on the shell running the tests (Codex review of #192).
    const saved = process.env.PGDATABASE;
    try {
      process.env.PGDATABASE = 'wr_evaluation';
      expect(() => assertDedicatedTestDatabase('postgres://someone:p@h:5432')).toThrow(/"wr_evaluation"/);
      process.env.PGDATABASE = 'wr_test';
      expect(() => assertDedicatedTestDatabase('postgres://someone:p@h:5432')).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE;
      else process.env.PGDATABASE = saved;
    }
  });

  it('rejects malformed URLs', () => {
    expect(() => testDatabaseName('not a url')).toThrow(/not a valid URL/);
  });
});

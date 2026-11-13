// The dedicated-test-database guard of the integration test setup (REFACTORING_ROADMAP P0-10).
import { describe, expect, it } from 'vitest';
import { assertDedicatedTestDatabase, readIntegrationUrls, testDatabaseName } from '../integrationGlobalSetup';

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

describe('integration setup — role URLs (M9)', () => {
  const app = 'postgres://wr_app:p@h/wr_test';
  const admin = 'postgres://wr_user:p@h/wr_test';
  const owner = 'postgres://wr_owner:p@h/wr_test';
  const audit = 'postgres://wr_audit_reader:p@h/wr_test';

  it('no URL: null (the files skip)', () => {
    expect(readIntegrationUrls({})).toBeNull();
  });

  it('TEST_DATABASE_URL alone: single-URL mode', () => {
    expect(readIntegrationUrls({ TEST_DATABASE_URL: app })).toEqual({ app, admin: null, owner: null, audit: null });
  });

  it('all four: role-separated mode', () => {
    expect(readIntegrationUrls({
      TEST_DATABASE_URL: app, TEST_ADMIN_DATABASE_URL: admin, TEST_OWNER_DATABASE_URL: owner, TEST_AUDIT_DATABASE_URL: audit,
    })).toEqual({ app, admin, owner, audit });
  });

  it('a partial set is an error, not a silent fallback', () => {
    expect(() => readIntegrationUrls({ TEST_DATABASE_URL: app, TEST_ADMIN_DATABASE_URL: admin })).toThrow(/together/);
    expect(() => readIntegrationUrls({ TEST_ADMIN_DATABASE_URL: admin, TEST_OWNER_DATABASE_URL: owner, TEST_AUDIT_DATABASE_URL: audit }))
      .toThrow(/TEST_DATABASE_URL/);
  });

  it('names the variable when a role URL is not a test database', () => {
    expect(() => assertDedicatedTestDatabase('postgres://wr_owner:p@h/wr_evaluation', 'TEST_OWNER_DATABASE_URL'))
      .toThrow(/^TEST_OWNER_DATABASE_URL points at database "wr_evaluation"/);
  });
});

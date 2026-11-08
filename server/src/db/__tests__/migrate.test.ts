// Migration checksum helpers (REFACTORING_ROADMAP S10 / P1-36). The runner itself is exercised
// against a real database in migrate.integration.test.ts.
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { migrationChecksum, resolveChecksumMode, MigrationChecksumError } from '../migrate';

describe('resolveChecksumMode', () => {
  it('defaults to enforce when unset or blank', () => {
    expect(resolveChecksumMode(undefined)).toBe('enforce');
    expect(resolveChecksumMode('')).toBe('enforce');
    expect(resolveChecksumMode('  ')).toBe('enforce');
  });

  it('accepts warn and enforce (surrounding spaces ignored)', () => {
    expect(resolveChecksumMode('warn')).toBe('warn');
    expect(resolveChecksumMode(' enforce ')).toBe('enforce');
  });

  it('rejects any other value instead of guessing', () => {
    expect(() => resolveChecksumMode('off')).toThrow(/MIGRATION_CHECKSUM_MODE/);
    expect(() => resolveChecksumMode('WARN')).toThrow(/MIGRATION_CHECKSUM_MODE/);
  });
});

describe('migrationChecksum', () => {
  it('is the sha256 hex of the file text', () => {
    const sql = 'CREATE TABLE t (id int);\n';
    expect(migrationChecksum(sql)).toBe(crypto.createHash('sha256').update(sql, 'utf8').digest('hex'));
  });

  it('treats CRLF and LF line endings as the same file', () => {
    expect(migrationChecksum('SELECT 1;\r\nSELECT 2;\r\n')).toBe(migrationChecksum('SELECT 1;\nSELECT 2;\n'));
  });

  it('changes when the SQL changes', () => {
    expect(migrationChecksum('SELECT 1;\n')).not.toBe(migrationChecksum('SELECT 1;\n-- edited\n'));
  });
});

describe('MigrationChecksumError', () => {
  it('names the changed files', () => {
    const err = new MigrationChecksumError(['0005_a.sql', '0007_b.sql']);
    expect(err.filenames).toEqual(['0005_a.sql', '0007_b.sql']);
    expect(err.message).toContain('0005_a.sql, 0007_b.sql');
  });
});

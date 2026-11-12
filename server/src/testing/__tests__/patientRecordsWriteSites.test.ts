// Where patient_records is written (REFACTORING_ROADMAP S7). S7 moves every write path into
// db/patientRecordsRepo.ts one PR at a time; this ratchet fails when a new file starts writing the table
// and when a listed file stops (then remove it from ALLOWED). S7 ends with ALLOWED = the repository.
//
// Scope = the DoD grep: server/src without cli/ (the stats seed CLI is an allowed exception) and
// without __tests__/ (integration fixtures insert rows directly).
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['cli', '__tests__', 'node_modules']);

const ALLOWED = new Set([
  'db/patientRecordsRepo.ts',
  'db/patientIdentityCorrection.ts',
  'routes/patients/assignment.ts',
  'routes/patients/delete.ts',
]);

// Whitespace between the keywords may include newlines (wider than the one-line DoD grep).
export const WRITES_PATIENT_RECORDS = /\b(?:INTO|UPDATE)\s+patient_records\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('patient_records write sites (S7 ratchet)', () => {
  const writers = sourceFiles(SRC)
    .filter((full) => WRITES_PATIENT_RECORDS.test(fs.readFileSync(full, 'utf8')))
    .map((full) => path.relative(SRC, full).split(path.sep).join('/'))
    .sort();

  it('only the listed files write patient_records', () => {
    expect(writers.filter((rel) => !ALLOWED.has(rel)), 'write patient_records through db/patientRecordsRepo.ts').toEqual([]);
  });

  it('every listed file still writes it (remove a file from ALLOWED once its path has moved)', () => {
    expect([...ALLOWED].filter((rel) => !writers.includes(rel))).toEqual([]);
  });

  it('the detector matches INSERT and UPDATE across whitespace, not reads or other tables', () => {
    expect(WRITES_PATIENT_RECORDS.test('INSERT INTO patient_records (id) VALUES ($1)')).toBe(true);
    expect(WRITES_PATIENT_RECORDS.test('UPDATE\n       patient_records SET revision = revision + 1')).toBe(true);
    expect(WRITES_PATIENT_RECORDS.test('SELECT id FROM patient_records WHERE id = $1 FOR UPDATE')).toBe(false);
    expect(WRITES_PATIENT_RECORDS.test('DELETE FROM patient_records WHERE organization_id = $1')).toBe(false);
    expect(WRITES_PATIENT_RECORDS.test('UPDATE patient_records_archive SET x = 1')).toBe(false);
  });
});

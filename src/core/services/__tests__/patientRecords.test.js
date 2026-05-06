import { describe, expect, it } from 'vitest';
import {
  clonePatientRecordForImport,
  isRedactedPatientRecord,
  migratePatientRecord,
  migratePatientRecords,
  touchPatientRecord,
} from '../patientRecords.js';

describe('redacted patient snapshot stubs', () => {
  it('preserves redacted stubs during migration', () => {
    const stub = { id: 'patient-1', redacted: true };

    expect(isRedactedPatientRecord(stub)).toBe(true);
    expect(migratePatientRecord(stub)).toBe(stub);
    expect(migratePatientRecords([stub])).toEqual([stub]);
  });

  it('does not attach metadata, touch state, or clone redacted stubs', () => {
    const stub = { id: 'patient-1', redacted: true };

    expect(touchPatientRecord(stub)).toBe(stub);
    expect(clonePatientRecordForImport(stub)).toBeNull();
  });
});

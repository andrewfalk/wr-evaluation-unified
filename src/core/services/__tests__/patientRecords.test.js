import { describe, expect, it } from 'vitest';
import {
  clonePatientRecordForImport,
  isPatientIdentityPushConflict,
  isRedactedPatientRecord,
  migratePatientRecord,
  migratePatientRecords,
  touchPatientRecord,
} from '../patientRecords.js';

describe('isPatientIdentityPushConflict', () => {
  it('returns true for push + PATIENT_IDENTITY_CONFLICT', () => {
    expect(isPatientIdentityPushConflict({ kind: 'push', code: 'PATIENT_IDENTITY_CONFLICT' })).toBe(true);
  });

  it('returns true for push + PATIENT_PERSON_CONFLICT', () => {
    expect(isPatientIdentityPushConflict({ kind: 'push', code: 'PATIENT_PERSON_CONFLICT' })).toBe(true);
  });

  it('returns false for push + other code', () => {
    expect(isPatientIdentityPushConflict({ kind: 'push', code: 'CONFLICT' })).toBe(false);
  });

  it('returns false for pull kind even with matching code', () => {
    expect(isPatientIdentityPushConflict({ kind: 'pull', code: 'PATIENT_IDENTITY_CONFLICT' })).toBe(false);
  });

  it('returns false for undefined / null conflict', () => {
    expect(isPatientIdentityPushConflict(undefined)).toBe(false);
    expect(isPatientIdentityPushConflict(null)).toBe(false);
  });
});

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

describe('touchPatientRecord conflict transitions', () => {
  it('clears an editable local-only identity push conflict so it can be pushed again', () => {
    const patient = {
      id: 'patient-1',
      phase: 'intake',
      data: { shared: { name: 'Kim', patientNo: 'P002' }, modules: {}, activeModules: [] },
      sync: {
        serverId: null,
        revision: 0,
        syncStatus: 'conflict',
        lastSyncedAt: null,
        conflict: {
          kind: 'push',
          code: 'PATIENT_IDENTITY_CONFLICT',
          message: 'Different birth date',
        },
      },
    };

    const result = touchPatientRecord(patient);

    expect(result.sync.syncStatus).toBe('local-only');
    expect(result.sync.conflict).toBeUndefined();
  });

  it('clears an editable server-backed identity push conflict as dirty', () => {
    const patient = {
      id: 'patient-1',
      phase: 'intake',
      data: { shared: { name: 'Kim', patientNo: 'P002' }, modules: {}, activeModules: [] },
      sync: {
        serverId: 'server-1',
        revision: 3,
        syncStatus: 'conflict',
        lastSyncedAt: null,
        conflict: {
          kind: 'push',
          code: 'PATIENT_PERSON_CONFLICT',
          message: 'Patient number already exists',
        },
      },
    };

    const result = touchPatientRecord(patient);

    expect(result.sync.syncStatus).toBe('dirty');
    expect(result.sync.revision).toBe(3);
    expect(result.sync.conflict).toBeUndefined();
  });

  it('keeps non-identity push conflicts unresolved', () => {
    const patient = {
      id: 'patient-1',
      phase: 'intake',
      data: { shared: { name: 'Kim' }, modules: {}, activeModules: [] },
      sync: {
        serverId: 'server-1',
        revision: 1,
        syncStatus: 'conflict',
        lastSyncedAt: null,
        conflict: { kind: 'push', code: 'CONFLICT', message: 'Revision mismatch' },
      },
    };

    const result = touchPatientRecord(patient);

    expect(result.sync.syncStatus).toBe('conflict');
    expect(result.sync.conflict).toEqual(patient.sync.conflict);
  });

  it('keeps pull conflicts unresolved', () => {
    const patient = {
      id: 'patient-1',
      phase: 'intake',
      data: { shared: { name: 'Kim' }, modules: {}, activeModules: [] },
      sync: {
        serverId: 'server-1',
        revision: 1,
        syncStatus: 'conflict',
        lastSyncedAt: null,
        conflict: { kind: 'pull', code: null, serverRevision: 2 },
      },
    };

    const result = touchPatientRecord(patient);

    expect(result.sync.syncStatus).toBe('conflict');
    expect(result.sync.conflict).toEqual(patient.sync.conflict);
  });
});

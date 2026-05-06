import { describe, expect, it } from 'vitest';
import {
  getMergeInitializationKey,
  shouldWaitForMergeInitialization,
  validateMergedPatientData,
} from '../ConflictResolveModal.jsx';

describe('validateMergedPatientData', () => {
  it('accepts the patient data shape used by conflict merge', () => {
    expect(validateMergedPatientData({
      shared: { name: 'Kim' },
      modules: {},
      activeModules: ['knee'],
    })).toBe('');
  });

  it('rejects non-object merge values', () => {
    expect(validateMergedPatientData(null)).toBe('Merged data must be an object.');
    expect(validateMergedPatientData([])).toBe('Merged data must be an object.');
  });

  it('requires shared, modules, and activeModules string array', () => {
    expect(validateMergedPatientData({
      modules: {},
      activeModules: [],
    })).toBe('Merged data must include shared object.');

    expect(validateMergedPatientData({
      shared: {},
      activeModules: [],
    })).toBe('Merged data must include modules object.');

    expect(validateMergedPatientData({
      shared: {},
      modules: {},
      activeModules: [123],
    })).toBe('Merged data must include activeModules string array.');
  });
});

describe('merge text initialization helpers', () => {
  it('waits while a server version fetch is pending', () => {
    expect(shouldWaitForMergeInitialization({
      canFetchServer: true,
      serverPatient: null,
      serverError: '',
    })).toBe(true);

    expect(shouldWaitForMergeInitialization({
      canFetchServer: true,
      serverPatient: { id: 'server-1' },
      serverError: '',
    })).toBe(false);

    expect(shouldWaitForMergeInitialization({
      canFetchServer: true,
      serverPatient: null,
      serverError: 'Could not load server version.',
    })).toBe(false);
  });

  it('keys initialization by patient, server id, conflict kind, and revision', () => {
    const patient = {
      id: 'local-1',
      sync: { revision: 2 },
    };

    expect(getMergeInitializationKey(patient, 'push', 'server-1')).toBe('local-1:server-1:push:2');
    expect(getMergeInitializationKey(patient, 'pull', 'server-1')).toBe('local-1:server-1:pull:2');
  });
});

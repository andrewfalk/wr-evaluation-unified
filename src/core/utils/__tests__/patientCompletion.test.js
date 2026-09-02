import { describe, it, expect, vi } from 'vitest';

vi.mock('../../moduleRegistry', () => ({
  getModule: vi.fn(),
}));

import { getModule } from '../../moduleRegistry';
import { isPatientComplete, completionReportFields } from '../patientCompletion';

function makePatient({ activeModules = ['knee'], modules = {}, shared = {} } = {}) {
  return { data: { activeModules, modules, shared } };
}

describe('isPatientComplete', () => {
  it('returns false when activeModules is empty', () => {
    expect(isPatientComplete(makePatient({ activeModules: [] }))).toBe(false);
  });

  it('returns true only when every active module reports complete', () => {
    getModule.mockImplementation((id) => ({
      isComplete: () => id === 'knee',
    }));
    expect(isPatientComplete(makePatient({ activeModules: ['knee'] }))).toBe(true);
    expect(isPatientComplete(makePatient({ activeModules: ['knee', 'shoulder'] }))).toBe(false);
  });

  it('treats a module lookup failure as incomplete rather than throwing', () => {
    getModule.mockImplementation(() => { throw new Error('unknown module'); });
    expect(isPatientComplete(makePatient({ activeModules: ['knee'] }))).toBe(false);
  });

  it('treats a missing isComplete() as incomplete', () => {
    getModule.mockImplementation(() => ({}));
    expect(isPatientComplete(makePatient())).toBe(false);
  });
});

describe('completionReportFields', () => {
  it('reflects isPatientComplete and always includes build/schema version', () => {
    getModule.mockImplementation(() => ({ isComplete: () => true }));
    const fields = completionReportFields(makePatient());
    expect(fields).toEqual({
      modulesCompleteObserved: true,
      completionClientBuildVersion: expect.any(String),
      completionClientSchemaVersion: expect.any(Number),
    });
  });

  it('reports false for an incomplete patient', () => {
    getModule.mockImplementation(() => ({ isComplete: () => false }));
    const fields = completionReportFields(makePatient());
    expect(fields.modulesCompleteObserved).toBe(false);
  });
});

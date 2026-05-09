import { describe, expect, it } from 'vitest';
import { buildPatientNameWarningMap } from '../PatientSidebar.jsx';

function makePatient(id, { patientNo = 'P001', birthDate = '1980-01-01', name = 'Kim' } = {}) {
  return {
    id,
    data: {
      shared: { patientNo, birthDate, name },
      modules: {},
      activeModules: [],
    },
  };
}

describe('buildPatientNameWarningMap', () => {
  it('warns when patient number and birth date match but names differ', () => {
    const warnings = buildPatientNameWarningMap([
      makePatient('p1', { name: 'Kim' }),
      makePatient('p2', { name: 'Lee' }),
    ]);

    expect(warnings.get('p1')).toMatchObject({
      code: 'PATIENT_NAME_MISMATCH',
      incomingName: 'Kim',
      existingName: 'Lee',
    });
    expect(warnings.get('p2')).toMatchObject({
      code: 'PATIENT_NAME_MISMATCH',
      incomingName: 'Lee',
      existingName: 'Kim',
    });
  });

  it('does not warn when birth dates differ or patient number is missing', () => {
    const warnings = buildPatientNameWarningMap([
      makePatient('p1', { name: 'Kim', birthDate: '1980-01-01' }),
      makePatient('p2', { name: 'Lee', birthDate: '1981-01-01' }),
      makePatient('p3', { name: 'Park', patientNo: '' }),
    ]);

    expect(warnings.size).toBe(0);
  });
});

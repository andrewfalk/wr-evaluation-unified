import { describe, expect, it } from 'vitest';
import { generateEMRFieldData } from '../exportService.js';

function makePatient({ activeModules = [], jobs = [], modules = {} } = {}) {
  return {
    id: 'test-patient',
    data: {
      shared: {
        jobs,
        diagnoses: [],
        patientNo: '',
        name: '',
        gender: '',
        height: '',
        weight: '',
        birthDate: '',
        injuryDate: '',
        evaluationDate: '',
        hospitalName: '',
        department: '',
        doctorName: '',
        specialNotes: '',
        medicalRecord: '',
        highBloodPressure: false,
        diabetes: false,
        visitHistory: '',
        consultReplyOrtho: '',
        consultReplyNeuro: '',
        consultReplyRehab: '',
        consultReplyOther: '',
      },
      modules,
      activeModules,
    },
  };
}

describe('generateEMRFieldData — txtJobCusCont 소제목 구조', () => {
  it('activeModules가 없으면 [부위별 신체부담 평가] 소제목이 없다', () => {
    const patient = makePatient({ activeModules: [], jobs: [{ id: 'j1', jobName: '사무직' }] });
    const { txtJobCusCont } = generateEMRFieldData(patient);
    expect(txtJobCusCont).toContain('[직업력]');
    expect(txtJobCusCont).not.toContain('[부위별 신체부담 평가]');
  });

  it('activeModules가 있으면 [직업력] 다음에 [부위별 신체부담 평가]가 온다', () => {
    const patient = makePatient({
      activeModules: ['knee'],
      jobs: [{ id: 'j1', jobName: '용접공' }],
      modules: { knee: {} },
    });
    const { txtJobCusCont } = generateEMRFieldData(patient);
    const jobIdx = txtJobCusCont.indexOf('[직업력]');
    const burdenIdx = txtJobCusCont.indexOf('[부위별 신체부담 평가]');
    expect(jobIdx).toBeGreaterThanOrEqual(0);
    expect(burdenIdx).toBeGreaterThan(jobIdx);
  });

  it('[부위별 신체부담 평가]는 텍스트 내에 정확히 1번만 나타난다', () => {
    const patient = makePatient({
      activeModules: ['knee'],
      jobs: [{ id: 'j1', jobName: '용접공' }, { id: 'j2', jobName: '광부' }],
      modules: { knee: {} },
    });
    const { txtJobCusCont } = generateEMRFieldData(patient);
    const occurrences = (txtJobCusCont.match(/\[부위별 신체부담 평가\]/g) || []).length;
    expect(occurrences).toBe(1);
  });
});

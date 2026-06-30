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

describe('generateEMRFieldData — txtMrecMedPovCont CP949 바이트 절단', () => {
  // 테스트도 구현과 동일한 CP949 근사(ASCII=1, 그 외=2)로 바이트를 계산
  const cp949Bytes = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) <= 0x7F ? 1 : 2), 0);

  it('CP949 3950바이트(한글 1975자) 이하는 자르지 않는다', () => {
    const text = '가'.repeat(1975); // 1975 × 2 = 3950 bytes (한도와 정확히 일치)
    const patient = makePatient();
    patient.data.shared.medicalRecord = text;
    const { txtMrecMedPovCont, _truncatedFields } = generateEMRFieldData(patient);
    expect(txtMrecMedPovCont).toBe(text);
    expect(_truncatedFields).not.toContain('txtMrec_Med_Pov_Cont');
  });

  it('CP949 3950바이트 초과 시 suffix를 붙이고 한도 이내로 자른다', () => {
    const text = '가'.repeat(2200); // 4400 bytes > 3950
    const patient = makePatient();
    patient.data.shared.medicalRecord = text;
    const { txtMrecMedPovCont, _truncatedFields } = generateEMRFieldData(patient);
    expect(txtMrecMedPovCont).toContain('...(이하 생략)');
    expect(txtMrecMedPovCont).not.toBe(text);
    expect(cp949Bytes(txtMrecMedPovCont)).toBeLessThanOrEqual(3950);
    expect(_truncatedFields).toContain('txtMrec_Med_Pov_Cont');
  });
});

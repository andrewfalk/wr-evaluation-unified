import { describe, expect, it } from 'vitest';
import { generateEMRFieldData } from '../exportService.js';
import { cp949ByteLength } from '../emrText.js';

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

function makeAssessmentPatient({ diagnoses = [], activeModules = [], modules = {}, reportOptions } = {}) {
  const patient = makePatient({ activeModules, modules });
  patient.data.shared.diagnoses = diagnoses;
  if (reportOptions) patient.data.shared.reportOptions = reportOptions;
  return patient;
}

function kneeDiag(overrides = {}) {
  return {
    id: 'd1', code: 'M17.0', name: '무릎 관절증', side: 'right',
    confirmedRight: 'confirmed', assessmentRight: 'high',
    reasonRight: [], reasonRightOther: '',
    confirmedLeft: '', assessmentLeft: '', reasonLeft: [], reasonLeftOther: '',
    ...overrides,
  };
}

describe('generateEMRFieldData — b8(txtSyth1Cont) 요약본 + b5(txtAppvSickCont) 번호 (assessmentGroups.js/emrReport.js 연동)', () => {
  it('txtSyth1Cont는 요약 헤더 없이 평가 결과 헤더부터 시작한다', () => {
    const patient = makeAssessmentPatient({ diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} } });
    const { txtSyth1Cont } = generateEMRFieldData(patient);
    expect(txtSyth1Cont).not.toContain('[ 신체부담 평가 요약 ]');
    expect(txtSyth1Cont).not.toContain('※ 상세 내용은 4.직업적 요인 항목 참조');
    expect(txtSyth1Cont).toContain('[ 업무관련성 평가 결과 ]');
    expect(txtSyth1Cont).toContain('#1: M17.0 무릎 관절증');
  });

  it('txtSyth1Cont(요약)에는 txtJobCusCont(전문)의 학회 보고서 참조문구가 없다', () => {
    const patient = makeAssessmentPatient({ diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} } });
    const { txtSyth1Cont, txtJobCusCont } = generateEMRFieldData(patient);
    expect(txtJobCusCont).toContain('보고서를 참조하기 바람');
    expect(txtSyth1Cont).not.toContain('보고서를 참조하기 바람');
  });

  it('reportOptions.groupAssessmentResults가 없으면(기존 환자) b5·b8에 번호를 붙이지 않는다', () => {
    const patient = makeAssessmentPatient({ diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} } });
    const { txtAppvSickCont, txtSyth1Cont } = generateEMRFieldData(patient);
    expect(txtAppvSickCont).toBe('M17.0 무릎 관절증');
    expect(txtSyth1Cont).toContain('#1: M17.0 무릎 관절증'); // 개별 형식 고유 헤더(콜론)
    expect(txtSyth1Cont).not.toContain('[상병 확인 · 업무관련성 높음]');
  });

  it('reportOptions.groupAssessmentResults가 켜지면 b5에 번호가 붙고 b8은 그룹 형식이 된다', () => {
    const patient = makeAssessmentPatient({
      diagnoses: [kneeDiag()],
      activeModules: ['knee'],
      modules: { knee: {} },
      reportOptions: { groupAssessmentResults: true },
    });
    const { txtAppvSickCont, txtSyth1Cont } = generateEMRFieldData(patient);
    expect(txtAppvSickCont).toBe('#1. M17.0 무릎 관절증');
    expect(txtSyth1Cont).toContain('[상병 확인 · 업무관련성 높음] 1개');
    expect(txtSyth1Cont).toContain('#1. M17.0 무릎 관절증 (우측)');
  });

  it('방향 미선택 상병은 그룹 형식(txtSyth1Cont)에서도 사라지지 않고 [미입력/검토 필요]에 남는다', () => {
    const patient = makeAssessmentPatient({
      diagnoses: [kneeDiag({ side: '' })],
      activeModules: ['knee'],
      modules: { knee: {} },
      reportOptions: { groupAssessmentResults: true },
    });
    const { txtSyth1Cont } = generateEMRFieldData(patient);
    expect(txtSyth1Cont).toContain('[미입력/검토 필요] 1개\n#1. M17.0 무릎 관절증 (방향 미선택)');
  });
});

describe('generateEMRFieldData — txtMrecMedPovCont CP949 바이트 절단', () => {
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
    expect(cp949ByteLength(txtMrecMedPovCont)).toBeLessThanOrEqual(3950);
    expect(_truncatedFields).toContain('txtMrec_Med_Pov_Cont');
  });
});

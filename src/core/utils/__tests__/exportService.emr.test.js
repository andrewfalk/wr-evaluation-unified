import { describe, expect, it } from 'vitest';
import { generateEMRFieldData } from '../exportService.js';
import { generateUnifiedEMR, resolveAssessment, prepareEmrInjection } from '../emrReport.js';
import { cp949ByteLength, EMR_TEXT_LIMIT_BYTES } from '../emrText.js';

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
    expect(txtSyth1Cont).not.toContain('#1. M17.0 무릎 관절증 ('); // 그룹 형식 고유 헤더(마침표+방향)는 없어야 함
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
    expect(txtSyth1Cont).toContain('#1. M17.0 무릎 관절증 (우측)\n상병 상태(확인) / 업무관련성(높음)');
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

describe('generateUnifiedEMR — groupOutputOverride 파라미터 (미리보기의 그룹/개별 동시 계산용)', () => {
  it('override를 생략하면 reportOptions.groupAssessmentResults를 그대로 따른다', () => {
    const patientGroupOn = makeAssessmentPatient({
      diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} },
      reportOptions: { groupAssessmentResults: true },
    });
    const patientGroupOff = makeAssessmentPatient({
      diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} },
    });
    expect(generateUnifiedEMR(patientGroupOn).b8).toContain('상병 상태(확인) / 업무관련성(높음)');
    expect(generateUnifiedEMR(patientGroupOff).b8).toContain('#1: M17.0 무릎 관절증');
  });

  it('override를 명시하면 저장된 reportOptions 값과 무관하게 그룹/개별 형식을 강제한다', () => {
    const patient = makeAssessmentPatient({
      diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} },
      reportOptions: { groupAssessmentResults: false },
    });
    expect(generateUnifiedEMR(patient, true).b8).toContain('상병 상태(확인) / 업무관련성(높음)');
    expect(generateUnifiedEMR(patient, false).b8).toContain('#1: M17.0 무릎 관절증');
    // 저장된 값(false)이 그대로면 override=false와 동일한 결과여야 한다
    expect(generateUnifiedEMR(patient).b8).toBe(generateUnifiedEMR(patient, false).b8);
  });
});

describe('generateEMRFieldData — 특이 사항 메모(returnConsiderations)는 EMR로 전송하지 않는다', () => {
  it('메모 값이 있어도 txtArrv1Cont 키를 반환 객체에 포함하지 않는다', () => {
    const patient = makePatient({
      activeModules: ['knee'],
      modules: { knee: { returnConsiderations: '무릎 보호대 착용 권장' } },
    });
    const fieldData = generateEMRFieldData(patient);
    expect(fieldData).not.toHaveProperty('txtArrv1Cont');
  });

  it('generateUnifiedEMR().b9는 여전히 계산된다 — 엑셀 내보내기가 독립적으로 소비한다', () => {
    const patient = makePatient({
      activeModules: ['knee'],
      modules: { knee: { returnConsiderations: '무릎 보호대 착용 권장' } },
    });
    expect(generateUnifiedEMR(patient).b9).toBe('무릎 보호대 착용 권장');
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

function overridePatient(overrideOverrides = {}, patientOverrides = {}) {
  const patient = makeAssessmentPatient({
    diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} },
    ...patientOverrides,
  });
  const generated = generateUnifiedEMR(patient).b8;
  patient.data.shared.reportOptions = {
    ...patient.data.shared.reportOptions,
    assessmentOverride: {
      text: '의사가 직접 다듬은 종합소견 문장',
      baseText: generated,
      updatedAt: '2024-01-10T09:00:00.000Z',
      ...overrideOverrides,
    },
  };
  return { patient, generated };
}

describe('resolveAssessment — 종합소견 직접 편집 오버라이드 접근자', () => {
  it('오버라이드가 없으면(구 환자) 자동 생성본을 그대로 쓰고 isOverride=false', () => {
    const patient = makeAssessmentPatient({ diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} } });
    const generated = generateUnifiedEMR(patient).b8;
    const effective = resolveAssessment(patient, generated);
    expect(effective).toEqual({
      text: generated, generated, isOverride: false, isStale: false, hasInvalidOverride: false,
    });
  });

  it('유효한 오버라이드가 있으면 편집본을 우선하고 isOverride=true', () => {
    const { patient, generated } = overridePatient();
    const effective = resolveAssessment(patient, generated);
    expect(effective.text).toBe('의사가 직접 다듬은 종합소견 문장');
    expect(effective.isOverride).toBe(true);
    expect(effective.hasInvalidOverride).toBe(false);
  });

  it('baseText가 현재 자동 생성본과 같으면 isStale=false', () => {
    const { patient, generated } = overridePatient();
    expect(resolveAssessment(patient, generated).isStale).toBe(false);
  });

  it('baseText가 현재 자동 생성본과 다르면(상병 변경 등) isStale=true', () => {
    const { patient } = overridePatient();
    const changedGenerated = generateUnifiedEMR(
      makeAssessmentPatient({ diagnoses: [kneeDiag(), kneeDiag({ id: 'd2', code: 'M17.1' })], activeModules: ['knee'], modules: { knee: {} } })
    ).b8;
    expect(resolveAssessment(patient, changedGenerated).isStale).toBe(true);
  });

  it.each([
    ['공백-only text', { text: '   \n\t' }],
    ['baseText 누락', { baseText: undefined }],
    ['updatedAt 누락', { updatedAt: undefined }],
    ['updatedAt이 파싱 불가', { updatedAt: 'not-a-date' }],
  ])('%s → hasInvalidOverride=true, 자동 생성본으로 폴백', (_label, overrideOverrides) => {
    const { patient, generated } = overridePatient(overrideOverrides);
    const effective = resolveAssessment(patient, generated);
    expect(effective.hasInvalidOverride).toBe(true);
    expect(effective.isOverride).toBe(false);
    expect(effective.text).toBe(generated);
  });

  it('assessmentOverride가 null이면(키는 있음) hasInvalidOverride=true', () => {
    const patient = makeAssessmentPatient({ diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} } });
    const generated = generateUnifiedEMR(patient).b8;
    patient.data.shared.reportOptions = { assessmentOverride: null };
    const effective = resolveAssessment(patient, generated);
    expect(effective.hasInvalidOverride).toBe(true);
    expect(effective.text).toBe(generated);
  });
});

describe('prepareEmrInjection — 편집본 CP949 절단 + 생성 1회 통일', () => {
  it('오버라이드 미설정 시 generateEMRFieldData의 기존 출력과 완전히 동일하다 (회귀)', () => {
    const patient = makeAssessmentPatient({
      diagnoses: [kneeDiag()], activeModules: ['knee'], modules: { knee: {} },
      reportOptions: { groupAssessmentResults: true },
    });
    expect(prepareEmrInjection(patient).fieldData).toEqual(generateEMRFieldData(patient));
  });

  it('편집본이 있으면 txtSyth1Cont에 편집본이 실린다', () => {
    const { patient } = overridePatient();
    const { fieldData, effective } = prepareEmrInjection(patient);
    expect(fieldData.txtSyth1Cont).toBe('의사가 직접 다듬은 종합소견 문장');
    expect(effective.isOverride).toBe(true);
  });

  it('편집본이 CP949 한도를 넘으면 잘리고 _truncatedFields에 표시된다', () => {
    const longText = '가'.repeat(3000); // 6000 bytes > 3950
    const { patient } = overridePatient({ text: longText, baseText: longText });
    const { fieldData, bytes } = prepareEmrInjection(patient);
    expect(fieldData.txtSyth1Cont).toContain('...(이하 생략)');
    expect(cp949ByteLength(fieldData.txtSyth1Cont)).toBeLessThanOrEqual(EMR_TEXT_LIMIT_BYTES);
    expect(fieldData._truncatedFields).toContain('txtSyth1Cont');
    expect(bytes).toBe(cp949ByteLength(longText)); // bytes는 절단 전 편집본 기준(byte 경고용)
  });
});

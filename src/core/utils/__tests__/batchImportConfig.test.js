import { describe, expect, it, vi } from 'vitest';

// html2pdf.js의 UMD 빌드는 브라우저 전역 `self`를 참조하므로 node 테스트 환경에서
// 모듈 index.js(→ exportHandlers) import 시 ReferenceError가 발생한다. 회귀 테스트
// 목적상 PDF 생성 로직은 필요 없으므로 모킹한다.
vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/spine';
import '../../../modules/cervical';
import '../../../modules/elbow';
import '../../../modules/wrist';
import { getAllModules } from '../../moduleRegistry';
import {
  normalizeHeader, parseDate, parseSide, getCell, buildColMap,
  ensureDiagnosis, ensureSharedJob, applyReturnConsiderations,
  parseConfirmedStatus, parseAssessmentLevel, parseReasonText, applyDiagnosisAssessment,
} from '../batchImportHelpers';
import { BATCH_HEADERS, generateBatchRows } from '../exportService';
import { createDiagnosis } from '../data';

const BASE_COLUMNS = {
  name: ['이름', 'name'],
  diagCode: ['진단코드', 'code'],
  diagName: ['진단명', 'diag'],
  side: ['방향', 'side'],
  returnConsiderations: ['복귀고려사항', 'return'],
  jobName: ['직종명', 'job'],
  jobStart: ['시작일', 'start'],
  jobEnd: ['종료일', 'end'],
  jobPeriodY: ['근무기간(년)', 'period(년)', 'period_y'],
  jobPeriodM: ['근무기간(개월)', 'period(개월)', 'period_m'],
};

function makePatient() {
  return {
    id: 'p1',
    data: {
      shared: { name: '', birthDate: '', injuryDate: '', diagnoses: [], jobs: [] },
      modules: {},
      activeModules: [],
    },
  };
}

describe('registerModule batchImportConfig (6개 모듈 일괄 import 회귀)', () => {
  const moduleConfigs = getAllModules()
    .map(mod => ({ id: mod.id, batchImportConfig: mod.batchImportConfig }))
    .filter(mod => mod.batchImportConfig);

  it('knee/shoulder/spine/cervical/elbow/wrist 모두 batchImportConfig를 등록한다', () => {
    const ids = moduleConfigs.map(mod => mod.id).sort();
    expect(ids).toEqual(['cervical', 'elbow', 'knee', 'shoulder', 'spine', 'wrist']);
  });

  const headerRow = [
    '이름', '진단코드', '진단명', '방향', '복귀고려사항', '직종명', '시작일', '종료일',
    'klg(우)', 'ellman(좌)',
    '중량물(kg)', '쪼그려앉기',
    '오버헤드', '반복중간',
    '작업명', '자세코드',
    '경추_작업명', '경추_노출유형',
    '팔꿈치_bk유형', '팔꿈치_문제작업명',
    '손목_bk유형', '손목_문제작업명',
  ].map(normalizeHeader);

  const row = [
    '홍길동', 'M17.1', '무릎 관절증', '우측', '복귀시 중량물 제한', '용접공', '2020-01-01', '2024-01-01',
    '2', '3',
    '15', '120',
    '3', '2',
    '용접작업', 'G1',
    '목작업', '어깨에 무거운 하중 운반',
    'BK2101', '망치작업',
    'BK2101', '드라이버작업',
  ];

  const colMap = buildColMap(headerRow, [
    BASE_COLUMNS,
    ...moduleConfigs.map(mod => mod.batchImportConfig.columns || {}),
  ]);

  const stats = { newDiagnoses: 0, newJobs: 0 };
  const patient = makePatient();
  patient.data.shared.name = String(getCell(row, colMap.name) || '').trim();
  patient.data.shared.birthDate = parseDate(getCell(row, colMap.birthDate));
  patient.data.shared.injuryDate = parseDate(getCell(row, colMap.injuryDate));

  const diagCode = String(getCell(row, colMap.diagCode) || '').trim();
  const diagName = String(getCell(row, colMap.diagName) || '').trim();
  const side = parseSide(getCell(row, colMap.side));
  const diagnosis = ensureDiagnosis(patient, diagCode, diagName, side, stats);
  const job = ensureSharedJob(patient, row, colMap, getCell, stats);

  moduleConfigs.forEach(mod => {
    mod.batchImportConfig.applyRow({ patient, row, diagnosis, job, colMap, getCell, rowIndex: 1 });
  });

  applyReturnConsiderations(
    patient,
    String(getCell(row, colMap.returnConsiderations) || '').trim(),
    moduleConfigs.map(mod => mod.id)
  );

  it('진단/직업을 생성하고 KLG·Ellman 등급을 진단에 채운다', () => {
    expect(diagnosis.code).toBe('M17.1');
    expect(diagnosis.klgRight).toBe('2');
    expect(diagnosis.ellmanLeft).toBe('3');
    expect(job.jobName).toBe('용접공');
    expect(stats.newDiagnoses).toBe(1);
    expect(stats.newJobs).toBe(1);
  });

  it('knee jobExtras에 중량물/쪼그려앉기 값을 채운다', () => {
    const extra = patient.data.modules.knee.jobExtras.find(e => e.sharedJobId === job.id);
    expect(extra.weight).toBe('15');
    expect(extra.squatting).toBe('120');
  });

  it('shoulder jobExtras에 오버헤드/반복중간 값을 채운다', () => {
    const extra = patient.data.modules.shoulder.jobExtras.find(e => e.sharedJobId === job.id);
    expect(extra.overheadHours).toBe('3');
    expect(extra.repetitiveMediumHours).toBe('2');
  });

  it('spine tasks에 작업명/자세코드 task를 생성하고 공식버전을 v5.1.3으로 승격한다', () => {
    const task = patient.data.modules.spine.tasks.find(t => t.name === '용접작업');
    expect(task.posture).toBe('G1');
    expect(task.sharedJobId).toBe(job.id);
    expect(patient.data.modules.spine.formulaVersion).toBe('v5.1.3');
  });

  it('cervical tasks에 작업명/노출유형을 채운다', () => {
    const task = patient.data.modules.cervical.tasks.find(t => t.sharedJobId === job.id);
    expect(task.name).toBe('목작업');
    expect(task.exposure_types).toEqual(['shoulder_heavy_load']);
  });

  it('elbow jobEvaluations에 BK 유형/문제작업명을 채운 진단 entry를 생성한다', () => {
    const jobEval = patient.data.modules.elbow.jobEvaluations.find(j => j.sharedJobId === job.id);
    const entry = jobEval.diagnosisEntries.find(e => e.diagnosisId === diagnosis.id);
    expect(entry.selectedBkType).toBe('BK2101');
    expect(entry.main_task_name).toBe('망치작업');
  });

  it('wrist jobEvaluations에 BK 유형/문제작업명을 채운 진단 entry를 생성한다', () => {
    const jobEval = patient.data.modules.wrist.jobEvaluations.find(j => j.sharedJobId === job.id);
    const entry = jobEval.diagnosisEntries.find(e => e.diagnosisId === diagnosis.id);
    expect(entry.selectedBkType).toBe('BK2101');
    expect(entry.main_task_name).toBe('드라이버작업');
  });

  it('복귀고려사항을 import 대상이 된 모든 모듈에 전파한다', () => {
    for (const mod of moduleConfigs) {
      expect(patient.data.modules[mod.id].returnConsiderations).toBe('복귀시 중량물 제한');
    }
  });
});

describe('parseConfirmedStatus / parseAssessmentLevel / parseReasonText', () => {
  it('parseConfirmedStatus: 확인/미확인/빈값/"-"', () => {
    expect(parseConfirmedStatus('확인')).toBe('confirmed');
    expect(parseConfirmedStatus('미확인')).toBe('unconfirmed');
    expect(parseConfirmedStatus('')).toBe('');
    expect(parseConfirmedStatus('-')).toBe('');
  });

  it('parseAssessmentLevel: 높음/낮음/빈값/"-"', () => {
    expect(parseAssessmentLevel('높음')).toBe('high');
    expect(parseAssessmentLevel('낮음')).toBe('low');
    expect(parseAssessmentLevel('')).toBe('');
    expect(parseAssessmentLevel('-')).toBe('');
  });

  it('parseReasonText: 빈값/"-"는 사유 없음', () => {
    expect(parseReasonText('')).toEqual({ reasons: [], other: '' });
    expect(parseReasonText('-')).toEqual({ reasons: [], other: '' });
  });

  it('parseReasonText: "기타 (텍스트)" → other 캡처, 앞뒤 공백 트림', () => {
    expect(parseReasonText('기타 (기타텍스트)')).toEqual({ reasons: ['other'], other: '기타텍스트' });
    expect(parseReasonText('기타 ( 기타텍스트 )')).toEqual({ reasons: ['other'], other: '기타텍스트' });
  });

  it('parseReasonText: "기타 ()" (빈 캡처)도 other로 인식한다', () => {
    expect(parseReasonText('기타 ()')).toEqual({ reasons: ['other'], other: '' });
  });

  it('parseReasonText: \\r\\n으로 join된 다중 사유의 순서를 보존한다', () => {
    expect(parseReasonText('누적 신체부담 낮음\r\n기타 (기타텍스트)'))
      .toEqual({ reasons: ['lowBurden', 'other'], other: '기타텍스트' });
  });

  it('parseReasonText: 신규 분할 라벨 7종을 value로 복원한다', () => {
    expect(parseReasonText('상병 미확인')).toEqual({ reasons: ['unconfirmed'], other: '' });
    expect(parseReasonText('연령대비 경미')).toEqual({ reasons: ['ageMild'], other: '' });
    expect(parseReasonText('부담 정도가 최소 문턱값을 넘지 못함'))
      .toEqual({ reasons: ['belowThreshold'], other: '' });
  });

  it('parseReasonText: 구 export 라벨 "상병 미확인/연령대비 경미"는 레거시 mild로 복원한다', () => {
    expect(parseReasonText('상병 미확인/연령대비 경미'))
      .toEqual({ reasons: ['mild'], other: '' });
  });
});

describe('generateBatchRows ↔ applyDiagnosisAssessment 라운드트립', () => {
  const diag1 = {
    code: 'M17.1', name: '무릎관절증', side: 'right',
    confirmedRight: 'confirmed', confirmedLeft: 'unconfirmed',
    assessmentRight: 'low', assessmentLeft: 'high',
    reasonRight: ['lowBurden', 'other'], reasonRightOther: '기타텍스트',
    reasonLeft: [], reasonLeftOther: '',
  };
  const diag2 = {
    code: 'M51.1', name: '요추간판장애', moduleId: 'spine', side: '',
    verticalDistribution: 'confirmed', concomitantSpondylosis: 'unconfirmed',
  };

  const patient = {
    data: {
      shared: { name: '홍길동', diagnoses: [diag1, diag2], jobs: [] },
      modules: {},
      activeModules: ['knee', 'spine'],
    },
  };

  const headerRow = BATCH_HEADERS.map(normalizeHeader);
  const colMap = buildColMap(headerRow, [{
    diagConfirmedRight: ['상병상태(우)'],
    diagConfirmedLeft: ['상병상태(좌)'],
    diagAssessmentRight: ['업무관련성(우)'],
    diagAssessmentLeft: ['업무관련성(좌)'],
    diagReasonRight: ['업무관련성낮음사유(우)'],
    diagReasonLeft: ['업무관련성낮음사유(좌)'],
    diagVerticalDistribution: ['수직분포원리'],
    diagConcomitantSpondylosis: ['동반척추증'],
  }]);

  const rows = generateBatchRows([patient]);

  it('knee 진단(non-spine): 상병상태/업무관련성/사유가 그대로 복원되고 true를 반환한다', () => {
    const restored = createDiagnosis();
    expect(applyDiagnosisAssessment(restored, rows[0], colMap, getCell, 'knee')).toBe(true);
    expect(restored.confirmedRight).toBe('confirmed');
    expect(restored.confirmedLeft).toBe('unconfirmed');
    expect(restored.assessmentRight).toBe('low');
    expect(restored.assessmentLeft).toBe('high');
    expect(restored.reasonRight).toEqual(['lowBurden', 'other']);
    expect(restored.reasonRightOther).toBe('기타텍스트');
  });

  it('spine 진단: 수직분포원리/동반척추증이 복원된다', () => {
    const restored = createDiagnosis();
    applyDiagnosisAssessment(restored, rows[1], colMap, getCell, 'spine');
    expect(restored.verticalDistribution).toBe('confirmed');
    expect(restored.concomitantSpondylosis).toBe('unconfirmed');
  });

  it('비-spine 진단 행에 수직분포원리/동반척추증 값이 있어도 무시한다', () => {
    const row = [...rows[0]];
    row[colMap.diagVerticalDistribution] = '확인';
    row[colMap.diagConcomitantSpondylosis] = '확인';

    const restored = createDiagnosis();
    applyDiagnosisAssessment(restored, row, colMap, getCell, 'knee');
    expect(restored.verticalDistribution).toBeUndefined();
    expect(restored.concomitantSpondylosis).toBeUndefined();
  });

  it('평가 컬럼이 모두 빈값/"-"이면 아무것도 바꾸지 않고 false를 반환한다', () => {
    const emptyRow = BATCH_HEADERS.map(() => '');
    const before = createDiagnosis();
    const restored = { ...before };
    expect(applyDiagnosisAssessment(restored, emptyRow, colMap, getCell, 'knee')).toBe(false);
    expect(restored).toEqual(before);
  });

  it('기존 값과 동일한 평가값을 재import하면 변경 없이 false를 반환한다', () => {
    const before = { ...createDiagnosis(), ...diag1 };
    const restored = { ...before };
    expect(applyDiagnosisAssessment(restored, rows[0], colMap, getCell, 'knee')).toBe(false);
    expect(restored).toEqual(before);
  });
});

describe('handleImport 완료 조건: 평가 컬럼만 있는 재import도 "가져올 데이터 없음"으로 처리되지 않는다', () => {
  // BatchImportModal.handleImport의 완료 조건을 재현 — 기존 환자의 기존 진단에
  // 종합소견(상병상태/업무관련성 등)만 갱신되는 경우에도 newPatients/newDiagnoses/
  // newJobs가 모두 0이지만 updatedAssessments > 0이면 onImport가 호출되어야 한다.
  it('updatedAssessments > 0이면 "가져올 데이터가 없습니다" 조건에 걸리지 않는다', () => {
    const stats = { newPatients: 0, newDiagnoses: 0, newJobs: 0, updatedAssessments: 1, skipped: 0, withDoctorName: 0 };
    const shouldShowEmptyAlert = stats.newPatients === 0 && stats.newDiagnoses === 0
      && stats.newJobs === 0 && stats.updatedAssessments === 0;
    expect(shouldShowEmptyAlert).toBe(false);
  });

  it('아무 변경이 없으면 여전히 "가져올 데이터가 없습니다"로 처리된다', () => {
    const stats = { newPatients: 0, newDiagnoses: 0, newJobs: 0, updatedAssessments: 0, skipped: 0, withDoctorName: 0 };
    const shouldShowEmptyAlert = stats.newPatients === 0 && stats.newDiagnoses === 0
      && stats.newJobs === 0 && stats.updatedAssessments === 0;
    expect(shouldShowEmptyAlert).toBe(true);
  });
});

import { describe, it, expect, vi } from 'vitest';

// html2pdf.js의 UMD 빌드는 브라우저 전역 `self`를 참조해 node 환경에서 모듈 index 로드가 실패한다 — PDF 로직은 필요 없어 모킹.
vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/elbow';
import '../../../modules/wrist';
import '../../../modules/spine';
import '../../../modules/cervical';
import { AiAnalysisInputSchema } from '@contracts/aiAnalysis';
import { buildPrompt } from '@contracts/aiPrompt';
import { getModule } from '../../moduleRegistry';
import { createTestPatients } from '../../fixtures/createTestPatients';
import { createPatient } from '../data';
import { getShoulderInterpretation } from '../reportGenerator';
import { buildAiInput, buildRawAiInput, classifyShoulderInterpretation } from '../aiInput';
import {
  createElbowModuleData, createElbowJobEvaluation, createElbowDiagnosisEntry,
} from '../../../modules/elbow/utils/data';

const clone = (value) => JSON.parse(JSON.stringify(value));
const HANGUL = /[가-힣]/;

const patients = createTestPatients();
const withModules = (...ids) => patients.find((p) => ids.every((id) => (p.data.activeModules || []).includes(id)) && (p.data.shared.jobs || []).length >= 2);

// 환자 데이터 안의 모든 한글 문자열(이름·직종·상병명·작업명·메모 등 자유 입력)과 날짜·UUID.
function collectSensitive(node, out = []) {
  if (typeof node === 'string') {
    if (HANGUL.test(node) || /^\d{4}-\d{2}-\d{2}/.test(node) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(node)) out.push(node.trim());
  } else if (Array.isArray(node)) node.forEach((child) => collectSensitive(child, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((child) => collectSensitive(child, out));
  return out;
}

describe('buildAiInput — 테스트 환자 전수', () => {
  it('모든 픽스처 환자가 스키마를 통과한다', () => {
    expect(patients.length).toBeGreaterThan(20);
    for (const patient of patients) {
      const result = AiAnalysisInputSchema.safeParse(buildRawAiInput(patient));
      expect(result.success, `${patient.data.shared.name}: ${result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3))}`).toBe(true);
      expect(buildAiInput(patient)).not.toBeNull();
    }
  });

  it('픽스처가 여섯 모듈 중 팔꿈치를 뺀 다섯을 모두 다룬다(팔꿈치는 별도 환자로 검증)', () => {
    const covered = new Set(patients.flatMap((p) => p.data.activeModules || []));
    for (const id of ['knee', 'shoulder', 'wrist', 'spine', 'cervical']) expect(covered.has(id), id).toBe(true);
  });

  it('입력 JSON에는 한글도 날짜도 UUID도 없다 — 값은 열거형 키·숫자·코드뿐이다', () => {
    for (const patient of patients) {
      const json = JSON.stringify(buildAiInput(patient));
      expect(HANGUL.test(json), patient.data.shared.name).toBe(false);
      expect(/\d{4}-\d{2}-\d{2}/.test(json), patient.data.shared.name).toBe(false);
      expect(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(json), patient.data.shared.name).toBe(false);
    }
  });

  it('환자 데이터의 자유 입력 문자열(이름·직종명·상병명·작업명·메모 등)이 입력과 프롬프트 어디에도 나오지 않는다', () => {
    for (const patient of patients) {
      const sensitive = collectSensitive(patient.data).filter((s) => s.length >= 4);
      expect(sensitive.length, `${patient.data.shared.name}: 민감 문자열이 있어야 검증이 의미 있다`).toBeGreaterThan(3);
      const input = buildAiInput(patient);
      const haystacks = [JSON.stringify(input), buildPrompt(input)];
      for (const secret of sensitive) {
        for (const haystack of haystacks) expect(haystack.includes(secret), `${patient.data.shared.name}: "${secret}"`).toBe(false);
      }
    }
  });

  it('환자 객체를 변경하지 않는다', () => {
    const patient = withModules('knee', 'spine', 'cervical');
    const before = JSON.stringify(patient);
    buildAiInput(patient);
    expect(JSON.stringify(patient)).toBe(before);
  });

  it('같은 환자는 항상 같은 입력을 만든다(결정적)', () => {
    const patient = withModules('knee', 'spine', 'cervical');
    expect(JSON.stringify(buildAiInput(patient))).toBe(JSON.stringify(buildAiInput(patient)));
  });
});

describe('buildAiInput — 직력·상병 매핑', () => {
  it('신체부담평가에서 제외된 직력은 jobs에 표시되고 모듈의 jobIndex는 원래 위치를 유지한다', () => {
    const patient = clone(withModules('knee', 'spine', 'cervical'));
    patient.data.shared.jobs[0].excludeFromAnalysis = true;
    const input = buildAiInput(patient);

    expect(input.jobs[0].excludedFromAnalysis).toBe(true);
    expect(input.jobs.slice(1).every((job) => job.excludedFromAnalysis === false)).toBe(true);
    const rest = patient.data.shared.jobs.map((_, i) => i).slice(1);
    expect(input.modules.knee.jobs.map((j) => j.jobIndex)).toEqual(rest);
    expect(input.modules.cervical.jobs.map((j) => j.jobIndex)).toEqual(rest);
    expect(input.modules.spine.mddm.jobs.map((j) => j.jobIndex)).toEqual(rest);
  });

  it('모든 직력이 제외되면 모듈이 noEvaluableJobs로 표시된다', () => {
    const patient = clone(withModules('knee', 'spine', 'cervical'));
    patient.data.shared.jobs.forEach((job) => { job.excludeFromAnalysis = true; });
    const { knee, spine, cervical } = buildAiInput(patient).modules;
    expect(knee.noEvaluableJobs).toBe(true);
    expect(spine.noEvaluableJobs).toBe(true);
    expect(cervical.noEvaluableJobs).toBe(true);
    expect(buildPrompt(buildAiInput(patient))).toContain('신체부담평가에 포함된 직력이 없어 평가하지 않음');
  });

  it('상병 코드는 ICD 형식으로 정규화하고 자유문은 null로 만든다', () => {
    const patient = clone(withModules('knee'));
    const base = patient.data.shared.diagnoses[0];
    patient.data.shared.diagnoses = [
      { ...base, id: 'd1', code: 'm171', name: '무릎관절증' },
      { ...base, id: 'd2', code: ' M17.1 ', name: '무릎관절증' },
      { ...base, id: 'd3', code: '홍길동 환자', name: '이름이 코드 칸에' },
      { ...base, id: 'd4', code: 'M1712', name: '소수 둘' },
    ];
    expect(buildAiInput(patient).diagnoses.map((d) => d.code)).toEqual(['M17.1', 'M17.1', null, 'M17.12']);
  });

  it('코드도 이름도 빈 상병 행은 빼고, 모듈의 상병 참조(diagnosisRefs)는 출력 배열 위치를 가리킨다', () => {
    const patient = createElbowPatient();
    patient.data.shared.diagnoses.unshift({ id: 'blank', code: '', name: '', side: '' }); // 맨 앞의 빈 행
    const input = buildAiInput(patient);
    expect(input.diagnoses).toHaveLength(1);
    expect(input.modules.elbow.jobs[0].groups[0].diagnosisRefs).toEqual([0]);
  });

  it('평가 단위: 좌우 슬롯은 K-L 등급을 갖고, 척추·경추(축성)는 axial 단일 슬롯이다', () => {
    const patient = withModules('knee', 'spine', 'cervical');
    const { diagnoses } = buildAiInput(patient);
    const knee = diagnoses.filter((d) => d.moduleId === 'knee');
    expect(knee.length).toBeGreaterThan(0);
    for (const d of knee) {
      expect(d.units.length).toBeGreaterThan(0);
      expect(d.units.every((u) => u.side === 'right' || u.side === 'left')).toBe(true);
    }
    const axial = diagnoses.filter((d) => d.moduleId === 'spine' || d.moduleId === 'cervical');
    expect(axial.length).toBeGreaterThan(0);
    for (const d of axial) expect(d.units.map((u) => u.side)).toEqual(['axial']);
  });

  it('인구학: 재해일 기준 만 나이·BMI·성별·고혈압·당뇨', () => {
    const patient = createElbowPatient();
    const { demographics } = buildAiInput(patient);
    expect(demographics).toEqual({ ageYears: 55, gender: 'male', heightCm: 172, weightKg: 74, bmi: 25, hypertension: true, diabetes: false });
  });

  it('인구학: 생년월일·재해일이 없거나 이상하면 나이는 null이고 오늘 날짜로 대체하지 않는다', () => {
    const patient = createElbowPatient();
    patient.data.shared.birthDate = '';
    expect(buildAiInput(patient).demographics.ageYears).toBeNull();
    patient.data.shared.birthDate = '1970-05-05';
    patient.data.shared.injuryDate = 'abc';
    expect(buildAiInput(patient).demographics.ageYears).toBeNull();
  });
});

describe('buildAiInput — 모듈 값', () => {
  it('어깨: 해석 키가 보고서 문구(getShoulderInterpretation)와 같은 판정이다', () => {
    const shoulderPatients = patients.filter((p) => (p.data.activeModules || []).includes('shoulder'));
    expect(shoulderPatients.length).toBeGreaterThan(3);
    const phrase = { exceeded: '초과하여', combinedSufficient: '복합 노출을 고려하여', insufficient: '미달하여' };
    const seen = new Set();
    for (const patient of shoulderPatients) {
      const calc = getModule('shoulder').computeCalc({ shared: patient.data.shared, module: patient.data.modules.shoulder });
      if (calc.noEvaluableJobs) continue;
      const key = buildAiInput(patient).modules.shoulder.interpretation;
      expect(getShoulderInterpretation(calc.totals), patient.data.shared.name).toContain(phrase[key]);
      seen.add(key);
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });

  it('어깨 해석 규칙: 초과 > 복합 노출(50% 3개 또는 75% 2개) > 미달', () => {
    const t = (ratio, exceeded = false) => ({ ratio, exceeded });
    expect(classifyShoulderInterpretation([t(1.2, true), t(0)])).toBe('exceeded');
    expect(classifyShoulderInterpretation([t(0.5), t(0.5), t(0.5), t(0)])).toBe('combinedSufficient');
    expect(classifyShoulderInterpretation([t(0.75), t(0.75), t(0)])).toBe('combinedSufficient');
    expect(classifyShoulderInterpretation([t(0.75), t(0.5), t(0.49)])).toBe('insufficient');
  });

  it('무릎: 부담 정도·기여도·누적 신체부담이 계산 결과와 같다', () => {
    const patient = withModules('knee');
    const calc = getModule('knee').computeCalc({ shared: patient.data.shared, module: patient.data.modules.knee });
    const knee = buildAiInput(patient).modules.knee;
    expect(knee.cumulativeBurdenSufficient).toBe(calc.cumulativeBurden === '충분함');
    expect(knee.relatedness.minPct).toBe(Number(calc.relatedness.min));
    expect(knee.relatedness.maxPct).toBe(Number(calc.relatedness.max));
    expect(knee.jobs).toHaveLength(calc.jobBurdens.length);
    const levels = { 고도: 'high', 중등도상: 'upperModerate', 중등도하: 'lowerModerate', 경도: 'low' };
    knee.jobs.forEach((job, i) => expect(job.burdenLevel).toBe(levels[calc.jobBurdens[i].burden.level]));
  });

  it('손목: 표 밖의 시간적 선후관계 값(예: unclear)은 null이다', () => {
    const patient = patients.find((p) => (p.data.activeModules || []).includes('wrist') && p.data.modules.wrist.temporalSequence.improves_with_rest === 'unclear');
    expect(patient, '픽스처에 unclear 값을 가진 손목 환자가 있어야 한다').toBeTruthy();
    expect(buildAiInput(patient).modules.wrist.temporal.improvesWithRest).toBeNull();
  });

  it('손목: BK 유형별 위험요인·부담 등급이 채워진다', () => {
    const patient = patients.find((p) => (p.data.activeModules || []).includes('wrist'));
    const { jobs } = buildAiInput(patient).modules.wrist;
    const groups = jobs.flatMap((job) => job.groups);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => ['BK2113', 'BK2101', 'BK2103', 'BK2106', null].includes(g.bkType))).toBe(true);
    expect(groups.some((g) => g.riskFactorKeys.length > 0)).toBe(true);
    expect(groups.every((g) => g.riskFactorCount >= g.riskFactorKeys.length)).toBe(true);
  });

  it('척추: MDDM 비교·업무관련성·중증도·자세가 채워지고 포함 기준(1900N)을 따른다', () => {
    const patient = withModules('spine');
    const calc = getModule('spine').computeCalc({ shared: patient.data.shared, module: patient.data.modules.spine });
    const { mddm } = buildAiInput(patient).modules.spine;
    expect(mddm.comparison.court.percent).toBe(calc.comparison.court.percent);
    expect(mddm.comparison.court.status).toBe(calc.comparison.court.status);
    expect(mddm.workRelatedness.level).toBe(calc.workRelatedness.level);
    for (const job of mddm.jobs) {
      for (const task of job.tasks) {
        expect(task.posture).toMatch(/^G\d+$/);
        expect(task.included).toBe((task.forceN ?? 0) >= 1900);
      }
    }
  });

  it('경추: 직력별 등급·충족 항목·작업이 채워진다', () => {
    const patient = withModules('cervical');
    const { cervical } = buildAiInput(patient).modules;
    expect(['high_bk2109', 'present', 'low']).toContain(cervical.overallBurdenGrade);
    expect(cervical.jobs.length).toBeGreaterThan(0);
    for (const job of cervical.jobs) {
      expect(job.taskCount).toBeGreaterThanOrEqual(job.completedTaskCount);
      expect(job.tasks.length).toBeGreaterThan(0);
    }
  });
});

// ── 팔꿈치: 기존 픽스처에 없어 직접 만든다 ───────────────────────────────────
function createElbowPatient() {
  const patient = createPatient();
  patient.data.shared = {
    ...patient.data.shared,
    name: '박팔꿈치', patientNo: 'P-0777', birthDate: '1970-05-05', injuryDate: '2025-06-01', gender: 'male',
    height: '172', weight: '74', hospitalName: '테스트병원', doctorName: '김의사', specialNotes: '비밀 특이사항 메모',
    highBloodPressure: '유', diabetes: '무',
    jobs: [{ id: 'job-a', jobName: '용접공(비밀직종)', presetId: null, startDate: '2000-01-01', endDate: '2010-01-01', workPeriodOverride: '', workDaysPerYear: 250 }],
    diagnoses: [{
      id: 'dx-1', code: 'M77.1', name: '외측상과염(비밀상병명)', side: 'right',
      confirmedRight: 'confirmed', assessmentRight: 'high', reasonRight: [], reasonRightOther: '비밀사유',
    }],
  };
  const elbow = createElbowModuleData();
  elbow.temporalSequence = { recent_task_change: 'increased_load', task_change_date: '2024-01-10', symptom_onset_interval: '3to12m', improves_with_rest: 'yes' };
  const job = createElbowJobEvaluation('job-a');
  const entry = createElbowDiagnosisEntry({ id: 'dx-1', code: 'M77.1', name: '외측상과염' });
  Object.assign(entry, {
    selectedBkType: 'BK2101', main_task_name: '비밀 작업명', direct_anatomic_link: 'yes', exposure_types: ['repetition', 'force'],
    repetition_level: 'frequent', daily_exposure_hours: '4', shift_share_percent: '60', days_per_week: '5', work_pattern: 'continuous',
    rest_distribution: 'insufficient', force_level: 'moderate', awkward_posture_level: 'frequent', static_holding_level: 'frequent',
    bk2101_cycle_seconds: '0.3', bk2101_repetition_per_hour: '9000', bk2101_monotony: 'yes', bk2101_forced_dorsal_extension: 'yes', bk2101_prosupination: 'yes',
  });
  job.diagnosisEntries = [entry];
  elbow.jobEvaluations = [job];
  patient.data.modules.elbow = elbow;
  patient.data.activeModules = ['elbow'];
  return patient;
}

describe('buildAiInput — 팔꿈치', () => {
  it('팔꿈치 환자도 스키마를 통과하고 BK2101 그룹이 채워진다', () => {
    const input = buildAiInput(createElbowPatient());
    expect(input).not.toBeNull();
    const { elbow } = input.modules;
    expect(elbow.temporal).toMatchObject({ recentTaskChange: 'increased_load', improvesWithRest: 'yes' });
    expect(elbow.temporal.flags).toContain('temporal_fit_high');
    const group = elbow.jobs[0].groups[0];
    expect(group.bkType).toBe('BK2101');
    expect(group.diagnosisRefs).toEqual([0]);
    expect(group.riskFactorKeys.length).toBeGreaterThan(0);
    expect(group.riskFactorCount).toBe(group.riskFactorKeys.length);
    expect(['mild', 'moderate', 'high']).toContain(group.burdenGrade);
  });

  it('팔꿈치 환자의 식별·자유 입력 문자열이 입력과 프롬프트에 나오지 않는다', () => {
    const patient = createElbowPatient();
    const input = buildAiInput(patient);
    const json = JSON.stringify(input);
    const prompt = buildPrompt(input);
    for (const secret of ['박팔꿈치', 'P-0777', '1970-05-05', '2025-06-01', '테스트병원', '김의사', '비밀 특이사항 메모', '용접공(비밀직종)', '외측상과염', '비밀 작업명', '비밀사유']) {
      expect(json.includes(secret), secret).toBe(false);
      expect(prompt.includes(secret), secret).toBe(false);
    }
    expect(prompt).toContain('[팔꿈치(주관절)]');
  });
});

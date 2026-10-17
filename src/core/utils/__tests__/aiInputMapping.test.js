import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 모듈 레지스트리를 모킹해 모듈별 계산 결과(calc)를 테스트가 직접 정한다 — 실제 환자로는 만들기 어려운 경계값·표 밖 값·
// 비정상 입력을 정확히 재현하기 위해서다. (실제 모듈/환자로 도는 검증은 aiInput.test.js)
const registry = vi.hoisted(() => ({}));
vi.mock('../../moduleRegistry', () => ({ getModule: (id) => registry[id] }));

import { createPatient } from '../data';
import { buildPrompt } from '@contracts/aiPrompt';
import { buildAiInput, buildAiInputResult, buildRawAiInput } from '../aiInput';
import { getElbowBurdenGrade, mergeBkGroupSummaries as mergeElbow } from '../../../modules/elbow/utils/calculations';
import { getWristBurdenGrade, mergeBkGroupSummaries as mergeWrist } from '../../../modules/wrist/utils/calculations';

function patientWith(activeModules, calcByModule) {
  const patient = createPatient();
  patient.data.shared.jobs = [
    { id: 'job-0', jobName: '직력 영', startDate: '2000-01-01', endDate: '2005-01-01', workDaysPerYear: 250 },
    { id: 'job-1', jobName: '직력 일', startDate: '2005-01-01', endDate: '2010-01-01', workDaysPerYear: 250 },
    { id: 'job-2', jobName: '직력 이', startDate: '2010-01-01', endDate: '2015-01-01', workDaysPerYear: 250 },
  ];
  patient.data.shared.diagnoses = [{ id: 'dx-0', code: 'M77.1', name: '상병', side: 'right' }, { id: 'dx-1', code: 'M65.4', name: '상병2', side: 'left' }];
  patient.data.activeModules = activeModules;
  for (const id of activeModules) registry[id] = { computeCalc: () => calcByModule[id] };
  return patient;
}

beforeEach(() => { for (const key of Object.keys(registry)) delete registry[key]; });

const spineCalc = (over = {}) => ({
  mddmStatus: 'present', noEvaluableJobs: false, formulaVersion: 'v5.1.3', gender: 'male', maxForce: 3000,
  dailyDose: { dailyDoseKNh: 3.0 }, lifetimeDose: { lifetimeDoseMNh: 5, excluded: false, totalYears: 10 },
  comparison: { mddm: { limit: 25, percent: 20, status: 'safe' }, court: { limit: 12.5, percent: 40, status: 'safe' } },
  workRelatedness: { level: 'low', workContribution: 40, personalContribution: 60 },
  jobResults: [], vibration: null, ...over,
});

describe('척추 매핑', () => {
  it('작업의 일일 용량 포함 기준은 force >= 1900N 이다(calculateDailyDose와 같은 경계)', () => {
    const tasks = [1899, 1900, 1901].map((force, i) => ({ id: i, posture: 'G3', weight: 10, frequency: 10, timeValue: 5, timeUnit: 'sec', correctionFactor: 1, force }));
    const patient = patientWith(['spine'], { spine: spineCalc({ jobResults: [{ jobId: 'job-0', periodYears: 5, workDaysPerYear: 250, tasks, dailyDose: { dailyDoseKNh: 1 }, lifetimeDose: { lifetimeDoseMNh: 1, excluded: false } }] }) });
    const included = buildAiInput(patient).modules.spine.mddm.jobs[0].tasks.map((t) => t.included);
    expect(included).toEqual([false, true, true]);
  });

  it('중증도는 가중 일일 용량이 있으면 그것으로, 없으면 일일 용량으로 판정한다(보고서와 같은 입력)', () => {
    // 남성: 일일 > 8.0 이면 고도, < 4.0 이고 최대 힘 < 4000 이면 경도.
    const base = { maxForce: 3000, dailyDose: { dailyDoseKNh: 9.0 } };
    const without = buildAiInput(patientWith(['spine'], { spine: spineCalc(base) })).modules.spine.mddm.severity;
    const withWeighted = buildAiInput(patientWith(['spine'], { spine: spineCalc({ ...base, weightedDailyDose: { value: 1.0, aboveThreshold: false } }) })).modules.spine.mddm.severity;
    expect(without).toBe('high');
    expect(withWeighted).toBe('low');
  });

  it('직력별 평생 누적 제외 여부(lifetimeExcluded)를 옮긴다', () => {
    const jr = (jobId, excluded) => ({ jobId, periodYears: 5, workDaysPerYear: 250, tasks: [], dailyDose: { dailyDoseKNh: 1 }, lifetimeDose: { lifetimeDoseMNh: 0, excluded } });
    const patient = patientWith(['spine'], { spine: spineCalc({ jobResults: [jr('job-0', true), jr('job-2', false)] }) });
    const jobs = buildAiInput(patient).modules.spine.mddm.jobs;
    expect(jobs.map((j) => [j.jobIndex, j.lifetimeExcluded])).toEqual([[0, true], [2, false]]);
  });

  it('표 밖의 자세 코드·시간 단위는 null, 숫자 문자열은 숫자로 바꾼다', () => {
    const tasks = [{ posture: 'G99', weight: '12.5', frequency: '', timeValue: 'abc', timeUnit: 'day', correctionFactor: 1e12, force: NaN }];
    const patient = patientWith(['spine'], { spine: spineCalc({ jobResults: [{ jobId: 'job-0', periodYears: 5, workDaysPerYear: 250, tasks, dailyDose: {}, lifetimeDose: {} }] }) });
    const [task] = buildAiInput(patient).modules.spine.mddm.jobs[0].tasks;
    expect(task).toEqual({ posture: null, weightKg: 12.5, frequencyPerDay: null, timeValue: null, timeUnit: null, correctionFactor: null, forceN: null, included: false });
  });

  it('MDDM이 미평가·노출 없음이면 mddm을 만들지 않고, 비교값이 없어도 입력은 유효하다', () => {
    expect(buildAiInput(patientWith(['spine'], { spine: spineCalc({ mddmStatus: 'none' }) })).modules.spine).toEqual({ noEvaluableJobs: false, mddmStatus: 'none' });
    const noComparison = buildAiInput(patientWith(['spine'], { spine: spineCalc({ comparison: undefined }) })).modules.spine;
    expect(noComparison.mddmStatus).toBe('present');
    expect(noComparison.mddm).toBeUndefined();
  });

  it('전신진동: 노출이 없으면 비교·직력 값을 비우고, 있으면 범위·구간을 옮긴다', () => {
    const vib = (exposureStatus) => ({
      exposureStatus, amax8: { min: 0.4, max: 0.7 }, dv: { min: 900, max: 1500 },
      comparison: { daily: { percent: { min: 63, max: 111 }, status: 'warning' }, lifetime: { percent: { min: 64, max: 107 }, status: 'danger' } },
      validation: { hasInvalidIntervals: true },
      jobResults: [{ jobId: 'job-1', periodYears: 5, workDaysPerYear: 250, intervals: [{ awMin: '0.5', awMax: 0.8, timeValue: 4, timeUnit: 'hr', name: '비밀 구간명' }] }],
    });
    const none = buildAiInput(patientWith(['spine'], { spine: spineCalc({ mddmStatus: 'none', vibration: vib('none') }) })).modules.spine.vibration;
    expect(none).toMatchObject({ exposureStatus: 'none', amax8Min: null, daily: null, lifetime: null, jobs: [] });

    const present = buildAiInput(patientWith(['spine'], { spine: spineCalc({ mddmStatus: 'none', vibration: vib('present') }) })).modules.spine.vibration;
    expect(present.daily).toEqual({ percentMin: 63, percentMax: 111, status: 'warning' });
    expect(present.lifetime.status).toBe('danger');
    expect(present.hasInvalidIntervals).toBe(true);
    expect(present.jobs).toEqual([{ jobIndex: 1, periodYears: 5, workDaysPerYear: 250, intervals: [{ awMin: 0.5, awMax: 0.8, timeValue: 4, timeUnit: 'hr' }] }]);
    expect(JSON.stringify(present)).not.toContain('비밀 구간명');
  });
});

describe('팔꿈치·손목 매핑 — 합쳐진 그룹의 부담 등급', () => {
  // 같은 BK 유형의 두 진단. 대표 항목(채워진 필드가 더 많은 쪽)의 burdenGrade '경도'가 병합 후에도 남아 있지만,
  // 합쳐진 위험요인은 5개라 실제 등급은 '고도'다.
  const summary = (diagnosisId, riskKeys, burdenGrade, filledFields) => ({
    diagnosis: { id: diagnosisId },
    entry: { selectedBkType: 'BK2101', ...Object.fromEntries(Array.from({ length: filledFields }, (_, i) => [`f${i}`, 'x'])) },
    riskFactorItems: riskKeys.map((key) => ({ key })),
    flagItems: [],
    missingFields: [],
    riskFactorCount: riskKeys.length,
    burdenGrade,
  });
  const summaries = [
    summary('dx-0', ['core_exposure_present', 'daily_share_high'], '경도', 9),
    summary('dx-1', ['rest_unfavorable', 'mechanical_load_dominant', 'vibration_present'], '중등도', 3),
  ];
  const calc = (extra = {}) => ({
    noEvaluableJobs: false, temporalSequence: {}, temporalFlagItems: [], missingCommonFields: [],
    jobSummaries: [{ sharedJobId: 'job-0', diagnosisSummaries: summaries }], ...extra,
  });

  it.each([
    ['elbow', mergeElbow, getElbowBurdenGrade],
    ['wrist', mergeWrist, getWristBurdenGrade],
  ])('%s: 병합 결과의 옛 burdenGrade가 아니라 합쳐진 위험요인으로 등급을 다시 계산한다', (moduleId, merge, gradeOf) => {
    const merged = merge(summaries);
    const flags = Object.fromEntries(merged.riskFactorItems.map((item) => [item.key, true]));
    expect(merged.riskFactorCount).toBe(5);
    expect(merged.burdenGrade).toBe('경도'); // 병합이 남겨 둔 옛 값 — 이걸 그대로 쓰면 틀린다
    expect(gradeOf(5, flags)).toBe('고도');

    const patient = patientWith([moduleId], { [moduleId]: calc() });
    const group = buildAiInput(patient).modules[moduleId].jobs[0].groups[0];
    expect(group.riskFactorCount).toBe(5);
    expect(group.burdenGrade).toBe('high');
    expect(group.diagnosisRefs).toEqual([0, 1]);
  });

  it('표 밖의 BK 유형·위험요인 키·시간적 선후관계 값은 null/제외한다', () => {
    const odd = [{ ...summary('dx-0', ['core_exposure_present', 'evil_key', 'heavy_load_present'], '경도', 2), entry: { selectedBkType: 'BK9999', a: 'x' } }];
    const patient = patientWith(['elbow'], { elbow: calc({
      temporalSequence: { recent_task_change: '자유 입력', improves_with_rest: 'unclear' },
      temporalFlagItems: [{ key: 'temporal_fit_high' }, { key: 'not_a_flag' }],
      missingCommonFields: ['x'],
      jobSummaries: [{ sharedJobId: 'job-2', diagnosisSummaries: odd }],
    }) });
    const elbow = buildAiInput(patient).modules.elbow;
    expect(elbow.temporal).toEqual({ recentTaskChange: null, improvesWithRest: null, flags: ['temporal_fit_high'], hasMissingCommonFields: true });
    expect(elbow.jobs[0].jobIndex).toBe(2);
    expect(elbow.jobs[0].groups[0].bkType).toBeNull();
    expect(elbow.jobs[0].groups[0].riskFactorKeys).toEqual(['core_exposure_present']); // 경추 전용 키와 알 수 없는 키는 팔꿈치 목록 밖
  });

  it('손목 BK 유형 목록은 팔꿈치와 다르다(BK2113 허용, BK2105 제외)', () => {
    const one = (bk) => ({ ...summary('dx-0', ['core_exposure_present'], '경도', 2), entry: { selectedBkType: bk, a: 'x' } });
    const bkOf = (moduleId, bk) => buildAiInput(patientWith([moduleId], { [moduleId]: calc({ jobSummaries: [{ sharedJobId: 'job-0', diagnosisSummaries: [one(bk)] }] }) })).modules[moduleId].jobs[0].groups[0].bkType;
    expect(bkOf('wrist', 'BK2113')).toBe('BK2113');
    expect(bkOf('wrist', 'BK2105')).toBeNull();
    expect(bkOf('elbow', 'BK2105')).toBe('BK2105');
    expect(bkOf('elbow', 'BK2113')).toBeNull();
  });
});

describe('무릎·경추 매핑', () => {
  it('무릎: 직력 id가 shared.jobs에 없으면(구형식) jobIndex는 null이다 — 존재하지 않을 수 있는 위치를 지어내지 않는다', () => {
    const jobBurdens = [
      { id: 'job-2', weight: '1000', squatting: '30', burden: { level: '경도' } },
      { id: 'legacy-1', weight: '2000', squatting: '60', burden: { level: '중등도하' } },
      { weight: '500', squatting: '10', burden: { level: '경도' } }, // id 자체가 없는 구형식
    ];
    const patient = patientWith(['knee'], { knee: { noEvaluableJobs: false, relatedness: { min: '10.0', max: '20.0' }, cumulativeBurden: '불충분함', jobBurdens } });
    const input = buildAiInput(patient);
    const { jobs, relatedness } = input.modules.knee;
    expect(jobs.map((j) => j.jobIndex)).toEqual([2, null, null]); // id가 맞는 직력만 shared.jobs 위치
    expect(relatedness).toEqual({ minPct: 10, maxPct: 20, avgPct: 15 });
    // 연결되지 않은 직력도 프롬프트에서 번호를 만들어 내지 않고 그대로 밝힌다.
    expect(buildPrompt(input)).toContain('- 직력(직력 목록과 연결되지 않음): 일 중량물 취급량 2000kg');
  });

  it('항목 수 한도(직력 30)를 넘으면 잘라 내지 않고 거부한다 — 사유를 돌려준다', () => {
    const jobBurdens = Array.from({ length: 31 }, (_, i) => ({ id: `legacy-${i}`, weight: '1000', squatting: '30', burden: { level: '경도' } }));
    const patient = patientWith(['knee'], { knee: { noEvaluableJobs: false, relatedness: null, cumulativeBurden: '', jobBurdens } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = buildAiInputResult(patient);
    errorSpy.mockRestore();
    expect(result.input).toBeNull();
    expect(result.error).toContain('한도');
  });

  it('무릎: 알 수 없는 부담 등급·보조변수 값은 null/false다', () => {
    const jobBurdens = [{ id: 'job-0', weight: '', squatting: 'x', stairs: 'yes', kneeTwist: true, burden: { level: '알수없음' } }];
    const patient = patientWith(['knee'], { knee: { noEvaluableJobs: false, relatedness: null, cumulativeBurden: '', jobBurdens } });
    const { jobs, relatedness, cumulativeBurdenSufficient } = buildAiInput(patient).modules.knee;
    expect(relatedness).toBeNull();
    expect(cumulativeBurdenSufficient).toBe(false);
    expect(jobs[0]).toMatchObject({ weightKgPerDay: null, squattingMinPerDay: null, burdenLevel: null });
    expect(jobs[0].aux).toMatchObject({ stairs: false, kneeTwist: true }); // 불리언 true만 true
  });

  it('경추: 표 밖의 노출 유형·예/아니오 값은 걸러지고 자유 입력 필드(name·notes)는 옮기지 않는다', () => {
    const calc = { noEvaluableJobs: false, overallBurdenGrade: '자유문', overallCumulativeKgHours: 5, jobSummaries: [{
      sharedJobId: 'job-1', burdenGrade: 'present', flagItems: [{ key: 'daily_share_high' }, { key: 'x' }], riskFactorCount: 1,
      cumulativeKgHours: 3, representativeHours: 2, totalAwkwardHours: 1, yearsExposed: 4, totalTaskCount: 2, completedTaskCount: 1, hasBk2109CoreTask: false,
      taskSummaries: [{ name: '비밀 작업명', notes: '비밀 메모', exposure_types: ['x', 'shoulder_heavy_load', 'shoulder_heavy_load'], load_weight_kg: '30', forced_neck_posture: 'maybe', precision_work: 'yes' }],
    }] };
    const cervical = buildAiInput(patientWith(['cervical'], { cervical: calc })).modules.cervical;
    expect(cervical.overallBurdenGrade).toBeNull();
    expect(cervical.jobs[0].flagKeys).toEqual(['daily_share_high']);
    expect(cervical.jobs[0].tasks[0]).toEqual({
      exposureTypes: ['shoulder_heavy_load'], loadWeightKg: 30, carryHoursPerShift: null, neckNonNeutralHoursPerDay: null,
      forcedNeckPosture: null, combinedFlexionRotation: null, precisionWork: 'yes',
    });
    expect(JSON.stringify(cervical)).not.toContain('비밀');
  });
});

describe('검증 실패 처리', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => errorSpy.mockRestore());

  it('스키마를 통과하지 못하면 null을 돌려주고, 콘솔에는 경로와 코드만 남기며 값은 남기지 않는다', () => {
    const bad = spineCalc({ comparison: { mddm: { limit: 25, percent: 20, status: 'SECRET-상태값' }, court: { limit: 12.5, percent: 40, status: 'safe' } } });
    const patient = patientWith(['spine'], { spine: bad });
    expect(buildAiInput(patient)).toBeNull();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('modules.spine.mddm.comparison.mddm.status');
    expect(logged).not.toContain('SECRET');
  });

  it('원시 입력 빌더는 같은 환자에 대해 같은 결과를 검증 전에 돌려준다', () => {
    const patient = patientWith(['spine'], { spine: spineCalc({ comparison: { mddm: { limit: 25, percent: 20, status: 'bad' }, court: { limit: 1, percent: 1, status: 'safe' } } }) });
    expect(buildRawAiInput(patient).modules.spine.mddm.comparison.mddm.status).toBe('bad');
  });

  it('활성화되지 않은 모듈이나 계산기가 없는 모듈은 만들지 않는다', () => {
    const patient = patientWith(['knee'], { knee: { noEvaluableJobs: true, relatedness: null, cumulativeBurden: '', jobBurdens: [] } });
    patient.data.activeModules = ['knee', 'hip', 'wrist']; // hip: 계약 밖 모듈, wrist: 레지스트리에 없음
    expect(Object.keys(buildAiInput(patient).modules)).toEqual(['knee']);
  });
});

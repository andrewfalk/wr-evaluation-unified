import { describe, it, expect } from 'vitest';
import { computeSpineCalc, isSpineAssessmentComplete, isSpineDiagnosisComplete } from '../../../modules/spine/derived';
import {
  calculateCompressiveForce,
  calculateDailyDose,
  calculateLifetimeDose,
  classifySpineSeverity,
  getSpineTaskDoses,
  resolveMddmFormulaVersion,
  resolveMddmStatus,
} from '../../../modules/spine/mddm';
import { computeVibrationCalc, combineA8, isIntervalValid, jobDV, resolveVibrationStatus } from '../../../modules/spine/vibration';
import { SPINE_FORMULA_V513 } from '../../../modules/spine/constants';

const JOBS = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }];

describe('calculateCompressiveForce', () => {
  it('F = b + m * weight (보정계수 적용 category)', () => {
    // G1: b=800, m=45, applyCorrectionFactor:true
    const result = calculateCompressiveForce('G1', 15, 1.0);
    expect(result?.force).toBe(800 + 45 * 15);
  });

  it('보정계수 미적용 category(G7)는 correctionFactor를 무시한다', () => {
    const result = calculateCompressiveForce('G7', 10, 2.0);
    expect(result?.correctionFactor).toBe(1.0);
    expect(result?.force).toBe(800 + 95 * 10);
  });

  it('미인식 posture는 null을 반환한다', () => {
    expect(calculateCompressiveForce('G99', 15, 1.0)).toBeNull();
  });
});

describe('calculateDailyDose / calculateLifetimeDose', () => {
  it('v5.1.3과 legacy 공식은 서로 다른 값을 낸다(같은 입력)', () => {
    const tasks = [{ force: 2000, timeValue: 5, timeUnit: 'sec', frequency: 80 }];
    const v513 = calculateDailyDose(tasks, SPINE_FORMULA_V513);
    const legacy = calculateDailyDose(tasks, undefined);
    expect(v513.dailyDoseKNh).not.toBeCloseTo(legacy.dailyDoseKNh, 5);
  });

  it('일일선량이 임계치 미만이고 고하중 task가 없으면 lifetimeDose가 excluded', () => {
    const result = calculateLifetimeDose(0.1, 250, 10, 0, 'male', false, SPINE_FORMULA_V513);
    expect(result.excluded).toBe(true);
    expect(result.lifetimeDoseMNh).toBe(0);
  });

  it('workDaysPerYear가 문자열이어도(Number 변환 없이) 곱셈에 그대로 들어간다', () => {
    const result = calculateLifetimeDose(10, '250' as unknown as number, 10, 0, 'male', true, SPINE_FORMULA_V513);
    expect(result.lifetimeDoseKNh).toBeCloseTo(10 * 250 * 10);
  });

  it('careerYears가 문자열이면 totalYears 덧셈이 문자열 연결이 되어(계산 로직 재구현 금지) 다른 결과가 나온다', () => {
    // 원본은 careerYears + careerMonths/12를 그대로 쓴다 — careerYears가 문자열이면 +는
    // 숫자 덧셈이 아니라 문자열 연결이 된다('10' + 0 = '100', 10 + 0이 아님). 이건 원본의
    // 실제 동작(버그성이지만 재구현 금지 대상)이므로 그대로 재현되는지만 확인한다.
    const result = calculateLifetimeDose(10, 250, '10' as unknown as number, 0, 'male', true, SPINE_FORMULA_V513);
    expect(result.totalYears).toBe('100'); // '10' + 0 → 문자열 연결
    expect(result.lifetimeDoseKNh).toBeCloseTo(10 * 250 * 100); // *는 ToNumber('100')=100
  });
});

describe('classifySpineSeverity', () => {
  it('성별에 따라 기준이 다르다(같은 dailyKNh)', () => {
    expect(classifySpineSeverity(5, 0, 'female')).toBe('중등도상'); // female: d>4.5
    expect(classifySpineSeverity(5, 0, 'male')).toBe('중등도하'); // male: d>=4.0
  });
});

describe('getSpineTaskDoses', () => {
  it('v5.1.3은 합이 총량과 일치한다(합산 무결성)', () => {
    const tasks = [
      { force: 2000, timeValue: 5, timeUnit: 'sec', frequency: 80 },
      { force: 2500, timeValue: 3, timeUnit: 'sec', frequency: 60 },
    ];
    const doses = getSpineTaskDoses(tasks, SPINE_FORMULA_V513);
    const { dailyDoseKNh } = calculateDailyDose(tasks, SPINE_FORMULA_V513);
    expect(doses.reduce((a, b) => a + b, 0)).toBeCloseTo(dailyDoseKNh);
  });

  it('임계치 미만 task는 기여도 0', () => {
    const doses = getSpineTaskDoses([{ force: 100, timeValue: 5, timeUnit: 'sec', frequency: 80 }], SPINE_FORMULA_V513);
    expect(doses[0]).toBe(0);
  });
});

describe('resolveMddmFormulaVersion (formulaPolicy 디스패처, §2.3)', () => {
  it('recompute_current은 항상 v5.1.3으로 강제한다', () => {
    expect(resolveMddmFormulaVersion({ formulaVersion: undefined }, 'recompute_current')).toBe(SPINE_FORMULA_V513);
    expect(resolveMddmFormulaVersion({ formulaVersion: 'legacy-marker' }, 'recompute_current')).toBe(SPINE_FORMULA_V513);
  });

  it('recompute_recorded_version(기본값)은 저장된 값을 그대로 쓴다', () => {
    expect(resolveMddmFormulaVersion({ formulaVersion: undefined })).toBeUndefined();
    expect(resolveMddmFormulaVersion({ formulaVersion: SPINE_FORMULA_V513 })).toBe(SPINE_FORMULA_V513);
  });
});

describe('resolveMddmStatus', () => {
  it('mddmStatus가 명시되어 있으면 그대로 반환', () => {
    expect(resolveMddmStatus({ mddmStatus: 'none' })).toBe('none');
  });

  it('evalMethod=wbv면 task가 있어도 unknown(1차 WBV 환자 보존)', () => {
    expect(resolveMddmStatus({ evalMethod: 'wbv', tasks: [{}] })).toBe('unknown');
  });

  it('tasks가 있으면 present(구형식 호환)', () => {
    expect(resolveMddmStatus({ tasks: [{}] })).toBe('present');
  });

  it('아무 것도 없으면 unknown', () => {
    expect(resolveMddmStatus({})).toBe('unknown');
  });
});

describe('computeSpineCalc — MDDM/WBV 통합', () => {
  it('mddmStatus·vibration이 top-level에 함께 노출된다', () => {
    const result = computeSpineCalc({ shared: { jobs: [], diagnoses: [] }, module: {}, activeModules: ['spine'] });
    expect(result.mddmStatus).toBe('unknown');
    expect(result.vibration.exposureStatus).toBe('unknown');
  });

  it('formulaPolicy: recompute_current을 넘기면 formulaVersion이 강제로 v5.1.3', () => {
    const result = computeSpineCalc(
      {
        shared: { jobs: JOBS, gender: 'male', diagnoses: [] },
        module: { mddmStatus: 'present', tasks: [{ sharedJobId: 'job-1', posture: 'G3', weight: 30, frequency: 80, timeValue: 5, timeUnit: 'sec', correctionFactor: 1 }] },
        activeModules: ['spine'],
      },
      { formulaPolicy: 'recompute_current' },
    );
    expect(result.formulaVersion).toBe(SPINE_FORMULA_V513);
  });
});

describe('isSpineDiagnosisComplete', () => {
  it('spine 진단이 없으면 false', () => {
    expect(isSpineDiagnosisComplete({ shared: { diagnoses: [] }, activeModules: ['spine'] })).toBe(false);
  });

  it('assessmentRight=low인데 reasonRight가 비어있으면 false', () => {
    expect(
      isSpineDiagnosisComplete({
        shared: { diagnoses: [{ id: 'dx-1', code: 'M51', moduleId: 'spine', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: [] }] },
        activeModules: ['spine'],
      }),
    ).toBe(false);
  });
});

describe('isSpineAssessmentComplete', () => {
  it('MDDM unknown + WBV unknown이면 false', () => {
    expect(
      isSpineAssessmentComplete({
        shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'M51', moduleId: 'spine', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
        module: {},
        activeModules: ['spine'],
      }),
    ).toBe(false);
  });

  it('MDDM unknown이어도 WBV present(유효)면 true', () => {
    expect(
      isSpineAssessmentComplete({
        shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'M51', moduleId: 'spine', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
        module: {
          vibrationExposureStatus: 'present',
          vibrationIntervals: [{ sharedJobId: 'job-1', awMin: 1, awMax: 1.5, timeValue: 4, timeUnit: 'hr' }],
        },
        activeModules: ['spine'],
      }),
    ).toBe(true);
  });
});

describe('WBV(vibration.ts) helper', () => {
  it('isIntervalValid — awMax<awMin이면 무효', () => {
    expect(isIntervalValid({ awMin: 2, awMax: 1, timeValue: 4, timeUnit: 'hr' })).toBe(false);
  });

  it('combineA8 — 에너지합 방식으로 여러 구간을 합산한다', () => {
    const single = combineA8([{ awMax: 1, awMin: 1, timeValue: 8, timeUnit: 'hr' }], 'max');
    expect(single).toBeCloseTo(1); // 8시간 노출이면 A(8)=aw 그대로
  });

  it('jobDV — 일일 게이트(0.63) 미만이면 0', () => {
    expect(jobDV(0.5, 250, 10)).toBe(0);
  });

  it('jobDV — workDaysPerYear가 문자열이어도(Number 변환 없이) 산술에 들어간다', () => {
    const dv = jobDV(1.0, '250' as unknown as number, 10);
    expect(dv).toBeCloseTo(1.0 * 1.0 * 250 * 10);
  });

  it('resolveVibrationStatus — 명시값 우선, 없으면 evalMethod=wbv+구간 보존', () => {
    expect(resolveVibrationStatus({ vibrationExposureStatus: 'present' })).toBe('present');
    expect(resolveVibrationStatus({ evalMethod: 'wbv', vibrationIntervals: [{}] })).toBe('present');
    expect(resolveVibrationStatus({})).toBe('unknown');
  });

  it('computeVibrationCalc — status가 present가 아니면 안전 기본값(모든 필드 채워짐)', () => {
    const result = computeVibrationCalc({ shared: {}, module: { vibrationExposureStatus: 'unknown' } });
    expect(result.noExposure).toBe(true);
    expect(result.amax8).toEqual({ min: 0, max: 0 });
  });
});

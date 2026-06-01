import { describe, expect, it } from 'vitest';
import {
  intervalA8,
  combineA8,
  jobDV,
  computeVibrationCalc,
  isVibrationComplete,
} from '../vibrationCalc';
import { computeSpineCalc, isSpineAssessmentComplete } from '../calculations';

// --- 헬퍼 ---
function makeInterval(overrides = {}) {
  return {
    id: Math.random(),
    name: '진동작업',
    awMin: 0.7,
    awMax: 0.7,
    timeValue: 8,
    timeUnit: 'hr',
    sharedJobId: '',
    ...overrides,
  };
}

function makeJob(id, overrides = {}) {
  return {
    id,
    jobName: `직업${id}`,
    workPeriodOverride: '16년',
    workDaysPerYear: 220,
    ...overrides,
  };
}

function makePatient({
  jobs = [],
  intervals = [],
  gender = 'male',
  diagnoses = [],
  exposureStatus = 'present',   // WBV 기본: 노출있음 (기존 케이스가 실제 계산 경로를 타도록)
  mddmStatus = 'present',
  tasks,
} = {}) {
  const module = { vibrationExposureStatus: exposureStatus, mddmStatus, vibrationIntervals: intervals };
  if (tasks !== undefined) module.tasks = tasks;
  return {
    shared: { gender, jobs, diagnoses },
    module,
    activeModules: ['spine'],
  };
}

// --- 1. 단일 구간 A(8) ---
describe('intervalA8 — 단일 구간', () => {
  it('aw=1.0, 8시간 → 1.0', () => {
    expect(intervalA8(1.0, 8, 'hr')).toBeCloseTo(1.0, 6);
  });
  it('aw=1.0, 2시간 → sqrt(2/8)=0.5', () => {
    expect(intervalA8(1.0, 2, 'hr')).toBeCloseTo(0.5, 6);
  });
  it('aw 또는 시간이 0이면 0', () => {
    expect(intervalA8(0, 8, 'hr')).toBe(0);
    expect(intervalA8(1.0, 0, 'hr')).toBe(0);
  });
});

// --- 2. 다구간 에너지합 ---
describe('combineA8 — 다구간 에너지합', () => {
  it('aw=1.0@4h + aw=1.0@4h → sqrt((4+4)/8)=1.0', () => {
    const ivs = [
      makeInterval({ awMin: 1.0, awMax: 1.0, timeValue: 4, timeUnit: 'hr' }),
      makeInterval({ awMin: 1.0, awMax: 1.0, timeValue: 4, timeUnit: 'hr' }),
    ];
    expect(combineA8(ivs, 'min')).toBeCloseTo(1.0, 6);
    expect(combineA8(ivs, 'max')).toBeCloseTo(1.0, 6);
  });
  it('일반식 sqrt((aw1²T1+aw2²T2)/8)', () => {
    const ivs = [
      makeInterval({ awMax: 0.8, timeValue: 6, timeUnit: 'hr' }),
      makeInterval({ awMax: 1.2, timeValue: 2, timeUnit: 'hr' }),
    ];
    const expected = Math.sqrt((0.8 * 0.8 * 6 + 1.2 * 1.2 * 2) / 8);
    expect(combineA8(ivs, 'max')).toBeCloseTo(expected, 6);
  });
});

// --- 3. DV 0.63 게이트 ---
describe('jobDV — 0.63 게이트', () => {
  it('Amax(8)=0.5 → 0 (게이트 미만)', () => {
    expect(jobDV(0.5, 220, 16)).toBe(0);
  });
  it('Amax(8)=0.7 → 0.49·220·16 > 0', () => {
    expect(jobDV(0.7, 220, 16)).toBeCloseTo(0.49 * 220 * 16, 6);
  });
});

// --- 6. 문서 예시: jobDV(0.63, 220, 16) = 0.3969·3520 = 1397.088 (≈1400) ---
describe('jobDV — 문서 예시 (≈1400 도달)', () => {
  it('0.63²·220·16 = 1397.088', () => {
    expect(jobDV(0.63, 220, 16)).toBeCloseTo(1397.088, 2);
  });
});

// --- 4. 범위 하한/상한 ---
describe('computeVibrationCalc — 범위 하한/상한', () => {
  it('awMin 0.5 / awMax 0.9 → amax8.min≈0.5, max≈0.9, dv.min=0, dv.max>0', () => {
    const job = makeJob('j1');
    const calc = computeVibrationCalc(makePatient({
      jobs: [job],
      intervals: [makeInterval({ awMin: 0.5, awMax: 0.9, timeValue: 8, timeUnit: 'hr', sharedJobId: 'j1' })],
    }));
    expect(calc.amax8.min).toBeCloseTo(0.5, 6);
    expect(calc.amax8.max).toBeCloseTo(0.9, 6);
    expect(calc.dv.min).toBe(0);        // 0.5 < 0.63 게이트
    expect(calc.dv.max).toBeGreaterThan(0);
  });
});

// --- 5. 1400 걸침 status ---
describe('comparison.lifetime.status — 1400 경계 (>=)', () => {
  it('dv.min<1400<dv.max → warning', () => {
    // awMax=0.7로 16년·220일이면 DV=0.49·3520=1724.8 (>1400),
    // awMin=0.5는 게이트 미만 → dv.min=0
    const calc = computeVibrationCalc(makePatient({
      jobs: [makeJob('j1')],
      intervals: [makeInterval({ awMin: 0.5, awMax: 0.7, sharedJobId: 'j1' })],
    }));
    expect(calc.dv.min).toBeLessThan(1400);
    expect(calc.dv.max).toBeGreaterThanOrEqual(1400);
    expect(calc.comparison.lifetime.status).toBe('warning');
  });
  it('둘 다 초과 → danger', () => {
    const calc = computeVibrationCalc(makePatient({
      jobs: [makeJob('j1')],
      intervals: [makeInterval({ awMin: 0.7, awMax: 0.7, sharedJobId: 'j1' })],
    }));
    expect(calc.dv.min).toBeGreaterThanOrEqual(1400);
    expect(calc.comparison.lifetime.status).toBe('danger');
  });
  it('둘 다 미만 → safe (dv.max<1400)', () => {
    // 짧은 근속(1년)이면 0.7²·220·1=107.8 < 1400
    const calc = computeVibrationCalc(makePatient({
      jobs: [makeJob('j1', { workPeriodOverride: '1년' })],
      intervals: [makeInterval({ awMin: 0.7, awMax: 0.7, sharedJobId: 'j1' })],
    }));
    expect(calc.dv.max).toBeLessThan(1400);
    expect(calc.comparison.lifetime.status).toBe('safe');
  });
  it('일일 0.63 경계: amax8.max>=0.63 && min<0.63 → daily warning', () => {
    const calc = computeVibrationCalc(makePatient({
      jobs: [makeJob('j1')],
      intervals: [makeInterval({ awMin: 0.5, awMax: 0.7, sharedJobId: 'j1' })],
    }));
    expect(calc.comparison.daily.status).toBe('warning');
  });
});

// --- 5b. 다중 직업 집계: Amax는 직업별 최대, DV는 합산 ---
describe('computeVibrationCalc — 다중 직업 집계', () => {
  it('amax8.max=max(job별), dv.max=합산', () => {
    const calc = computeVibrationCalc(makePatient({
      jobs: [
        makeJob('j1', { workPeriodOverride: '10년' }),
        makeJob('j2', { workPeriodOverride: '6년' }),
      ],
      intervals: [
        makeInterval({ awMin: 0.7, awMax: 0.8, timeValue: 8, timeUnit: 'hr', sharedJobId: 'j1' }),
        makeInterval({ awMin: 0.7, awMax: 1.0, timeValue: 8, timeUnit: 'hr', sharedJobId: 'j2' }),
      ],
    }));
    const j1 = calc.jobResults.find(j => j.jobId === 'j1');
    const j2 = calc.jobResults.find(j => j.jobId === 'j2');
    // Amax는 동시 에너지합이 아니라 직업별 최대
    expect(calc.amax8.max).toBeCloseTo(Math.max(j1.amax8.max, j2.amax8.max), 6);
    expect(calc.amax8.min).toBeCloseTo(Math.max(j1.amax8.min, j2.amax8.min), 6);
    // DV는 직업 간 합산
    expect(calc.dv.max).toBeCloseTo(j1.dv.max + j2.dv.max, 4);
  });
});

// --- 7. E2E ---
describe('computeVibrationCalc — E2E', () => {
  it('직업 1개(16년·220일) + 구간 1개 → 키 검증, DV가 1400 걸침', () => {
    const calc = computeVibrationCalc(makePatient({
      jobs: [makeJob('j1')],
      intervals: [makeInterval({ awMin: 0.5, awMax: 0.7, sharedJobId: 'j1' })],
    }));
    expect(calc.evalMethod).toBe('wbv');
    expect(calc).toHaveProperty('amax8.min');
    expect(calc).toHaveProperty('dv.max');
    expect(calc).toHaveProperty('comparison.lifetime.status');
    expect(calc).toHaveProperty('risk.level');
    expect(calc.dv.min).toBeLessThan(1400);
    expect(calc.dv.max).toBeGreaterThanOrEqual(1400);
  });
});

// --- 8. computeSpineCalc 공존 (MDDM top-level + vibration 서브객체) ---
describe('computeSpineCalc 공존', () => {
  it('top-level에 MDDM(maxForce·mddmStatus), calc.vibration에 WBV', () => {
    const calc = computeSpineCalc(makePatient({
      jobs: [makeJob('j1')],
      intervals: [makeInterval({ sharedJobId: 'j1' })],
    }));
    // top-level은 MDDM 평탄 필드 (evalMethod 없음)
    expect(calc).toHaveProperty('maxForce');
    expect(calc).not.toHaveProperty('evalMethod');
    expect(calc.mddmStatus).toBe('present');
    // WBV는 서브객체
    expect(calc.vibration.evalMethod).toBe('wbv');
    expect(calc.vibration).toHaveProperty('amax8.min');
  });
});

// --- 9. invalid 구간 ---
describe('invalid 구간 (awMin>awMax)', () => {
  it('valid 구간만 계산, validation 플래그, 완료 불가', () => {
    const patient = makePatient({
      jobs: [makeJob('j1')],
      intervals: [
        makeInterval({ awMin: 0.7, awMax: 0.7, sharedJobId: 'j1' }),       // valid
        makeInterval({ id: 999, name: '뒤집힌구간', awMin: 0.9, awMax: 0.5, sharedJobId: 'j1' }), // invalid
      ],
      diagnoses: [], // 상병 없음
    });
    const calc = computeVibrationCalc(patient);
    expect(calc.validation.hasInvalidIntervals).toBe(true);
    expect(calc.validation.invalidIntervals.some(iv => iv.id === 999)).toBe(true);
    expect(calc.validation.messages.length).toBeGreaterThan(0);
    // valid 구간만 계산에 포함
    expect(calc.intervals.length).toBe(1);
    // invalid가 있으면 완료 불가
    expect(isVibrationComplete(patient)).toBe(false);
    expect(isSpineAssessmentComplete(patient)).toBe(false);
  });
});

// --- 10. 빈 직업 ---
describe('빈 직업', () => {
  it('jobs=[] → jobResults=[], dv=0, 완료 false', () => {
    const patient = makePatient({ jobs: [], intervals: [makeInterval()] });
    const calc = computeVibrationCalc(patient);
    expect(calc.jobResults).toEqual([]);
    expect(calc.dv.min).toBe(0);
    expect(calc.dv.max).toBe(0);
    expect(isVibrationComplete(patient)).toBe(false);
  });
});

// --- 11. 고아 sharedJobId ---
describe('고아 sharedJobId (삭제된 직업)', () => {
  it('존재하지 않는 직업을 가리키는 구간은 첫 직업에 귀속되어 계산됨', () => {
    const calc = computeVibrationCalc(makePatient({
      jobs: [makeJob('j1')],
      intervals: [makeInterval({ awMin: 0.7, awMax: 0.7, sharedJobId: 'deleted-job' })],
    }));
    // 고아 구간이 첫 직업(j1)에 귀속되어 DV가 0이 아님
    const j1 = calc.jobResults.find(j => j.jobId === 'j1');
    expect(j1.intervals.length).toBe(1);
    expect(calc.dv.max).toBeGreaterThan(0);
  });
});

// --- 12. WBV 3상태 ---
describe('전신진동 3상태 (exposureStatus)', () => {
  it("'unknown' → noExposure, risk '미실시', isVibrationComplete false", () => {
    const patient = makePatient({ jobs: [makeJob('j1')], intervals: [], exposureStatus: 'unknown' });
    const calc = computeVibrationCalc(patient);
    expect(calc.noExposure).toBe(true);
    expect(calc.exposureStatus).toBe('unknown');
    expect(calc.dv).toEqual({ min: 0, max: 0 });
    expect(calc.comparison.lifetime.status).toBe('safe');
    expect(calc.risk.description).toContain('미실시');
    expect(isVibrationComplete(patient)).toBe(false);
  });
  it("'none' → noExposure, risk '노출 없음', isVibrationComplete true (구간·직업 없이)", () => {
    const patient = makePatient({ jobs: [], intervals: [], exposureStatus: 'none' });
    const calc = computeVibrationCalc(patient);
    expect(calc.noExposure).toBe(true);
    expect(calc.exposureStatus).toBe('none');
    expect(calc.risk.description).toContain('노출 없음');
    expect(isVibrationComplete(patient)).toBe(true);
  });
  it("필드 미정의(구형 module) → unknown", () => {
    const calc = computeVibrationCalc({ shared: { gender: 'male', jobs: [] }, module: {} });
    expect(calc.exposureStatus).toBe('unknown');
    expect(calc.noExposure).toBe(true);
  });
});

// --- 13. 통합 완료 판정 (OR + 상병) ---
describe('isSpineAssessmentComplete — (MDDM || WBV) && 상병', () => {
  const dx = [{ id: 'd1', moduleId: 'spine', confirmedRight: true, assessmentRight: 'high' }];

  it('상병 + MDDM present(작업+근속) + WBV unknown → true', () => {
    const patient = makePatient({
      jobs: [makeJob('j1')], diagnoses: dx,
      mddmStatus: 'present', tasks: [{ posture: 'G1', weight: 15, frequency: 80, timeValue: 5, timeUnit: 'sec', sharedJobId: 'j1' }],
      exposureStatus: 'unknown', intervals: [],
    });
    expect(isSpineAssessmentComplete(patient)).toBe(true);
  });
  it('상병 + WBV none + MDDM unknown(작업 없음) → true', () => {
    const patient = makePatient({
      jobs: [makeJob('j1')], diagnoses: dx,
      mddmStatus: 'unknown', tasks: [],
      exposureStatus: 'none', intervals: [],
    });
    expect(isSpineAssessmentComplete(patient)).toBe(true);
  });
  it('상병 + 둘 다 unknown → false', () => {
    const patient = makePatient({
      jobs: [makeJob('j1')], diagnoses: dx,
      mddmStatus: 'unknown', tasks: [], exposureStatus: 'unknown', intervals: [],
    });
    expect(isSpineAssessmentComplete(patient)).toBe(false);
  });
  it('상병 없음 → false', () => {
    const patient = makePatient({
      jobs: [makeJob('j1')], diagnoses: [],
      mddmStatus: 'none', exposureStatus: 'none',
    });
    expect(isSpineAssessmentComplete(patient)).toBe(false);
  });
});

// --- 14. legacy evalMethod:'wbv' 마이그레이션 (양방향 회귀 방지) ---
describe('legacy evalMethod:wbv 마이그레이션', () => {
  it('① 기본 task 있어도 MDDM은 unknown으로 (present 오인 안 함)', () => {
    const patient = {
      shared: { gender: 'male', jobs: [makeJob('j1')], diagnoses: [] },
      module: { evalMethod: 'wbv', tasks: [{ posture: 'G1', weight: 15 }] }, // mddmStatus 없음
      activeModules: ['spine'],
    };
    const calc = computeSpineCalc(patient);
    expect(calc.mddmStatus).toBe('unknown');
  });
  it('② intervals 있으면 WBV는 present로 보존', () => {
    const patient = {
      shared: { gender: 'male', jobs: [makeJob('j1')], diagnoses: [] },
      module: { evalMethod: 'wbv', vibrationIntervals: [makeInterval({ sharedJobId: 'j1' })] }, // status 없음
      activeModules: ['spine'],
    };
    const calc = computeSpineCalc(patient);
    expect(calc.vibration.exposureStatus).toBe('present');
    expect(calc.vibration.amax8.max).toBeGreaterThan(0);
  });
});

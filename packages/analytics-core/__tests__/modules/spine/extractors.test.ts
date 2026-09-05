import { describe, it, expect } from 'vitest';
import { extractSpineMddmLifetimeDoseMNh, extractSpineVibrationDvMax } from '../../../modules/spine/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

const JOBS = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }];

const HEAVY_TASK = {
  sharedJobId: 'job-1',
  name: '중량물 취급',
  posture: 'G3',
  weight: 30,
  frequency: 80,
  timeValue: 5,
  timeUnit: 'sec',
  correctionFactor: 1.0,
};

function baseCase(overrides: {
  jobs?: unknown[];
  diagnoses?: unknown[];
  spineModule?: Record<string, unknown>;
  activeModules?: string[];
  includeSpineModule?: boolean;
}) {
  const {
    jobs = JOBS,
    diagnoses = [],
    spineModule = {},
    activeModules = ['spine'],
    includeSpineModule = true,
  } = overrides;
  return {
    data: {
      shared: { jobs, diagnoses, gender: 'male' },
      modules: includeSpineModule ? { spine: spineModule } : {},
      activeModules,
    },
  };
}

describe('extractSpineMddmLifetimeDoseMNh — 우선순위 사슬(§1-1a)', () => {
  it('순서 1: 모듈이 activeModules에 없으면 structural_missing', () => {
    const result = extractSpineMddmLifetimeDoseMNh(migrate(baseCase({ activeModules: [] })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 1: data.modules.spine이 plain object가 아니면 structural_missing', () => {
    const result = extractSpineMddmLifetimeDoseMNh(migrate(baseCase({ includeSpineModule: false })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 2: mddmStatus가 unknown이면 not_assessed', () => {
    const result = extractSpineMddmLifetimeDoseMNh(migrate(baseCase({ spineModule: {} })));
    expect(result).toEqual({ value: null, missing: 'not_assessed', qualityFlags: [] });
  });

  it('순서 2: mddmStatus가 none이면 not_applicable', () => {
    const result = extractSpineMddmLifetimeDoseMNh(migrate(baseCase({ spineModule: { mddmStatus: 'none' } })));
    expect(result).toEqual({ value: null, missing: 'not_applicable', qualityFlags: [] });
  });

  it('순서 3: present인데 일일선량이 임계치 미달이면(lifetimeDose.excluded) not_entered', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [{ ...HEAVY_TASK, weight: 1, posture: 'G1' }] } })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 4: 정상 입력 — 압박력 임계치 초과 시 양의 MN·h 값', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [HEAVY_TASK] } })),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual([]);
    expect(result.value).toBeGreaterThan(0);
  });

  // posture/weight 단독 오류는 그 task의 force를 0(또는 NaN)으로 만들어 임계치 미달로
  // lifetimeDose 자체가 excluded(순서 3, not_entered)될 수 있다 — qualityFlags는 missing===
  // null인 "정상 계산" 경로에서만 채워지는 게 이 PR 전체의 관례(shoulder/elbow/wrist와 동일)
  // 이므로, 정상 계산에 도달하도록 유효한 HEAVY_TASK를 함께 넣어 관찰한다.
  it('순서 3b: posture가 formulaDB에 없는 값이면 invalid qualityFlag(그 task의 값은 force=0으로 흘러감)', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [HEAVY_TASK, { ...HEAVY_TASK, posture: 'G99' }] } })),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('순서 3b: weight가 비숫자 문자열이면 invalid qualityFlag', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [HEAVY_TASK, { ...HEAVY_TASK, weight: 'abc' }] } })),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('순서 3b: timeUnit이 인식 불가능한 값이면 invalid qualityFlag(조용히 초 취급되는 걸 관찰)', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [{ ...HEAVY_TASK, timeUnit: 'day' }] } })),
    );
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('순서 3b: job 근무기간이 파싱 불가능(NaN)하면 invalid qualityFlag + 최종 NaN 가드로 not_entered', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: 'abc', endDate: '2020-01-01', workDaysPerYear: 250 }];
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ jobs, spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [HEAVY_TASK] } })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  // §리뷰 지적(2026-09-05): 직력(shared.jobs)이 아예 없고 구형식 careerYears/workDaysPerYear
  // 도 없는데, 임계치를 넘는 task가 있으면 getCareerFromSharedJobs가 totalYears를 조용히
  // 0으로 채워 lifetimeDoseMNh=0이 "정상 계산"처럼 나왔다(excluded=false, flag 없음).
  it('순서 3: 직력도 구형식 근속정보도 전혀 없으면 not_entered(근속기간 측정 불가)', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ jobs: [], spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [HEAVY_TASK] } })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  // §리뷰 지적(2026-09-06): hasLegacyFields는 workDaysPerYear 단독 입력만으로도 true가
  // 되므로, careerYears/careerMonths가 둘 다 없는데도 "구형 근속정보 있음"으로 오판해
  // legacy 분기(mod.careerYears||0 = 0)가 totalYears=0을 조용히 만들어 정상값 0을
  // 냈다(직전 픽스가 hasLegacyFields만 보고 완전히 막지 못한 경로).
  it('순서 3: workDaysPerYear만 있고 careerYears/careerMonths가 둘 다 없으면 not_entered(근속기간 측정 불가)', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(baseCase({ jobs: [], spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', workDaysPerYear: 250, tasks: [HEAVY_TASK] } })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  // §리뷰 지적(2026-09-06, 경계 사례): 위 픽스가 `!== undefined`만 검사해 careerYears가
  // ''나 null이어도(둘 다 undefined는 아니므로) "기간 있음"으로 오판했다. 또한
  // careerMonths만 단독으로 있으면 careerYears/workDaysPerYear가 둘 다 없어 hasLegacyFields
  // 자체가 false가 되어 mddm.ts가 getCareerFromSharedJobs로 가버리므로 careerMonths는
  // 계산기가 전혀 읽지 않는 죽은 필드다 — 이 경우도 not_entered여야 한다.
  it('순서 3(경계): workDaysPerYear+careerYears가 빈 문자열이면 not_entered(blank는 실제 입력이 아님)', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(
        baseCase({
          jobs: [],
          spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', workDaysPerYear: 250, careerYears: '', tasks: [HEAVY_TASK] },
        }),
      ),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3(경계): workDaysPerYear+careerYears가 null이면 not_entered', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(
        baseCase({
          jobs: [],
          spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', workDaysPerYear: 250, careerYears: null, tasks: [HEAVY_TASK] },
        }),
      ),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3(경계): careerMonths만 단독으로 있으면 not_entered(hasLegacyFields=false라 계산기가 읽지 않는 죽은 필드)', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(
        baseCase({
          jobs: [],
          spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', careerMonths: 6, tasks: [HEAVY_TASK] },
        }),
      ),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3(경계): careerYears가 명시적 0이고 careerMonths=6이면 blank가 아니므로 정상 계산된다', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(
        baseCase({
          jobs: [],
          spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', workDaysPerYear: 250, careerYears: 0, careerMonths: 6, tasks: [HEAVY_TASK] },
        }),
      ),
    );
    expect(result.missing).toBeNull();
    expect(result.value).toBeGreaterThan(0);
  });

  it('순서 3: 직력이 없어도 구형식 careerYears가 있으면 legacy 분기로 정상 계산된다', () => {
    const result = extractSpineMddmLifetimeDoseMNh(
      migrate(
        baseCase({
          jobs: [],
          spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', careerYears: 10, careerMonths: 0, workDaysPerYear: 250, tasks: [HEAVY_TASK] },
        }),
      ),
    );
    expect(result.missing).toBeNull();
    expect(result.value).toBeGreaterThan(0);
  });

  it('배열 원소 방어: shared.jobs/diagnoses/modules.spine.tasks에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractSpineMddmLifetimeDoseMNh(
        migrate(
          baseCase({
            jobs: [null, ...JOBS] as unknown[],
            diagnoses: [null, { id: 'dx-1', code: 'M51', moduleId: 'spine' }] as unknown[],
            spineModule: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [null, HEAVY_TASK] as unknown[] },
          }),
        ),
      ),
    ).not.toThrow();
  });
});

describe('extractSpineVibrationDvMax — 우선순위 사슬(§1-1a)', () => {
  const VALID_INTERVAL = { sharedJobId: 'job-1', name: '해머드릴', awMin: 1.0, awMax: 1.5, timeValue: 4, timeUnit: 'hr' };

  it('순서 1: 모듈이 activeModules에 없으면 structural_missing', () => {
    const result = extractSpineVibrationDvMax(migrate(baseCase({ activeModules: [] })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 2: vibrationExposureStatus가 unknown이면 not_assessed', () => {
    const result = extractSpineVibrationDvMax(migrate(baseCase({ spineModule: {} })));
    expect(result).toEqual({ value: null, missing: 'not_assessed', qualityFlags: [] });
  });

  it('순서 2: vibrationExposureStatus가 none이면 not_applicable', () => {
    const result = extractSpineVibrationDvMax(migrate(baseCase({ spineModule: { vibrationExposureStatus: 'none' } })));
    expect(result).toEqual({ value: null, missing: 'not_applicable', qualityFlags: [] });
  });

  it('순서 3: present인데 유효 구간이 0개면 not_entered', () => {
    const result = extractSpineVibrationDvMax(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [] } })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  // §리뷰 지적(2026-09-05): 유효 구간은 있는데 shared.jobs가 아예 없으면
  // groupIntervalsByJob(vibration.ts)이 구간을 어느 job에도 배정하지 못해 jobResults가
  // 비고 dv.max가 "정상 계산된 0"으로 나왔다(직력이 있는 동일 구간과 값이 달라야 정상).
  it('순서 3: 유효 구간은 있는데 직력이 없으면 not_entered(직력 없이는 dv를 측정할 수 없음)', () => {
    const result = extractSpineVibrationDvMax(
      migrate(baseCase({ jobs: [], spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [VALID_INTERVAL] } })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 4: 정상 입력 — 유효 구간이 있으면 양의 dv 값', () => {
    const result = extractSpineVibrationDvMax(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [VALID_INTERVAL] } })),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual([]);
    expect(result.value).toBeGreaterThan(0);
  });

  it('순서 5: 유효하지 않은 구간이 섞여 있으면(유효 구간은 있음) invalid qualityFlag를 붙이되 유효 구간만으로 계산', () => {
    const invalidInterval = { sharedJobId: 'job-1', name: '무효구간', awMin: 0, awMax: 0, timeValue: 4, timeUnit: 'hr' };
    const result = extractSpineVibrationDvMax(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [VALID_INTERVAL, invalidInterval] } })),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
    expect(result.value).toBeGreaterThan(0);
  });

  it('배열 원소 방어: modules.spine.vibrationIntervals에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractSpineVibrationDvMax(
        migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [null, VALID_INTERVAL] } })),
      ),
    ).not.toThrow();
  });
});

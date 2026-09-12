import { describe, it, expect } from 'vitest';
import {
  extractSpineMddmLifetimeDoseMNh,
  extractSpineVibrationDvMax,
  extractSpineVibrationIntervalA8Max,
  extractSpineVibrationIntervalExposureHours,
  extractSpineDiagnosisVerticalDistribution,
  extractSpineDiagnosisConcomitantSpondylosis,
  extractSpineTaskWeightKg,
  extractSpineTaskFrequencyPerDay,
} from '../../../modules/spine/extractors';
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

// PR0-B3 Part A — vibration_interval grain 계약 증명. enumerateVibrationIntervalEntities가
// 만든 canonical 목록을 1:1 map()으로 순회하는지, entity.source를 재조회 없이 쓰는지를
// 실측한다.
//
// 2차 리뷰(2026-09-12) 지적 반영 — VALID_INTERVAL은 이제 vibrationExposureStatus:'present'를
// 명시한다. baseCase 기본값(spineModule:{})만으로는 resolveVibrationStatus()가 'unknown'을
// 반환해(evalMethod!=='wbv') 모든 계산 테스트가 실제로는 "미평가" 분기를 타고 있었다 —
// 상태를 확인하지 않던 버그가 테스트에도 그대로 반영돼 있었다는 뜻.
describe('extractSpineVibrationIntervalA8Max — 반복 관측치 계약', () => {
  const VALID_INTERVAL = {
    id: 'iv-1', sharedJobId: 'job-1', awMin: 1.0, awMax: 1.5, timeValue: 4, timeUnit: 'hr',
  };

  it('spine 모듈이 비활성이면 빈 배열(관측 행 0개, missing 개념이 아니라 행 자체가 없음)', () => {
    const result = extractSpineVibrationIntervalA8Max(migrate(baseCase({ activeModules: [] })));
    expect(result).toEqual([]);
  });

  // §리뷰 P1 — vibrationExposureStatus를 확인하지 않으면 미평가·노출없음 상태에서도
  // 과거에 입력된 구간이 정상 값으로 집계된다(VibrationEvaluation.jsx가 상태 전환 시
  // 구간 데이터를 보존하므로 실제로 벌어지는 시나리오). 엔터티 행은 유지하되(모집단
  // 불변 계약) missing만 상태에 맞게 바뀌어야 한다.
  it('vibrationExposureStatus가 unknown(미평가)이면 구간이 있어도 not_assessed — 값이 새지 않는다', () => {
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationIntervals: [VALID_INTERVAL] } })), // vibrationExposureStatus 미설정
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_assessed', qualityFlags: [] }]);
  });

  it('vibrationExposureStatus가 none(노출없음)이면 구간이 있어도 not_applicable — 값이 새지 않는다', () => {
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'none', vibrationIntervals: [VALID_INTERVAL] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('정상 입력(present) — awMax*sqrt(tHours/8) 값을 반환하고 flag가 없다', () => {
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [VALID_INTERVAL] } })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].entityKey).toEqual(['job-1', 'iv-1']);
    expect(result[0].missing).toBeNull();
    expect(result[0].qualityFlags).toEqual([]);
    expect(result[0].value).toBeCloseTo(1.5 * Math.sqrt(4 / 8), 6);
  });

  it('awMax가 미입력이면 not_entered(0으로 채우지 않는다)', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', timeValue: 4, timeUnit: 'hr' };
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  // §리뷰 P1 — awMax:'bad'/timeValue:''/timeUnit:'BAD'는 intervalA8/convertTimeToSeconds가
  // 내부적으로 Number(x)||0 또는 "미인식 단위→초로 취급"으로 조용히 처리해 "정상 계산된 0"과
  // 구분이 안 됐다. 계산 전에 세 필드를 모두 검증해 not_entered로 걸러내야 한다.
  it('awMax가 숫자로 파싱되지 않으면(예: "bad") not_entered + invalid — 0으로 계산되지 않는다', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', awMax: 'bad', timeValue: 4, timeUnit: 'hr' };
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('timeValue가 빈 문자열이면(미입력) not_entered — invalid 플래그는 안 붙는다(blank와 파싱불가는 다르다)', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5, timeValue: '', timeUnit: 'hr' };
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('timeUnit이 미인식 값(예: "BAD")이면 not_entered + invalid — 초로 조용히 취급되지 않는다', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5, timeValue: 4, timeUnit: 'BAD' };
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  // §3차 리뷰 P1 — awMax<=0/timeValue<=0은 도메인 규칙(vibration.ts:29)상 존재할 수 없는
  // 값이므로 "그럴듯하지만 의심스러운 값"이 아니라 계산 불가(결측)다. 남는 "그럴듯하지만
  // 의심스러운 값"(원본 case grain 동작과 대칭)은 awMin>awMax처럼 개별 필드는 양수 조건을
  // 만족하지만 상호 관계가 이상한 경우뿐이다.
  it('awMin>awMax(개별 필드는 양수, 상호관계만 이상함) — 값은 그대로 계산하고 invalid 플래그만 붙인다', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', awMin: 2, awMax: 1, timeValue: 4, timeUnit: 'hr' };
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: 1 * Math.sqrt(4 / 8), missing: null, qualityFlags: ['invalid'] }]);
  });

  it.each([
    ['awMax가 0이면', { id: 'iv-1', sharedJobId: 'job-1', awMax: 0, timeValue: 4, timeUnit: 'hr' }],
    ['awMax가 음수이면', { id: 'iv-1', sharedJobId: 'job-1', awMax: -1, timeValue: 4, timeUnit: 'hr' }],
    ['timeValue가 0이면', { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5, timeValue: 0, timeUnit: 'hr' }],
    ['timeValue가 음수이면', { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5, timeValue: -4, timeUnit: 'hr' }],
  ])('%s not_entered + invalid — 0/음수를 정상 관측값으로 집계하지 않는다(3차 리뷰 P1)', (_label, interval) => {
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  // §3차 리뷰 P2 — Number()/String() 강제변환으로 검증하면 boolean·배열도 통과해 계산에는
  // 원본이 그대로 전달된다(예: timeUnit:['hr']는 String()으로는 'hr'과 구별 안 됨).
  it.each([
    ['timeValue가 boolean이면(Number(true)===1로 강제변환되지 않아야 한다)', { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5, timeValue: true, timeUnit: 'hr' }],
    ['awMax가 배열이면', { id: 'iv-1', sharedJobId: 'job-1', awMax: [1.5], timeValue: 4, timeUnit: 'hr' }],
    ['timeUnit이 배열이면(String(["hr"])==="hr"로 오통과하지 않아야 한다)', { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5, timeValue: 4, timeUnit: ['hr'] }],
  ])('%s not_entered + invalid — 강제변환으로 통과시키지 않는다(3차 리뷰 P2)', (_label, interval) => {
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('id 결측 등 엔터티 해석 단계의 quality flag가 값 추출 결과에도 그대로 전달된다', () => {
    const interval = { sharedJobId: 'job-1', awMax: 1.5, timeValue: 4, timeUnit: 'hr' }; // id 없음
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].entityKey).toEqual(['job-1', '__missing_0']);
    expect(result[0].qualityFlags).toEqual(['invalid']);
    expect(result[0].value).toBeCloseTo(1.5 * Math.sqrt(4 / 8), 6);
  });

  it('여러 구간을 1:1로 매핑한다 — 행을 빼거나 더하지 않는다', () => {
    const second = { id: 'iv-2', sharedJobId: 'job-1', awMax: 0.8, timeValue: 2, timeUnit: 'hr' };
    const result = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [VALID_INTERVAL, second] } })),
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.entityKey[1])).toEqual(['iv-1', 'iv-2']);
  });

  it('결정성 — 동일 snapshot을 두 번 추출해도 byte-identical 결과', () => {
    const payload = baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [VALID_INTERVAL] } });
    const first = extractSpineVibrationIntervalA8Max(migrate(payload));
    const second = extractSpineVibrationIntervalA8Max(migrate(payload));
    expect(first).toEqual(second);
  });
});

// PR0-B3 Part A(2차 리뷰 반영) — "변수 추가/제거 시 엔터티 모집단이 불변"을 실제로
// 검증하려면 같은 grain에 서로 다른 결측 조건을 갖는 변수가 필요하다. 이 변수는
// timeValue/timeUnit만 소비하므로 awMax만 비어도(A8Max는 not_entered) 정상 계산된다.
describe('extractSpineVibrationIntervalExposureHours — 반복 관측치 계약', () => {
  const VALID_INTERVAL = {
    id: 'iv-1', sharedJobId: 'job-1', awMin: 1.0, awMax: 1.5, timeValue: 4, timeUnit: 'hr',
  };

  it('vibrationExposureStatus가 unknown이면 not_assessed', () => {
    const result = extractSpineVibrationIntervalExposureHours(
      migrate(baseCase({ spineModule: { vibrationIntervals: [VALID_INTERVAL] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_assessed', qualityFlags: [] }]);
  });

  it('vibrationExposureStatus가 none이면 not_applicable', () => {
    const result = extractSpineVibrationIntervalExposureHours(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'none', vibrationIntervals: [VALID_INTERVAL] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('정상 입력(present) — timeValue/timeUnit을 시간 단위로 환산한 값을 반환한다', () => {
    const result = extractSpineVibrationIntervalExposureHours(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [VALID_INTERVAL] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: 4, missing: null, qualityFlags: [] }]);
  });

  it('awMax가 미입력이어도(이 변수는 awMax를 안 씀) 정상 계산된다 — A8Max와 결측 조건이 서로 다르다', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', timeValue: 4, timeUnit: 'hr' }; // awMax 없음
    const a8 = extractSpineVibrationIntervalA8Max(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    const hours = extractSpineVibrationIntervalExposureHours(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(a8[0].missing).toBe('not_entered'); // A8Max는 awMax가 없어 계산 불가
    expect(hours[0].missing).toBeNull(); // ExposureHours는 awMax와 무관하므로 정상 계산
    expect(hours[0].value).toBe(4);
  });

  it('timeUnit이 미인식 값이면 not_entered + invalid', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5, timeValue: 4, timeUnit: 'BAD' };
    const result = extractSpineVibrationIntervalExposureHours(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  // §3차 리뷰 P1 — A8Max와 같은 결함이 이 변수에도 그대로 재현됐다: timeValue<=0을 정상
  // 노출시간(예: -4시간)으로 반환했다. awMax와 무관하게 값이 나오는 변수라도 timeValue
  // 자체의 도메인 규칙(vibration.ts:29, time>0)은 그대로 적용돼야 한다.
  it.each([
    ['timeValue가 0이면', { id: 'iv-1', sharedJobId: 'job-1', timeValue: 0, timeUnit: 'hr' }],
    ['timeValue가 음수이면', { id: 'iv-1', sharedJobId: 'job-1', timeValue: -4, timeUnit: 'hr' }],
  ])('%s not_entered + invalid — 음수 노출시간을 정상 관측값으로 집계하지 않는다(3차 리뷰 P1)', (_label, interval) => {
    const result = extractSpineVibrationIntervalExposureHours(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  // §3차 리뷰 P2 — checkNumericField/checkTimeUnitField의 Number()/String() 강제변환이
  // 계산에 전달되는 원본 값과 달라지는 문제가 이 변수에도 동일하게 있었다.
  it.each([
    ['timeValue가 boolean이면', { id: 'iv-1', sharedJobId: 'job-1', timeValue: true, timeUnit: 'hr' }],
    ['timeUnit이 배열이면', { id: 'iv-1', sharedJobId: 'job-1', timeValue: 4, timeUnit: ['hr'] }],
  ])('%s not_entered + invalid — 강제변환으로 통과시키지 않는다(3차 리뷰 P2)', (_label, interval) => {
    const result = extractSpineVibrationIntervalExposureHours(
      migrate(baseCase({ spineModule: { vibrationExposureStatus: 'present', vibrationIntervals: [interval] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'iv-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });
});

// PR0-B3 Part C-2 — task grain(§2 키: (case, jobId, taskId)). vibration_interval과 같은
// mddmStatus 3상태 게이트 + job 귀속 규칙을 공유하므로 그 계약이 이미 검증된 케이스를
// 반복하지 않고, weight 고유의 검증 규칙(양수 요구·seed 기본값 플래그)만 확인한다.
describe('extractSpineTaskWeightKg — 반복 관측치 계약', () => {
  const VALID_TASK = { id: 'task-1', sharedJobId: 'job-1', weight: 30, frequency: 80 };

  it('spine 모듈이 비활성이면 빈 배열(관측 행 0개)', () => {
    const result = extractSpineTaskWeightKg(migrate(baseCase({ activeModules: [] })));
    expect(result).toEqual([]);
  });

  // resolveMddmStatus는 mddmStatus 미설정 + tasks 비어있지 않음이면 'present'로 추론한다
  // (하위호환 규칙, mddm.ts:37) — 명시적으로 evalMethod:'wbv'를 줘야 'unknown'이 된다.
  it('mddmStatus가 unknown이면 task가 있어도 not_assessed', () => {
    const result = extractSpineTaskWeightKg(
      migrate(baseCase({ spineModule: { evalMethod: 'wbv', tasks: [VALID_TASK] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: null, missing: 'not_assessed', qualityFlags: [] }]);
  });

  it('mddmStatus가 none이면 task가 있어도 not_applicable', () => {
    const result = extractSpineTaskWeightKg(
      migrate(baseCase({ spineModule: { mddmStatus: 'none', tasks: [VALID_TASK] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('정상 입력(present) — weight 값을 그대로 반환하고 flag가 없다', () => {
    const result = extractSpineTaskWeightKg(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [VALID_TASK] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: 30, missing: null, qualityFlags: [] }]);
  });

  // §0 "코드 사실" — createTask()의 seed 기본값(weight=15). possibly_seeded_default 최초 사용.
  it('weight가 seed 기본값(15)과 정확히 같으면 possibly_seeded_default 플래그를 붙인다(결측 아님)', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', weight: 15 };
    const result = extractSpineTaskWeightKg(migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })));
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: 15, missing: null, qualityFlags: ['possibly_seeded_default'] }]);
  });

  it('weight가 미입력이면 not_entered(0으로 채우지 않는다)', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1' };
    const result = extractSpineTaskWeightKg(migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })));
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it.each([
    ['0이면', { id: 'task-1', sharedJobId: 'job-1', weight: 0 }],
    ['음수면', { id: 'task-1', sharedJobId: 'job-1', weight: -5 }],
    ['숫자로 파싱되지 않으면', { id: 'task-1', sharedJobId: 'job-1', weight: 'bad' }],
    ['배열이면(강제변환으로 통과시키지 않는다)', { id: 'task-1', sharedJobId: 'job-1', weight: [30] }],
  ])('weight가 %s not_entered + invalid', (_label, task) => {
    const result = extractSpineTaskWeightKg(migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })));
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('여러 task를 1:1로 매핑한다 — 행을 빼거나 더하지 않는다', () => {
    const second = { id: 'task-2', sharedJobId: 'job-1', weight: 20 };
    const result = extractSpineTaskWeightKg(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [VALID_TASK, second] } })),
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.entityKey[1])).toEqual(['task-1', 'task-2']);
  });

  it('결정성 — 동일 snapshot을 두 번 추출해도 byte-identical 결과', () => {
    const payload = baseCase({ spineModule: { mddmStatus: 'present', tasks: [VALID_TASK] } });
    expect(extractSpineTaskWeightKg(migrate(payload))).toEqual(extractSpineTaskWeightKg(migrate(payload)));
  });
});

// frequencyPerDay와 결측 조건이 독립적이다(weight 없이 frequency만 입력된 task도 가능) —
// "변수 추가/제거해도 모집단 불변" 계약을 검증하려면 최소 2개가 필요하다.
describe('extractSpineTaskFrequencyPerDay — 반복 관측치 계약', () => {
  it('정상 입력(present) — frequency 값을 그대로 반환하고 flag가 없다', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', frequency: 40 };
    const result = extractSpineTaskFrequencyPerDay(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: 40, missing: null, qualityFlags: [] }]);
  });

  it('frequency가 seed 기본값(80)과 정확히 같으면 possibly_seeded_default 플래그를 붙인다', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', frequency: 80 };
    const result = extractSpineTaskFrequencyPerDay(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: 80, missing: null, qualityFlags: ['possibly_seeded_default'] }]);
  });

  it('weight 없이 frequency만 입력돼도 정상 계산된다(weightKg와 결측 조건이 독립적)', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', frequency: 40 }; // weight 없음
    const weightResult = extractSpineTaskWeightKg(migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })));
    const freqResult = extractSpineTaskFrequencyPerDay(migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })));
    expect(weightResult[0].missing).toBe('not_entered');
    expect(freqResult[0].missing).toBeNull();
    expect(freqResult[0].value).toBe(40);
  });

  it('frequency가 0 이하면 not_entered + invalid', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', frequency: 0 };
    const result = extractSpineTaskFrequencyPerDay(
      migrate(baseCase({ spineModule: { mddmStatus: 'present', tasks: [task] } })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });
});

// PR0-B3 Part B — case grain 값인데 저장 위치는 diagnosis 행이다(§5.5 함정, coverage/shared.ts
// 주석과 동일). extractor가 그 case의 spine 진단 전체를 취합해 값이 갈리면
// conflicting_common_field로 반영하는지 검증한다.
describe('extractSpineDiagnosisVerticalDistribution — case grain(진단 행에 저장됨)', () => {
  it('spine 모듈이 activeModules에 없으면 structural_missing', () => {
    const dx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', verticalDistribution: 'confirmed' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ activeModules: [], diagnoses: [dx] })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('spine은 활성인데 이 case에 spine 진단이 없으면 not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증' }; // spine 아님
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [dx] })));
    expect(result).toEqual({ value: null, missing: 'not_applicable', qualityFlags: [] });
  });

  it('spine 진단은 있는데 verticalDistribution이 전부 공백이면 not_entered', () => {
    const dx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [dx] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('정상 입력 — "confirmed"→true, "unconfirmed"→false', () => {
    const confirmed = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', verticalDistribution: 'confirmed' };
    expect(extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [confirmed] })))).toEqual({
      value: true,
      missing: null,
      qualityFlags: [],
    });
    const unconfirmed = { id: 'dx-2', code: 'M51.1', name: '요추간판장애', verticalDistribution: 'unconfirmed' };
    expect(extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [unconfirmed] })))).toEqual({
      value: false,
      missing: null,
      qualityFlags: [],
    });
  });

  it('spine 진단이 여러 개이고 값이 같으면 대표값을 그대로 반환한다(플래그 없음)', () => {
    const a = { id: 'dx-1', code: 'M51.1', name: '요추간판장애A', verticalDistribution: 'confirmed' };
    const b = { id: 'dx-2', code: 'M54.1', name: '요추간판장애B', verticalDistribution: 'confirmed' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [a, b] })));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  // normalizeSpineAssessmentFields(클라이언트 useEffect)는 통상 첫 spine 진단에만 값을
  // 모아두지만, 이 snapshot 읽기 시점에 그 정규화가 항상 적용됐다고 보장할 수 없다
  // (배치입력·정규화 실행 전 저장 등) — 그래서 extractor가 직접 갈림을 감지해야 한다.
  // §5.5 ④ 계획 규칙 — 값이 갈리면 플래그를 붙이고 "정렬 후 첫 값"을 대표값으로 삼는다.
  // 3차 리뷰 P2 — 이전 구현은 원본 배열 순서상 첫 non-blank 값을 썼는데, 그러면 진단
  // 삭제·재배치만으로 대표값이 바뀌었다(순서 의존). 정렬 후 첫 값은 입력 순서와 무관하게
  // 항상 같은 대표값을 낸다 — 아래에서 원본 순서를 뒤집어도 결과가 같은지로 확인한다.
  it('spine 진단이 여러 개이고 값이 갈리면 conflicting_common_field + 정렬 후 첫 값을 대표값으로 반환한다(진단 순서와 무관)', () => {
    const a = { id: 'dx-1', code: 'M51.1', name: '요추간판장애A', verticalDistribution: 'confirmed' };
    const b = { id: 'dx-2', code: 'M54.1', name: '요추간판장애B', verticalDistribution: 'unconfirmed' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [a, b] })));
    // 'confirmed' < 'unconfirmed'(사전순) — 정렬 후 첫 값은 항상 'confirmed'.
    expect(result).toEqual({ value: true, missing: null, qualityFlags: ['conflicting_common_field'] });

    // 원본 배열 순서를 뒤집어도 대표값이 그대로다(순서 무관성 확인).
    const reversed = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [b, a] })));
    expect(reversed).toEqual({ value: true, missing: null, qualityFlags: ['conflicting_common_field'] });
  });

  it('confirmed/unconfirmed가 아닌 값(손상 데이터)은 not_entered + invalid', () => {
    const dx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', verticalDistribution: 'garbage' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [dx] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('무릎 진단에 우연히 같은 필드명이 있어도(다른 모듈) 취합 대상에서 제외된다', () => {
    const kneeDx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', verticalDistribution: 'confirmed' };
    const spineDx = { id: 'dx-2', code: 'M51.1', name: '요추간판장애' }; // verticalDistribution 공백
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [kneeDx, spineDx] })));
    // knee 진단의 'confirmed'는 무시되고, spine 진단만 봤을 때 전부 공백이라 not_entered.
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  // 3차 리뷰 P1 — resolveDiagnosisModule()이 쓰는 요추 정규식의 빈 대안 버그(diagnosisMapping.ts
  // 헤더의 KNOWN BUG)는 다른 5개 모듈 패턴에 안 걸린 모든 진단명을 요추로 오분류한다. 감기
  // (J00)처럼 이 모듈들과 무관한 진단이 verticalDistribution 값을 갖고 있으면(예: 레거시
  // 데이터, 다른 필드였다가 재사용된 경우) 척추 판정으로 잘못 집계됐다. isReliablySpineDiagnosis
  // (이 파일 내부, 빈 대안 버그를 제외한 판정)로 우회했는지 직접 재현한다.
  it('요추 정규식의 빈 대안 버그로 무관한 진단(예: 감기)이 척추로 오분류되지 않는다', () => {
    const coldDx = { id: 'dx-1', code: 'J00', name: '감기', verticalDistribution: 'confirmed' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [coldDx] })));
    // 척추 진단으로 집계되지 않으므로 이 case엔 척추 진단이 없다 — not_applicable.
    expect(result).toEqual({ value: null, missing: 'not_applicable', qualityFlags: [] });
  });

  it('요추 정규식 오분류 우회가 실제 요추 진단(코드 없이 이름만)은 여전히 정상 인식한다', () => {
    const lumbarDx = { id: 'dx-1', name: '요추간판장애', verticalDistribution: 'confirmed' }; // code 없음
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [lumbarDx] })));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  // 4차 리뷰 P1 — M47/M54는 척추·경추 공유 코드다. isReliablySpineDiagnosis가 앞선
  // 우회에서 diagnosisMapping.ts의 "상병명에 경추 키워드가 있으면 경추 우선" 분기
  // (getDiagnosisModuleHint, code:98-102)를 빠뜨려 경추 진단이 척추로 잘못 집계됐다 —
  // M47.2/M54.2 + 이름에 cervical이 있으면 척추 진단으로 취합되지 않아야 한다.
  it.each([
    ['M47', 'M47.2'],
    ['M54', 'M54.2'],
  ])('%s 코드에 이름이 cervical이면 경추로 우선 판정돼 척추 진단으로 취합되지 않는다', (_label, code) => {
    const cervicalDx = { id: 'dx-1', code, name: 'cervical', verticalDistribution: 'confirmed' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [cervicalDx] })));
    expect(result).toEqual({ value: null, missing: 'not_applicable', qualityFlags: [] });
  });

  it('M4802(경추 전용, ICD_MODULE_MAP 명시)는 이름과 무관하게 척추로 집계되지 않는다', () => {
    const cervicalDx = { id: 'dx-1', code: 'M4802', name: '무증상', verticalDistribution: 'confirmed' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [cervicalDx] })));
    expect(result).toEqual({ value: null, missing: 'not_applicable', qualityFlags: [] });
  });

  it('M47/M54라도 이름에 경추 키워드가 없으면 여전히 척추로 정상 인식한다(경계 확인)', () => {
    const lumbarDx = { id: 'dx-1', code: 'M47.2', name: '요추간판장애', verticalDistribution: 'confirmed' };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [lumbarDx] })));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  // 4차 리뷰 P2 — String(raw) 강제변환으로 정렬 전 비교하면 ['confirmed'](배열)이
  // Array.toString() 강제변환으로 문자열 'confirmed'와 구별되지 않고 정상값으로
  // 승격된다. K-L Grade에서 확립한 "엄격 비교 후 정규화 값만 계산에 쓴다" 원칙과
  // 동일한 결함 계열 — 원본 타입 자체를 검사해야 한다.
  it.each([
    ['배열로 감싼 유효값', ['confirmed']],
    ['boolean', true],
    ['숫자', 1],
  ])('verticalDistribution이 %s면 강제변환으로 통과시키지 않고 not_entered + invalid로 처리한다', (_label, verticalDistribution) => {
    const dx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', verticalDistribution };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [dx] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('유효값과 잘못된 값이 섞이면(진단 여러 개) invalid 플래그를 붙이고 유효값만으로 대표값을 정한다(충돌 아니면 conflicting 플래그 없음)', () => {
    const valid = { id: 'dx-1', code: 'M51.1', name: '요추간판장애A', verticalDistribution: 'confirmed' };
    const corrupted = { id: 'dx-2', code: 'M54.1', name: '요추간판장애B', verticalDistribution: ['garbage'] };
    const result = extractSpineDiagnosisVerticalDistribution(migrate(baseCase({ diagnoses: [valid, corrupted] })));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: ['invalid'] });
  });

  it('유효값과 잘못된 값이 섞이고 유효값끼리도 충돌하면 invalid·conflicting_common_field가 둘 다 붙는다', () => {
    const confirmedDx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애A', verticalDistribution: 'confirmed' };
    const unconfirmedDx = { id: 'dx-2', code: 'M54.1', name: '요추간판장애B', verticalDistribution: 'unconfirmed' };
    const corruptedDx = { id: 'dx-3', code: 'M47.1', name: '요추간판장애C', verticalDistribution: ['garbage'] };
    const result = extractSpineDiagnosisVerticalDistribution(
      migrate(baseCase({ diagnoses: [confirmedDx, unconfirmedDx, corruptedDx] })),
    );
    expect(result.missing).toBeNull();
    expect(result.value).toBe(true); // 'confirmed' < 'unconfirmed' 사전순 — 유효값 중 정렬 후 첫 값.
    expect(result.qualityFlags.sort()).toEqual(['conflicting_common_field', 'invalid']);
  });
});

describe('extractSpineDiagnosisConcomitantSpondylosis — case grain(진단 행에 저장됨)', () => {
  it('extractSpineDiagnosisVerticalDistribution과 동일한 패턴(다른 필드) — 정상 입력·충돌 감지', () => {
    const a = { id: 'dx-1', code: 'M51.1', name: '요추간판장애A', concomitantSpondylosis: 'confirmed' };
    const b = { id: 'dx-2', code: 'M54.1', name: '요추간판장애B', concomitantSpondylosis: 'unconfirmed' };
    expect(extractSpineDiagnosisConcomitantSpondylosis(migrate(baseCase({ diagnoses: [a] })))).toEqual({
      value: true,
      missing: null,
      qualityFlags: [],
    });
    expect(extractSpineDiagnosisConcomitantSpondylosis(migrate(baseCase({ diagnoses: [a, b] })))).toEqual({
      value: true,
      missing: null,
      qualityFlags: ['conflicting_common_field'],
    });
  });
});

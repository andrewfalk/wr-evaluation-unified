import { describe, it, expect } from 'vitest';
import {
  extractCervicalCaseMaxJobCumulativeKgHours,
  extractCervicalCaseTotalNonNeutralHoursPerDay,
} from '../../../modules/cervical/extractors';
import {
  getLinkedRawCervicalTasks,
  isValidRawExposureTypes,
  validateRawCervicalTaskExposure,
} from '../../../modules/cervical/rawTasks';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function baseCase(overrides: {
  jobs?: unknown[];
  diagnoses?: unknown[];
  tasks?: unknown[];
  activeModules?: string[];
  includeCervicalModule?: boolean;
}) {
  const {
    jobs = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }],
    diagnoses = [],
    tasks = [],
    activeModules = ['cervical'],
    includeCervicalModule = true,
  } = overrides;
  return {
    data: {
      shared: { jobs, diagnoses },
      modules: includeCervicalModule ? { cervical: { tasks } } : {},
      activeModules,
    },
  };
}

const CORE_TASK = {
  id: 'task-1',
  sharedJobId: 'job-1',
  name: '박스 운반',
  exposure_types: ['shoulder_heavy_load'],
  load_weight_kg: '45',
  carry_hours_per_shift: '2',
  forced_neck_posture: 'yes',
};

describe('extractCervicalCaseMaxJobCumulativeKgHours — 우선순위 사슬(§1-1a)', () => {
  it('순서 1: 모듈이 activeModules에 없으면 structural_missing', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ activeModules: [] })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 1: activeModules엔 있는데 data.modules.cervical이 plain object가 아니면 structural_missing', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ includeCervicalModule: false })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 2: shared.jobs가 비어있으면 not_entered', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs: [] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3: task가 0건이면(경추 부담 작업 없음) 결측이 아니라 유효한 값 0', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [] })));
    expect(result).toEqual({ value: 0, missing: null, qualityFlags: [] });
  });

  it('순서 3: task는 있는데 필수 필드(name)가 비어있으면 not_entered', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(
      migrate(baseCase({ tasks: [{ sharedJobId: 'job-1', name: '', exposure_types: ['shoulder_heavy_load'] }] })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 4: 정상 입력 — BK2109 핵심 3요건 충족 시 양의 kg·h 값', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [CORE_TASK] })));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual([]);
    expect(result.value).toBeGreaterThan(0);
  });

  it('순서 5: 직력이 2개면 전 직업의 누적 총부하량 합계를 case 값으로 낸다(최댓값 아님)', () => {
    const job1 = { id: 'job-1', jobName: 'A', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };
    const job2 = { id: 'job-2', jobName: 'B', startDate: '2019-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };
    const task1 = CORE_TASK;
    const task2 = { ...CORE_TASK, id: 'task-2', sharedJobId: 'job-2', load_weight_kg: '41' };
    const solo1 = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs: [job1], tasks: [task1] })));
    const solo2 = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs: [job2], tasks: [task2] })));
    const both = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs: [job1, job2], tasks: [task1, task2] })));
    expect(solo1.value).toBeGreaterThan(0);
    expect(solo2.value).toBeGreaterThan(0);
    expect(both.missing).toBeNull();
    expect(both.qualityFlags).toEqual([]);
    expect(both.value).toBeCloseTo((solo1.value as number) + (solo2.value as number), 6);
    expect(both.value).toBeGreaterThan(solo1.value as number); // 최댓값이었다면 solo1과 같았을 것
  });

  // 예측 코호트는 missing만 보고 qualityFlags는 보지 않으므로, 손상 입력은 계산기가 흡수한
  // 유한한 0이 value로 나가면 안 된다 — 전부 결측(not_entered) + invalid여야 한다.
  it('순서 3b: 비어있지 않은 숫자 필드가 파싱 실패면 value 0이 아니라 not_entered + invalid', () => {
    const invalidTask = { ...CORE_TASK, load_weight_kg: 'abc' };
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [invalidTask] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('순서 3b: BK2109 핵심 task가 있는데 근무기간이 전혀 없으면 not_entered + invalid', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공' }]; // startDate/endDate/workPeriodOverride 전부 없음
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  // §리뷰 지적(2026-09-05): job.workDaysPerYear가 없거나 파싱 불가능해도(근무기간은 정상)
  // getTaskCumulativeKgHours(derived.ts)의 `Number(job.workDaysPerYear) || 0`이 조용히
  // 0으로 흡수해 qualityFlag 없이 "정상 계산된 0"이 나왔다 — 250(정상)·'abc'(오류)·미입력
  // 세 경우를 각각 고정한다.
  it('순서 3b: workDaysPerYear가 정상(250)이면 flag 없이 실제 값이 계산된다', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }];
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual([]);
    expect(result.value).toBeGreaterThan(0);
  });

  it('순서 3b: workDaysPerYear가 비숫자 문자열이면 not_entered + invalid(0으로 흡수되지 않음)', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 'abc' }];
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('순서 3b: workDaysPerYear가 미입력이면 not_entered + invalid(0으로 흡수되지 않음)', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01' }]; // workDaysPerYear 없음
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('순서 3b: startDate가 파싱 불가능한 문자열이면(NaN 기간) invalid qualityFlag + not_entered로 전환(최종 NaN 가드)', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: 'abc', endDate: '2020-01-01', workDaysPerYear: 250 }];
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('배열 원소 방어: shared.jobs/diagnoses/modules.cervical.tasks에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractCervicalCaseMaxJobCumulativeKgHours(
        migrate(
          baseCase({
            jobs: [null, { id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01' }] as unknown[],
            diagnoses: [null, { id: 'dx-1', code: 'M50', moduleId: 'cervical' }] as unknown[],
            tasks: [null, CORE_TASK] as unknown[],
          }),
        ),
      ),
    ).not.toThrow();
  });

  it('필드 타입 방어: exposure_types가 배열이 아니라 문자열이어도 예외를 던지지 않는다', () => {
    const malformedTask = { ...CORE_TASK, exposure_types: 'shoulder_heavy_load' as unknown as string[] };
    expect(() => extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [malformedTask] })))).not.toThrow();
  });
});

// ── 누적 총부하량(B-1) — 엄격 원본 검증·손상값 우선·노출유형/직업 범위 ──────────────────────
const JOB_1 = { id: 'job-1', jobName: 'A', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };
const JOB_2 = { id: 'job-2', jobName: 'B', startDate: '2019-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };

// 비중립 작업(필수필드 4종 전부 입력) — BK2109 하중 필드는 일부러 비워 둔다.
const AWKWARD_TASK = {
  id: 'task-a',
  sharedJobId: 'job-1',
  name: '모니터 작업',
  exposure_types: ['awkward_static_neck_load'],
  neck_nonneutral_hours_per_day: '2',
  combined_flexion_rotation_posture: 'yes',
  precision_work: 'no',
};

const NOT_ENTERED_INVALID = { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
const NOT_ENTERED_PLAIN = { value: null, missing: 'not_entered', qualityFlags: [] };

describe('extractCervicalCaseMaxJobCumulativeKgHours — 엄격 원본 검증(B-1)', () => {
  it.each([
    ['하중 "45kg"(숫자-접두 문자열)', { load_weight_kg: '45kg' }],
    ['하중 [45](배열)', { load_weight_kg: [45] }],
    ['하중 -45(음수)', { load_weight_kg: '-45' }],
    ['운반시간 "2h"', { carry_hours_per_shift: '2h' }],
  ])('%s → not_entered + invalid (parseFloat로 통과시키지 않음)', (_label, patch) => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [{ ...CORE_TASK, ...patch }] })));
    expect(result).toEqual(NOT_ENTERED_INVALID);
  });

  it.each([['-250'], ['250days']])('연간근무일수 %s → not_entered + invalid (음수 누적부하량 불가)', (workDaysPerYear) => {
    const jobs = [{ ...JOB_1, workDaysPerYear }];
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result).toEqual(NOT_ENTERED_INVALID);
  });

  it('정상 직업 + 손상 직업 혼합 → 부분합 없이 전체 not_entered + invalid', () => {
    const badTask = { ...CORE_TASK, id: 'task-2', sharedJobId: 'job-2', load_weight_kg: 'abc' };
    const result = extractCervicalCaseMaxJobCumulativeKgHours(
      migrate(baseCase({ jobs: [JOB_1, JOB_2], tasks: [CORE_TASK, badTask] })),
    );
    expect(result).toEqual(NOT_ENTERED_INVALID);
  });

  it('반환 순서: 필수필드 blank(name:"") + 하중 "abc" 혼합 → invalid가 사라지지 않는다', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(
      migrate(baseCase({ tasks: [{ ...CORE_TASK, name: '', load_weight_kg: 'abc' }] })),
    );
    expect(result).toEqual(NOT_ENTERED_INVALID);
  });

  it('반환 순서: 필수필드 blank만 있으면 플래그 없는 not_entered', () => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [{ ...CORE_TASK, name: '' }] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('범위 제한: 비중립 전용 작업에 남은 숨은 load_weight_kg:"abc"는 검증하지 않아 정상 합계가 나온다', () => {
    const staleHidden = { ...AWKWARD_TASK, load_weight_kg: 'abc', carry_hours_per_shift: '2h' };
    const withStale = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [CORE_TASK, staleHidden] })));
    const without = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [CORE_TASK] })));
    expect(withStale.missing).toBeNull();
    expect(withStale.qualityFlags).toEqual([]);
    expect(withStale.value).toBeGreaterThan(0);
    expect(withStale.value).toBe(without.value);
  });

  it('비중립 시간 영향: "abc"는 필수필드 통과·invalid 미부여 → 정상 합계 / []는 필수필드 미입력 → 플래그 없는 not_entered', () => {
    const abc = extractCervicalCaseMaxJobCumulativeKgHours(
      migrate(baseCase({ tasks: [CORE_TASK, { ...AWKWARD_TASK, neck_nonneutral_hours_per_day: 'abc' }] })),
    );
    expect(abc.missing).toBeNull();
    expect(abc.qualityFlags).toEqual([]);
    expect(abc.value).toBeGreaterThan(0);

    const emptyArray = extractCervicalCaseMaxJobCumulativeKgHours(
      migrate(baseCase({ tasks: [CORE_TASK, { ...AWKWARD_TASK, neck_nonneutral_hours_per_day: [] }] })),
    );
    expect(emptyArray).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('합산 overflow(Infinity)는 값으로 내보내지 않고 not_entered + invalid', () => {
    const huge = { ...CORE_TASK, load_weight_kg: '1e308' };
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [huge] })));
    expect(result).toEqual(NOT_ENTERED_INVALID);
  });
});

// ── 원본 exposure_types 검증 + 직업 연결 보정 (B-1·B-2 공통) ───────────────────────────────
describe('손상 exposure_types / 직업 연결 보정 (B-1·B-2 공통)', () => {
  const corruptCases: Array<[string, unknown]> = [
    ['문자열 "shoulder_heavy_load"', 'shoulder_heavy_load'],
    ['[null]', [null]],
    ['["typo"](알 수 없는 문자열)', ['typo']],
    ['["awkward_static_neck_load","typo"](정상+알 수 없는 값 혼합)', ['awkward_static_neck_load', 'typo']],
  ];

  it.each(corruptCases)('B-1: exposure_types가 %s → not_entered + invalid', (_label, exposure_types) => {
    const result = extractCervicalCaseMaxJobCumulativeKgHours(
      migrate(baseCase({ tasks: [{ ...CORE_TASK, exposure_types }] })),
    );
    expect(result).toEqual(NOT_ENTERED_INVALID);
  });

  it.each(corruptCases)('B-2: exposure_types가 %s → 유효한 0이 아니라 not_entered + invalid', (_label, exposure_types) => {
    const result = extractCervicalCaseTotalNonNeutralHoursPerDay(
      migrate(baseCase({ tasks: [{ ...AWKWARD_TASK, exposure_types }] })),
    );
    expect(result).toEqual(NOT_ENTERED_INVALID);
  });

  it('정상 빈 배열 []·미설정은 "노출유형 미선택"으로 정상 처리 — 손상과 구분된다', () => {
    const { exposure_types: _omit, ...noTypes } = AWKWARD_TASK;
    for (const task of [{ ...AWKWARD_TASK, exposure_types: [] }, noTypes]) {
      expect(extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(baseCase({ tasks: [task] })))).toEqual({
        value: 0,
        missing: null,
        qualityFlags: [],
      });
    }
  });

  it('정상 직업 + 손상 exposure_types 직업 혼합 → 전체 not_entered + invalid', () => {
    const badJobTask = { ...AWKWARD_TASK, id: 'task-b', sharedJobId: 'job-2', exposure_types: ['typo'] };
    expect(
      extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs: [JOB_1, JOB_2], tasks: [CORE_TASK, badJobTask] }))),
    ).toEqual(NOT_ENTERED_INVALID);
    expect(
      extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(baseCase({ jobs: [JOB_1, JOB_2], tasks: [AWKWARD_TASK, badJobTask] }))),
    ).toEqual(NOT_ENTERED_INVALID);
  });

  it('sharedJobId 미설정/빈값 작업은 정규화처럼 첫 직업에 연결되어 합산된다', () => {
    const { sharedJobId: _omit, ...unlinked } = AWKWARD_TASK;
    for (const task of [unlinked, { ...AWKWARD_TASK, sharedJobId: '' }]) {
      const result = extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(baseCase({ tasks: [task] })));
      expect(result).toEqual({ value: 2, missing: null, qualityFlags: [] });
    }
  });

  it('sharedJobId 미설정 + 손상 exposure_types → 원본 ID만 비교하면 검증에서 빠지는 회귀 방지(not_entered + invalid)', () => {
    const { sharedJobId: _omit, ...unlinked } = AWKWARD_TASK;
    const result = extractCervicalCaseTotalNonNeutralHoursPerDay(
      migrate(baseCase({ tasks: [{ ...unlinked, exposure_types: ['typo'] }] })),
    );
    expect(result).toEqual(NOT_ENTERED_INVALID);
    const { sharedJobId: _omit2, ...unlinkedCore } = CORE_TASK;
    expect(
      extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [{ ...unlinkedCore, exposure_types: 'x' }] }))),
    ).toEqual(NOT_ENTERED_INVALID);
  });

  it('명시적으로 삭제된 직업 id를 가리키는 고아 작업은 손상 exposure_types가 있어도 검증·합산에서 제외된다', () => {
    const orphan = {
      ...AWKWARD_TASK,
      id: 'task-orphan',
      sharedJobId: 'job-deleted',
      exposure_types: ['typo'],
      neck_nonneutral_hours_per_day: '5',
    };
    expect(extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(baseCase({ tasks: [AWKWARD_TASK, orphan] })))).toEqual({
      value: 2,
      missing: null,
      qualityFlags: [],
    });
    const orphanCore = { ...CORE_TASK, id: 'task-orphan', sharedJobId: 'job-deleted', exposure_types: 'x' };
    const withOrphan = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [CORE_TASK, orphanCore] })));
    const without = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [CORE_TASK] })));
    expect(withOrphan).toEqual(without);
  });
});

describe('rawTasks 헬퍼', () => {
  it('isValidRawExposureTypes: 미설정·정상 배열은 true, 비배열·미허용 원소·비문자열 원소는 false', () => {
    expect(isValidRawExposureTypes(undefined)).toBe(true);
    expect(isValidRawExposureTypes(null)).toBe(true);
    expect(isValidRawExposureTypes([])).toBe(true);
    expect(isValidRawExposureTypes(['shoulder_heavy_load', 'awkward_static_neck_load'])).toBe(true);
    expect(isValidRawExposureTypes('shoulder_heavy_load')).toBe(false);
    expect(isValidRawExposureTypes({})).toBe(false);
    expect(isValidRawExposureTypes(['typo'])).toBe(false);
    expect(isValidRawExposureTypes(['shoulder_heavy_load', 'typo'])).toBe(false);
    expect(isValidRawExposureTypes([null])).toBe(false);
    expect(isValidRawExposureTypes([1])).toBe(false);
  });

  it('getLinkedRawCervicalTasks: 미설정은 첫 직업에 연결, 삭제된 직업 id는 제외, 비객체 원소는 무시', () => {
    const cervicalModule = {
      tasks: [null, { name: 'unlinked' }, { name: 'ok', sharedJobId: 'job-2' }, { name: 'orphan', sharedJobId: 'gone' }],
    };
    const linked = getLinkedRawCervicalTasks(cervicalModule, [JOB_1, JOB_2]);
    expect(linked.map(({ task, jobId }) => [task.name, jobId])).toEqual([
      ['unlinked', 'job-1'],
      ['ok', 'job-2'],
    ]);
    expect(validateRawCervicalTaskExposure(linked)).toBe(true);
    expect(validateRawCervicalTaskExposure(getLinkedRawCervicalTasks({ tasks: [{ exposure_types: ['typo'] }] }, [JOB_1]))).toBe(false);
  });
});

// ── 비중립 정적 자세 시간 합계(B-2) ────────────────────────────────────────────────────────
describe('extractCervicalCaseTotalNonNeutralHoursPerDay', () => {
  const run = (overrides: Parameters<typeof baseCase>[0]) =>
    extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(baseCase(overrides)));

  it('순서 1·2: 모듈 비활성/비객체는 structural_missing, 직업 없음은 not_entered', () => {
    expect(run({ activeModules: [] })).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
    expect(run({ includeCervicalModule: false })).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
    expect(run({ jobs: [] })).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('대상 작업이 0건이면 결측이 아니라 유효한 0', () => {
    expect(run({ tasks: [] })).toEqual({ value: 0, missing: null, qualityFlags: [] });
  });

  it('직업·작업 전체를 단순 합산한다(가중 없음)', () => {
    const tasks = [
      { ...AWKWARD_TASK, id: 'a1', neck_nonneutral_hours_per_day: '2' },
      { ...AWKWARD_TASK, id: 'a2', neck_nonneutral_hours_per_day: 1.5 },
      { ...AWKWARD_TASK, id: 'a3', sharedJobId: 'job-2', neck_nonneutral_hours_per_day: '3' },
    ];
    expect(run({ jobs: [JOB_1, JOB_2], tasks })).toEqual({ value: 6.5, missing: null, qualityFlags: [] });
  });

  it('노출유형 미선택(awkward 아님) 작업의 숨은 stale 값은 합산하지 않는다', () => {
    const stale = { ...CORE_TASK, id: 'stale', neck_nonneutral_hours_per_day: '5' };
    expect(run({ tasks: [AWKWARD_TASK, stale] })).toEqual({ value: 2, missing: null, qualityFlags: [] });
  });

  it('고아 작업(삭제된 직업의 작업 5시간 + 정상 2시간)은 제외 → 2', () => {
    const orphan = { ...AWKWARD_TASK, id: 'orphan', sharedJobId: 'job-deleted', neck_nonneutral_hours_per_day: '5' };
    expect(run({ tasks: [AWKWARD_TASK, orphan] })).toEqual({ value: 2, missing: null, qualityFlags: [] });
  });

  it('하중·정밀작업 등 다른 필수필드가 비어 있어도 비중립 시간이 있으면 정상값(기존 필수필드 검사를 공유하지 않음)', () => {
    const minimal = {
      sharedJobId: 'job-1',
      name: '모니터',
      exposure_types: ['awkward_static_neck_load'],
      neck_nonneutral_hours_per_day: '2',
    };
    const otherIncomplete = {
      ...CORE_TASK,
      id: 'heavy',
      exposure_types: ['shoulder_heavy_load', 'awkward_static_neck_load'],
      load_weight_kg: '',
      neck_nonneutral_hours_per_day: '1',
    };
    expect(run({ tasks: [minimal, otherIncomplete] })).toEqual({ value: 3, missing: null, qualityFlags: [] });
  });

  it('전부 blank → not_entered, 정상 + blank 혼합 → 부분합 없이 전체 not_entered(플래그 없음), [](비문자열 타입)는 blank가 아니라 invalid', () => {
    const blank = { ...AWKWARD_TASK, id: 'b', neck_nonneutral_hours_per_day: '' };
    const blankArray = { ...AWKWARD_TASK, id: 'b2', neck_nonneutral_hours_per_day: [] };
    expect(run({ tasks: [blank] })).toEqual(NOT_ENTERED_PLAIN);
    expect(run({ tasks: [AWKWARD_TASK, blank] })).toEqual(NOT_ENTERED_PLAIN);
    // []는 blank가 아니라 비문자열·비숫자 타입이므로 invalid다(blank는 null/undefined/공백 문자열만).
    expect(run({ tasks: [blankArray] })).toEqual(NOT_ENTERED_INVALID);
  });

  it.each([
    ['"2h"', '2h'],
    ['-2', '-2'],
    ['[2]', [2]],
    ['"abc"', 'abc'],
    ['"Infinity"', 'Infinity'],
  ])('손상값 %s → not_entered + invalid (parseFloat로 2시간으로 읽지 않음)', (_label, neck_nonneutral_hours_per_day) => {
    expect(run({ tasks: [{ ...AWKWARD_TASK, neck_nonneutral_hours_per_day }] })).toEqual(NOT_ENTERED_INVALID);
  });

  it('정상 + invalid 혼합, blank + invalid 혼합은 모두 not_entered + invalid(invalid가 사라지지 않음)', () => {
    const bad = { ...AWKWARD_TASK, id: 'bad', neck_nonneutral_hours_per_day: '2h' };
    const blank = { ...AWKWARD_TASK, id: 'blank', neck_nonneutral_hours_per_day: '' };
    expect(run({ tasks: [AWKWARD_TASK, bad] })).toEqual(NOT_ENTERED_INVALID);
    expect(run({ tasks: [blank, bad] })).toEqual(NOT_ENTERED_INVALID);
  });

  it('합산 overflow(1e308 + 1e308)는 not_entered + invalid', () => {
    const a = { ...AWKWARD_TASK, id: 'a', neck_nonneutral_hours_per_day: '1e308' };
    const b = { ...AWKWARD_TASK, id: 'b', neck_nonneutral_hours_per_day: '1e308' };
    expect(run({ tasks: [a, b] })).toEqual(NOT_ENTERED_INVALID);
  });

  it('BK2109용 근속기간·연간근무일수가 없어도 이 변수에는 영향이 없다', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공' }]; // 날짜·workDaysPerYear 전부 없음
    expect(run({ jobs, tasks: [AWKWARD_TASK] })).toEqual({ value: 2, missing: null, qualityFlags: [] });
  });
});

// ── 외부 리뷰 P2 회귀: 공백 입력 blank 처리 + 검증/계산 해석 통일 ──────────────────────────────
describe('extractCervicalCaseMaxJobCumulativeKgHours — 공백 입력과 숫자 표기 통일', () => {
  const run = (overrides: Parameters<typeof baseCase>[0]) =>
    extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase(overrides)));

  // 기존 필수필드 검사(hasValue)는 공백 문자열을 "입력됨"으로 본다. 엄격 파서는 blank로 본다 —
  // 이 차이 때문에 공백 하중이 value 0(결측 아님)으로 흘러 예측 코호트에 포함됐었다.
  it.each([
    ['하중 "   "(공백)', { load_weight_kg: '   ' }],
    ['하중 "\\t"(탭)', { load_weight_kg: '\t' }],
    ['운반시간 "   "(공백)', { carry_hours_per_shift: '   ' }],
    ['운반시간 "\\t"(탭)', { carry_hours_per_shift: '\t' }],
  ])('%s → value 0이 아니라 플래그 없는 not_entered', (_label, patch) => {
    expect(run({ tasks: [{ ...CORE_TASK, ...patch }] })).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('정상 작업 + 공백 하중 작업 혼합 → 부분합 없이 전체 not_entered', () => {
    const blankTask = { ...CORE_TASK, id: 'task-2', sharedJobId: 'job-2', load_weight_kg: '   ' };
    expect(run({ jobs: [JOB_1, JOB_2], tasks: [CORE_TASK, blankTask] })).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: [],
    });
  });

  it('공백 하중 + 다른 작업의 invalid 혼합 → invalid 우선(not_entered + invalid)', () => {
    const blankTask = { ...CORE_TASK, id: 'task-2', load_weight_kg: '   ' };
    const badTask = { ...CORE_TASK, id: 'task-3', load_weight_kg: 'abc' };
    expect(run({ tasks: [blankTask, badTask] })).toEqual(NOT_ENTERED_INVALID);
  });

  it('비중립 전용 작업의 공백 하중은 대상이 아니므로 정상 합계에 영향이 없다', () => {
    const staleBlank = { ...AWKWARD_TASK, load_weight_kg: '   ', carry_hours_per_shift: '\t' };
    const withStale = run({ tasks: [CORE_TASK, staleBlank] });
    expect(withStale).toEqual(run({ tasks: [CORE_TASK] }));
    expect(withStale.missing).toBeNull();
  });

  // 엄격 파서는 Number()로 '0x2d'를 45로 인정하지만 기존 계산기는 parseFloat('0x2d')=0이라 정상
  // 데이터가 정상적인 0으로 반환됐다. 검증된 수치가 계산에도 그대로 쓰여야 한다.
  it.each([
    ['16진수 하중 "0x2d"(=45)', { load_weight_kg: '0x2d' }],
    ['16진수 운반시간 "0x2"(=2)', { carry_hours_per_shift: '0x2' }],
    ['지수 표기 하중 "4.5e1"(=45)', { load_weight_kg: '4.5e1' }],
    ['앞뒤 공백 하중 " 45 "', { load_weight_kg: ' 45 ' }],
    ['숫자 타입 하중 45', { load_weight_kg: 45 }],
    ['2진수 운반시간 "0b10"(=2)', { carry_hours_per_shift: '0b10' }],
  ])('동등한 숫자 표기가 같은 결과를 낸다 — %s', (_label, patch) => {
    const baseline = run({ tasks: [CORE_TASK] }); // 하중 '45', 운반시간 '2'
    expect(baseline.value).toBeGreaterThan(0);
    expect(run({ tasks: [{ ...CORE_TASK, ...patch }] })).toEqual(baseline);
  });

  it('연간근무일수 "0xfa"(=250)도 계산기(Number())와 검증이 같은 값으로 읽어 기준과 동일하다', () => {
    const baseline = run({ tasks: [CORE_TASK] });
    const jobs = [{ ...JOB_1, workDaysPerYear: '0xfa' }];
    expect(run({ jobs, tasks: [CORE_TASK] })).toEqual(baseline);
  });

  it('16진수 표기가 BK2109 핵심 요건(하중 ≥40, 운반 ≥0.5시간) 판정에도 같은 수치로 쓰인다', () => {
    // 하중 "0x2d"=45 → 핵심 작업 성립, 근무기간·근무일수 검증 경로까지 정상 통과해야 한다.
    const result = run({ tasks: [{ ...CORE_TASK, load_weight_kg: '0x2d', carry_hours_per_shift: '0x2' }] });
    expect(result.missing).toBeNull();
    expect(result.value).toBe(run({ tasks: [CORE_TASK] }).value);
  });
});

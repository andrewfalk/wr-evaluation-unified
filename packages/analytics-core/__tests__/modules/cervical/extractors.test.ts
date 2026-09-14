import { describe, it, expect } from 'vitest';
import {
  extractCervicalCaseMaxJobCumulativeKgHours,
  extractCervicalTaskName,
  extractCervicalTaskExposureTypeShoulderHeavyLoad,
  extractCervicalTaskExposureTypeAwkwardStaticNeckLoad,
  extractCervicalTaskLoadWeightKg,
  extractCervicalTaskCarryHoursPerShift,
  extractCervicalTaskForcedNeckPosture,
  extractCervicalTaskNeckNonneutralHoursPerDay,
  extractCervicalTaskCombinedFlexionRotationPosture,
  extractCervicalTaskPrecisionWork,
} from '../../../modules/cervical/extractors';
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

  it('순서 4: 직력이 2개면 그중 더 큰 누적 총부하량을 case 대표값으로 낸다', () => {
    const jobs = [
      { id: 'job-1', jobName: 'A', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 },
      { id: 'job-2', jobName: 'B', startDate: '2019-01-01', endDate: '2020-01-01', workDaysPerYear: 250 },
    ];
    const smallTask = { ...CORE_TASK, sharedJobId: 'job-2', load_weight_kg: '41' };
    const result = extractCervicalCaseMaxJobCumulativeKgHours(
      migrate(baseCase({ jobs, tasks: [CORE_TASK, smallTask] })),
    );
    expect(result.missing).toBeNull();
    // job-1(10년치)이 job-2(1년치)보다 누적량이 훨씬 크므로 최댓값은 job-1 쪽이어야 한다.
    expect(result.value).toBeGreaterThan(100000);
  });

  it('순서 3b: 비어있지 않은 숫자 필드가 파싱 실패면 invalid qualityFlag(값은 0으로 계산되어 그대로 흘러감)', () => {
    const invalidTask = { ...CORE_TASK, load_weight_kg: 'abc' };
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ tasks: [invalidTask] })));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
    expect(result.value).toBe(0); // heavy_load_present가 false가 되어 bk2109CoreTask 자체가 성립 안 함
  });

  it('순서 3b: BK2109 핵심 task가 있는데 근무기간이 전혀 없으면(NaN 방지) invalid qualityFlag', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공' }]; // startDate/endDate/workPeriodOverride 전부 없음
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
    expect(result.value).toBe(0); // yearsExposed=0 → cumulativeKgHours=0
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

  it('순서 3b: workDaysPerYear가 비숫자 문자열이면 invalid qualityFlag(값은 0으로 조용히 흡수됨)', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 'abc' }];
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
    expect(result.value).toBe(0);
  });

  it('순서 3b: workDaysPerYear가 미입력이면 invalid qualityFlag(값은 0으로 조용히 흡수됨)', () => {
    const jobs = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01' }]; // workDaysPerYear 없음
    const result = extractCervicalCaseMaxJobCumulativeKgHours(migrate(baseCase({ jobs, tasks: [CORE_TASK] })));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
    expect(result.value).toBe(0);
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

// PR0-B4 Slice 7 — 신설 cervical_task grain. spine의 task grain과 완전히 분리된 별도
// grain(계획 결정)이라 별도 테스트 스위트로 검증한다.
describe('cervical_task grain — 모듈 비활성/작업 0건이면 행이 0개(structural_missing 행을 만들지 않는다)', () => {
  it('cervical 모듈이 비활성이면 빈 배열', () => {
    expect(extractCervicalTaskName(migrate(baseCase({ activeModules: [], tasks: [CORE_TASK] })))).toEqual([]);
  });

  it('작업이 0건이면 빈 배열', () => {
    expect(extractCervicalTaskName(migrate(baseCase({ tasks: [] })))).toEqual([]);
  });

  it('entityKey는 [jobId, taskId] 형태다', () => {
    const task = { ...CORE_TASK, id: 'task-1' };
    const result = extractCervicalTaskName(migrate(baseCase({ tasks: [task] })));
    expect(result).toEqual([{ entityKey: ['job-1', 'task-1'], value: '박스 운반', missing: null, qualityFlags: [] }]);
  });
});

describe('extractCervicalTaskName — cervical_task grain(게이트 없음)', () => {
  it('미입력은 not_entered', () => {
    const task = { ...CORE_TASK, name: '' };
    expect(extractCervicalTaskName(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: [],
    });
  });

  it('문자열이 아니면 not_entered + invalid', () => {
    const task = { ...CORE_TASK, name: 123 as unknown as string };
    expect(extractCervicalTaskName(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('배열로 감싼 값이어도 강제변환으로 통과시키지 않는다', () => {
    const task = { ...CORE_TASK, name: ['박스 운반'] as unknown as string };
    expect(extractCervicalTaskName(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });
});

describe('extractCervicalTaskExposureType* — §다중선택 배열 계약(옵션 2개뿐)', () => {
  it('exposure_types가 undefined면 structural_missing', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', name: 'x' };
    expect(extractCervicalTaskExposureTypeShoulderHeavyLoad(migrate(baseCase({ tasks: [task] })))).toEqual([
      { entityKey: ['job-1', 'task-1'], value: null, missing: 'structural_missing', qualityFlags: [] },
    ]);
  });

  it('배열이 아니면 not_entered + invalid', () => {
    const task = { ...CORE_TASK, exposure_types: 'shoulder_heavy_load' as unknown };
    const result = extractCervicalTaskExposureTypeShoulderHeavyLoad(migrate(baseCase({ tasks: [task] })));
    expect(result[0]).toMatchObject({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('배열 원소 중 문자열이 아닌 게 있으면 배열 전체를 거부 — not_entered + invalid', () => {
    const task = { ...CORE_TASK, exposure_types: ['shoulder_heavy_load', 123] as unknown };
    const result = extractCervicalTaskExposureTypeShoulderHeavyLoad(migrate(baseCase({ tasks: [task] })));
    expect(result[0]).toMatchObject({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('빈 배열(명시적으로 둘 다 미선택)이면 옵션별 false', () => {
    const task = { ...CORE_TASK, exposure_types: [] };
    expect(extractCervicalTaskExposureTypeShoulderHeavyLoad(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: false,
      missing: null,
      qualityFlags: [],
    });
  });

  it('정상 배열이면 옵션별 boolean으로 분해된다(선택 안 된 옵션은 false)', () => {
    const task = { ...CORE_TASK, exposure_types: ['shoulder_heavy_load'] };
    expect(extractCervicalTaskExposureTypeShoulderHeavyLoad(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: true,
      missing: null,
      qualityFlags: [],
    });
    expect(extractCervicalTaskExposureTypeAwkwardStaticNeckLoad(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: false,
      missing: null,
      qualityFlags: [],
    });
  });

  it('미지원 옵션값이 섞여 있으면 legacy_unknown 플래그가 붙는다(옵션은 2개뿐)', () => {
    const task = { ...CORE_TASK, exposure_types: ['shoulder_heavy_load', 'retired_option'] };
    expect(extractCervicalTaskExposureTypeShoulderHeavyLoad(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: true,
      missing: null,
      qualityFlags: ['legacy_unknown'],
    });
  });
});

describe('extractCervicalTaskLoadWeightKg/CarryHoursPerShift — shoulder_heavy_load 게이트', () => {
  it('exposure_types에 shoulder_heavy_load가 없으면 게이트가 닫혀 not_applicable', () => {
    const task = { ...CORE_TASK, exposure_types: ['awkward_static_neck_load'], load_weight_kg: '45' };
    expect(extractCervicalTaskLoadWeightKg(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_applicable',
      qualityFlags: [],
    });
  });

  it('exposure_types가 손상돼도(배열 아님) 런타임과 동일하게 게이트가 닫힌 것으로 본다', () => {
    const task = { ...CORE_TASK, exposure_types: 'not-an-array' as unknown, load_weight_kg: '45' };
    expect(extractCervicalTaskLoadWeightKg(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_applicable',
    });
  });

  it('게이트가 열려 있는데 미입력이면 not_entered(무플래그)', () => {
    const task = { ...CORE_TASK, load_weight_kg: '' };
    expect(extractCervicalTaskLoadWeightKg(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: [],
    });
  });

  it('정상 숫자 문자열은 그대로 통과', () => {
    const task = { ...CORE_TASK, load_weight_kg: '45' };
    expect(extractCervicalTaskLoadWeightKg(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: 45,
      missing: null,
      qualityFlags: [],
    });
  });

  it('0은 유효한 값이다(물리량 하한)', () => {
    const task = { ...CORE_TASK, load_weight_kg: 0 };
    expect(extractCervicalTaskLoadWeightKg(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: 0,
      missing: null,
      qualityFlags: [],
    });
  });

  it('음수·숫자 접두부만 있는 문자열은 invalid', () => {
    const negative = { ...CORE_TASK, load_weight_kg: -5 };
    expect(extractCervicalTaskLoadWeightKg(migrate(baseCase({ tasks: [negative] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
    const partial = { ...CORE_TASK, carry_hours_per_shift: '2kg' };
    expect(extractCervicalTaskCarryHoursPerShift(migrate(baseCase({ tasks: [partial] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('배열로 감싼 유효 숫자·빈 배열([])·[null] 모두 강제변환으로 통과시키지 않는다', () => {
    for (const bad of [[45], [], [null]]) {
      const task = { ...CORE_TASK, load_weight_kg: bad as unknown };
      expect(extractCervicalTaskLoadWeightKg(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
        value: null,
        missing: 'not_entered',
        qualityFlags: ['invalid'],
      });
    }
  });
});

describe('extractCervicalTaskForcedNeckPosture — shoulder_heavy_load 게이트, yes/no 문자열', () => {
  it('게이트가 닫혀 있으면 not_applicable', () => {
    const task = { ...CORE_TASK, exposure_types: [], forced_neck_posture: 'yes' };
    expect(extractCervicalTaskForcedNeckPosture(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_applicable',
    });
  });

  it('게이트가 열려 있는데 미입력이면 not_entered(무플래그)', () => {
    const task = { ...CORE_TASK, forced_neck_posture: '' };
    expect(extractCervicalTaskForcedNeckPosture(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: [],
    });
  });

  it('"yes"/"no"는 boolean으로 변환된다', () => {
    expect(extractCervicalTaskForcedNeckPosture(migrate(baseCase({ tasks: [{ ...CORE_TASK, forced_neck_posture: 'yes' }] })))[0]).toMatchObject({
      value: true,
      missing: null,
    });
    expect(extractCervicalTaskForcedNeckPosture(migrate(baseCase({ tasks: [{ ...CORE_TASK, forced_neck_posture: 'no' }] })))[0]).toMatchObject({
      value: false,
      missing: null,
    });
  });

  it('도메인 밖 값(boolean true 등)은 강제변환하지 않고 invalid', () => {
    const task = { ...CORE_TASK, forced_neck_posture: true as unknown as string };
    expect(extractCervicalTaskForcedNeckPosture(migrate(baseCase({ tasks: [task] })))[0]).toMatchObject({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });
});

describe('awkward_static_neck_load 게이트 필드 3종 — neckNonneutralHoursPerDay/combinedFlexionRotationPosture/precisionWork', () => {
  const AWKWARD_TASK = {
    sharedJobId: 'job-1',
    name: '조립',
    exposure_types: ['awkward_static_neck_load'],
    neck_nonneutral_hours_per_day: '3',
    combined_flexion_rotation_posture: 'yes',
    precision_work: 'no',
  };

  it('게이트가 닫혀 있으면(shoulder_heavy_load만 선택) 셋 다 not_applicable', () => {
    const task = { ...AWKWARD_TASK, exposure_types: ['shoulder_heavy_load'] };
    const mr = migrate(baseCase({ tasks: [task] }));
    expect(extractCervicalTaskNeckNonneutralHoursPerDay(mr)[0]).toMatchObject({ value: null, missing: 'not_applicable' });
    expect(extractCervicalTaskCombinedFlexionRotationPosture(mr)[0]).toMatchObject({ value: null, missing: 'not_applicable' });
    expect(extractCervicalTaskPrecisionWork(mr)[0]).toMatchObject({ value: null, missing: 'not_applicable' });
  });

  it('게이트가 열려 있으면 정상 추출된다', () => {
    const mr = migrate(baseCase({ tasks: [AWKWARD_TASK] }));
    expect(extractCervicalTaskNeckNonneutralHoursPerDay(mr)[0]).toMatchObject({ value: 3, missing: null });
    expect(extractCervicalTaskCombinedFlexionRotationPosture(mr)[0]).toMatchObject({ value: true, missing: null });
    expect(extractCervicalTaskPrecisionWork(mr)[0]).toMatchObject({ value: false, missing: null });
  });

  it('두 노출유형이 동시에 선택되면 두 게이트 모두 열린다(상호 배타 아님)', () => {
    const task = { ...CORE_TASK, ...AWKWARD_TASK, exposure_types: ['shoulder_heavy_load', 'awkward_static_neck_load'] };
    const mr = migrate(baseCase({ tasks: [task] }));
    expect(extractCervicalTaskLoadWeightKg(mr)[0].missing).toBeNull();
    expect(extractCervicalTaskNeckNonneutralHoursPerDay(mr)[0].missing).toBeNull();
  });
});

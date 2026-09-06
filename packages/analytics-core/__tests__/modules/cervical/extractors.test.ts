import { describe, it, expect } from 'vitest';
import { extractCervicalCaseMaxJobCumulativeKgHours } from '../../../modules/cervical/extractors';
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

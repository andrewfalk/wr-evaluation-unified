import { describe, it, expect } from 'vitest';
import { enumerateVibrationIntervalEntities, enumerateDiagnosisSideEntities, enumerateJobEntities, enumerateTaskEntities } from '../grainEntities';
import { deterministicMigrate } from '../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

const JOBS = [{ id: 'job-1', jobName: '조립공' }];

function baseCase(overrides: {
  jobs?: unknown[];
  spineModule?: Record<string, unknown>;
  activeModules?: string[];
  includeSpineModule?: boolean;
}) {
  const { jobs = JOBS, spineModule = {}, activeModules = ['spine'], includeSpineModule = true } = overrides;
  return {
    data: {
      shared: { jobs },
      modules: includeSpineModule ? { spine: spineModule } : {},
      activeModules,
    },
  };
}

describe('enumerateVibrationIntervalEntities', () => {
  it('spine 모듈이 activeModules에 없으면 빈 배열(관측 행 0개)', () => {
    const entities = enumerateVibrationIntervalEntities(
      migrate(baseCase({ activeModules: [], spineModule: { vibrationIntervals: [{ id: 'iv-1' }] } })),
    );
    expect(entities).toEqual([]);
  });

  it('data.modules.spine이 plain object가 아니면 빈 배열', () => {
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ includeSpineModule: false })));
    expect(entities).toEqual([]);
  });

  it('vibrationIntervals가 없거나 빈 배열이면 빈 배열', () => {
    expect(enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: {} })))).toEqual([]);
    expect(enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [] } })))).toEqual([]);
  });

  it('정상 입력 — id+sharedJobId가 있으면 entityKey=[jobId, id], flag 없음', () => {
    const interval = { id: 'iv-1', sharedJobId: 'job-1', awMax: 1.5 };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [interval] } })));
    expect(entities).toEqual([{ entityKey: ['job-1', 'iv-1'], source: interval, qualityFlags: [] }]);
  });

  it('id가 결측이면 배열 index 기반으로 결정적으로 보정하고 invalid 플래그를 붙인다', () => {
    const interval = { sharedJobId: 'job-1', awMax: 1.5 };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [interval] } })));
    expect(entities).toHaveLength(1);
    expect(entities[0].entityKey).toEqual(['job-1', '__missing_0']);
    expect(entities[0].qualityFlags).toEqual(['invalid']);

    // 결정성 — 동일 payload로 다시 열거해도 같은 결과.
    const again = enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [interval] } })));
    expect(again).toEqual(entities);
  });

  it('id가 숫자여도 문자열로 정규화된다(spine task/vibrationInterval 팩토리가 Date.now()+Math.random() 숫자 id를 생성)', () => {
    const interval = { id: 12345.6789, sharedJobId: 'job-1' };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [interval] } })));
    expect(entities[0].entityKey).toEqual(['job-1', '12345.6789']);
  });

  it('중복 id는 유일해질 때까지 suffix를 붙이고 invalid 플래그를 붙인다', () => {
    const a = { id: 'dup', sharedJobId: 'job-1' };
    const b = { id: 'dup', sharedJobId: 'job-1' };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [a, b] } })));
    expect(entities).toHaveLength(2);
    expect(entities[0].entityKey).toEqual(['job-1', 'dup']);
    expect(entities[0].qualityFlags).toEqual([]);
    expect(entities[1].entityKey).toEqual(['job-1', 'dup#1']);
    expect(entities[1].qualityFlags).toEqual(['invalid']);
    // entityKey 유일성 — 실제로 겹치지 않는지 직접 확인.
    const serialized = entities.map((e) => JSON.stringify(e.entityKey));
    expect(new Set(serialized).size).toBe(2);
  });

  it('보정된 id끼리도 다시 충돌하면(원본에 dup/dup#1/dup이 섞임) 계속 증가시켜 유일하게 만든다', () => {
    const a = { id: 'dup', sharedJobId: 'job-1' };
    const b = { id: 'dup#1', sharedJobId: 'job-1' };
    const c = { id: 'dup', sharedJobId: 'job-1' };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [a, b, c] } })));
    const localIds = entities.map((e) => e.entityKey[1]);
    expect(new Set(localIds).size).toBe(3); // 전부 유일
    expect(localIds).toEqual(['dup', 'dup#1', 'dup#2']); // c는 dup#1도 이미 있으니 dup#2로
  });

  it('sharedJobId가 없으면 첫 직력에 귀속(groupIntervalsByJob과 동일 규칙)', () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const interval = { id: 'iv-1' };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ jobs, spineModule: { vibrationIntervals: [interval] } })));
    expect(entities[0].entityKey).toEqual(['job-1', 'iv-1']);
  });

  it('직력이 아예 없으면 resolvedJobId는 빈 문자열', () => {
    const interval = { id: 'iv-1' };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ jobs: [], spineModule: { vibrationIntervals: [interval] } })));
    expect(entities[0].entityKey).toEqual(['', 'iv-1']);
  });

  it('존재하지 않는 job을 가리키는 sharedJobId는 orphan_reference 플래그가 붙지만 엔터티는 그대로 만든다', () => {
    const interval = { id: 'iv-1', sharedJobId: 'no-such-job' };
    const entities = enumerateVibrationIntervalEntities(migrate(baseCase({ spineModule: { vibrationIntervals: [interval] } })));
    expect(entities[0].entityKey).toEqual(['no-such-job', 'iv-1']);
    expect(entities[0].qualityFlags).toEqual(['orphan_reference']);
  });

  it('배열 원소 방어: vibrationIntervals에 null/비객체가 섞여 있어도 예외를 던지지 않고 걸러낸다', () => {
    const valid = { id: 'iv-1', sharedJobId: 'job-1' };
    expect(() =>
      enumerateVibrationIntervalEntities(
        migrate(baseCase({ spineModule: { vibrationIntervals: [null, 'not-an-object', 42, valid] } })),
      ),
    ).not.toThrow();
    const entities = enumerateVibrationIntervalEntities(
      migrate(baseCase({ spineModule: { vibrationIntervals: [null, 'not-an-object', 42, valid] } })),
    );
    expect(entities).toEqual([{ entityKey: ['job-1', 'iv-1'], source: valid, qualityFlags: [] }]);
  });

  it('vibrationIntervals 자체가 배열이 아니면(손상 데이터) 빈 배열', () => {
    const entities = enumerateVibrationIntervalEntities(
      migrate(baseCase({ spineModule: { vibrationIntervals: 'not-an-array' as unknown } })),
    );
    expect(entities).toEqual([]);
  });
});

// PR0-B3 Part C-2 — task grain. enumerateVibrationIntervalEntities와 정확히 같은 job 귀속
// 규칙(sharedJobId 우선 → 첫 직력 → orphan_reference)을 공유하므로, 그 계약이 이미 상세히
// 검증된 케이스를 전부 반복하지 않고 핵심 경로만 확인한다.
describe('enumerateTaskEntities', () => {
  it('spine 모듈이 activeModules에 없으면 빈 배열(관측 행 0개)', () => {
    const entities = enumerateTaskEntities(
      migrate(baseCase({ activeModules: [], spineModule: { tasks: [{ id: 'task-1' }] } })),
    );
    expect(entities).toEqual([]);
  });

  it('tasks가 없거나 빈 배열이면 빈 배열', () => {
    expect(enumerateTaskEntities(migrate(baseCase({ spineModule: {} })))).toEqual([]);
    expect(enumerateTaskEntities(migrate(baseCase({ spineModule: { tasks: [] } })))).toEqual([]);
  });

  it('정상 입력 — id+sharedJobId가 있으면 entityKey=[jobId, id], flag 없음', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', weight: 15, frequency: 80 };
    const entities = enumerateTaskEntities(migrate(baseCase({ spineModule: { tasks: [task] } })));
    expect(entities).toEqual([{ entityKey: ['job-1', 'task-1'], source: task, qualityFlags: [] }]);
  });

  it('id가 결측이면 배열 index 기반으로 결정적으로 보정하고 invalid 플래그를 붙인다', () => {
    const task = { sharedJobId: 'job-1', weight: 15 };
    const entities = enumerateTaskEntities(migrate(baseCase({ spineModule: { tasks: [task] } })));
    expect(entities[0].entityKey).toEqual(['job-1', '__missing_0']);
    expect(entities[0].qualityFlags).toEqual(['invalid']);
  });

  it('sharedJobId가 없으면 첫 직력에 귀속', () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const task = { id: 'task-1' };
    const entities = enumerateTaskEntities(migrate(baseCase({ jobs, spineModule: { tasks: [task] } })));
    expect(entities[0].entityKey).toEqual(['job-1', 'task-1']);
  });

  it('존재하지 않는 job을 가리키는 sharedJobId는 orphan_reference 플래그가 붙지만 엔터티는 그대로 만든다', () => {
    const task = { id: 'task-1', sharedJobId: 'no-such-job' };
    const entities = enumerateTaskEntities(migrate(baseCase({ spineModule: { tasks: [task] } })));
    expect(entities[0].qualityFlags).toEqual(['orphan_reference']);
  });

  it('배열 원소 방어: tasks에 null/비객체가 섞여 있어도 예외를 던지지 않고 걸러낸다', () => {
    const valid = { id: 'task-1', sharedJobId: 'job-1' };
    expect(() =>
      enumerateTaskEntities(migrate(baseCase({ spineModule: { tasks: [null, 'not-an-object', 42, valid] } }))),
    ).not.toThrow();
    const entities = enumerateTaskEntities(
      migrate(baseCase({ spineModule: { tasks: [null, 'not-an-object', 42, valid] } })),
    );
    expect(entities).toEqual([{ entityKey: ['job-1', 'task-1'], source: valid, qualityFlags: [] }]);
  });

  it('tasks 자체가 배열이 아니면(손상 데이터) 빈 배열', () => {
    const entities = enumerateTaskEntities(migrate(baseCase({ spineModule: { tasks: 'not-an-array' as unknown } })));
    expect(entities).toEqual([]);
  });
});

// PR0-B3 Part B — diagnosis_side grain. shared.diagnoses[]는 activeModules/spine 모듈과
// 무관하게 독립적으로 존재하므로(무릎/어깨 등 다른 모듈 진단도 이 배열에 함께 담김),
// 위 vibration_interval과 달리 spine 모듈 활성 여부를 검사하지 않는다.
function diagnosesCase(diagnoses: unknown[]) {
  return { data: { shared: { diagnoses }, modules: {}, activeModules: [] } };
}

describe('enumerateDiagnosisSideEntities', () => {
  it('shared.diagnoses가 없거나 빈 배열이면 빈 배열', () => {
    expect(enumerateDiagnosisSideEntities(migrate({ data: { shared: {}, modules: {}, activeModules: [] } }))).toEqual([]);
    expect(enumerateDiagnosisSideEntities(migrate(diagnosesCase([])))).toEqual([]);
  });

  it('code/name이 둘 다 공백인 빈 placeholder 진단은 엔터티를 만들지 않는다', () => {
    const placeholder = { id: 'dx-1', code: '', name: '', side: '' };
    expect(enumerateDiagnosisSideEntities(migrate(diagnosesCase([placeholder])))).toEqual([]);
  });

  it('side가 both면 right/left 두 엔터티로 explode한다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both' };
    const entities = enumerateDiagnosisSideEntities(migrate(diagnosesCase([dx])));
    expect(entities).toHaveLength(2);
    expect(entities.map((e) => e.entityKey)).toEqual([
      ['dx-1', 'right'],
      ['dx-1', 'left'],
    ]);
    expect(entities[0].source).toEqual({ diagnosis: dx, side: 'right' });
    expect(entities[1].source).toEqual({ diagnosis: dx, side: 'left' });
  });

  it('side가 right/left면 그 하나만 엔터티로 만든다', () => {
    const right = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right' };
    const left = { id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'left' };
    const entities = enumerateDiagnosisSideEntities(migrate(diagnosesCase([right, left])));
    expect(entities.map((e) => e.entityKey)).toEqual([
      ['dx-1', 'right'],
      ['dx-2', 'left'],
    ]);
  });

  it('side가 공백/미인식이면 unspecified 하나로 만든다(드롭하지 않는다)', () => {
    const blank = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', side: '' };
    const entities = enumerateDiagnosisSideEntities(migrate(diagnosesCase([blank])));
    expect(entities).toEqual([{ entityKey: ['dx-1', 'unspecified'], source: { diagnosis: blank, side: 'unspecified' }, qualityFlags: [] }]);
  });

  it('id가 결측이면 배열 index 기반으로 결정적으로 보정하고 invalid 플래그를 붙인다(both explode 두 엔터티 모두에 반영)', () => {
    const dx = { code: 'M17.1', name: '무릎관절증', side: 'both' }; // id 없음
    const entities = enumerateDiagnosisSideEntities(migrate(diagnosesCase([dx])));
    expect(entities).toHaveLength(2);
    expect(entities[0].entityKey).toEqual(['__missing_0', 'right']);
    expect(entities[1].entityKey).toEqual(['__missing_0', 'left']);
    expect(entities[0].qualityFlags).toEqual(['invalid']);
    expect(entities[1].qualityFlags).toEqual(['invalid']);
  });

  it('중복 id는 유일해질 때까지 suffix를 붙이고 invalid 플래그를 붙인다', () => {
    const a = { id: 'dup', code: 'M17.1', name: '무릎관절증A', side: 'right' };
    const b = { id: 'dup', code: 'M17.2', name: '무릎관절증B', side: 'right' };
    const entities = enumerateDiagnosisSideEntities(migrate(diagnosesCase([a, b])));
    expect(entities).toHaveLength(2);
    expect(entities[0].entityKey).toEqual(['dup', 'right']);
    expect(entities[0].qualityFlags).toEqual([]);
    expect(entities[1].entityKey).toEqual(['dup#1', 'right']);
    expect(entities[1].qualityFlags).toEqual(['invalid']);
  });

  it('배열 원소 방어: diagnoses에 null/비객체가 섞여 있어도 예외를 던지지 않고 걸러낸다', () => {
    const valid = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right' };
    expect(() => enumerateDiagnosisSideEntities(migrate(diagnosesCase([null, 'not-an-object', 42, valid])))).not.toThrow();
    const entities = enumerateDiagnosisSideEntities(migrate(diagnosesCase([null, 'not-an-object', 42, valid])));
    expect(entities).toEqual([{ entityKey: ['dx-1', 'right'], source: { diagnosis: valid, side: 'right' }, qualityFlags: [] }]);
  });

  it('diagnoses 자체가 배열이 아니면(손상 데이터) 빈 배열', () => {
    const entities = enumerateDiagnosisSideEntities(
      migrate({ data: { shared: { diagnoses: 'not-an-array' as unknown }, modules: {}, activeModules: [] } }),
    );
    expect(entities).toEqual([]);
  });

  it('결정성 — 동일 payload로 두 번 열거해도 동일한 결과', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both' };
    const payload = diagnosesCase([dx]);
    const first = enumerateDiagnosisSideEntities(migrate(payload));
    const second = enumerateDiagnosisSideEntities(migrate(payload));
    expect(first).toEqual(second);
  });
});

// PR0-B3 Part C — job grain. shared.jobs[]는 diagnosis_side와 마찬가지로 activeModules와
// 무관하게 독립적으로 존재한다(어떤 모듈이든 sharedJobId로 참조하는 공유 필드).
function jobsCase(jobs: unknown[]) {
  return { data: { shared: { jobs }, modules: {}, activeModules: [] } };
}

describe('enumerateJobEntities', () => {
  it('shared.jobs가 없거나 빈 배열이면 빈 배열', () => {
    expect(enumerateJobEntities(migrate({ data: { shared: {}, modules: {}, activeModules: [] } }))).toEqual([]);
    expect(enumerateJobEntities(migrate(jobsCase([])))).toEqual([]);
  });

  it('jobName·startDate·endDate·workPeriodOverride가 전부 공백인 빈 placeholder 직력은 엔터티를 만들지 않는다', () => {
    const placeholder = { id: 'job-1', jobName: '', startDate: '', endDate: '', workPeriodOverride: '', workDaysPerYear: 250 };
    expect(enumerateJobEntities(migrate(jobsCase([placeholder])))).toEqual([]);
  });

  it('jobName만 있어도(기간 미입력) 실제 직력으로 엔터티를 만든다', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '', endDate: '', workPeriodOverride: '' };
    const entities = enumerateJobEntities(migrate(jobsCase([job])));
    expect(entities).toEqual([{ entityKey: ['job-1'], source: job, qualityFlags: [] }]);
  });

  it('jobName은 공백이어도 기간만 있으면 실제 직력으로 엔터티를 만든다', () => {
    const job = { id: 'job-1', jobName: '', startDate: '2020-01-01', endDate: '2021-01-01' };
    const entities = enumerateJobEntities(migrate(jobsCase([job])));
    expect(entities).toHaveLength(1);
    expect(entities[0].entityKey).toEqual(['job-1']);
  });

  it('id가 결측이면 배열 index 기반으로 결정적으로 보정하고 invalid 플래그를 붙인다', () => {
    const job = { jobName: '용접공' }; // id 없음
    const entities = enumerateJobEntities(migrate(jobsCase([job])));
    expect(entities).toEqual([{ entityKey: ['__missing_0'], source: job, qualityFlags: ['invalid'] }]);
  });

  it('중복 id는 유일해질 때까지 suffix를 붙이고 invalid 플래그를 붙인다', () => {
    const a = { id: 'dup', jobName: '용접공A' };
    const b = { id: 'dup', jobName: '용접공B' };
    const entities = enumerateJobEntities(migrate(jobsCase([a, b])));
    expect(entities).toHaveLength(2);
    expect(entities[0].entityKey).toEqual(['dup']);
    expect(entities[0].qualityFlags).toEqual([]);
    expect(entities[1].entityKey).toEqual(['dup#1']);
    expect(entities[1].qualityFlags).toEqual(['invalid']);
  });

  it('배열 원소 방어: jobs에 null/비객체가 섞여 있어도 예외를 던지지 않고 걸러낸다', () => {
    const valid = { id: 'job-1', jobName: '용접공' };
    expect(() => enumerateJobEntities(migrate(jobsCase([null, 'not-an-object', 42, valid])))).not.toThrow();
    const entities = enumerateJobEntities(migrate(jobsCase([null, 'not-an-object', 42, valid])));
    expect(entities).toEqual([{ entityKey: ['job-1'], source: valid, qualityFlags: [] }]);
  });

  it('jobs 자체가 배열이 아니면(손상 데이터) 빈 배열', () => {
    const entities = enumerateJobEntities(
      migrate({ data: { shared: { jobs: 'not-an-array' as unknown }, modules: {}, activeModules: [] } }),
    );
    expect(entities).toEqual([]);
  });

  it('결정성 — 동일 payload로 두 번 열거해도 동일한 결과', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '2020-01-01', endDate: '2021-01-01' };
    const payload = jobsCase([job]);
    const first = enumerateJobEntities(migrate(payload));
    const second = enumerateJobEntities(migrate(payload));
    expect(first).toEqual(second);
  });
});

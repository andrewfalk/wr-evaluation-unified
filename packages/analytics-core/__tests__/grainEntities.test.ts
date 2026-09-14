import { describe, it, expect } from 'vitest';
import { enumerateVibrationIntervalEntities, enumerateDiagnosisSideEntities, enumerateJobEntities, enumerateTaskEntities, enumerateCervicalTaskEntities, enumerateJobDiagnosisEntities } from '../grainEntities';
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

// PR0-B4 Slice 7 — cervical_task grain. spine의 task grain과 완전히 분리된 별도 grain
// (계획 결정)이라도 job 귀속 규칙 자체는 동일해 위 enumerateTaskEntities 케이스를 그대로
// 반복하지 않고 "spine과 독립적인 별도 gate/데이터 소스"라는 이 grain만의 차이점만 확인한다.
function cervicalBaseCase(overrides: {
  jobs?: unknown[];
  cervicalModule?: Record<string, unknown>;
  activeModules?: string[];
  includeCervicalModule?: boolean;
}) {
  const { jobs = JOBS, cervicalModule = {}, activeModules = ['cervical'], includeCervicalModule = true } = overrides;
  return {
    data: {
      shared: { jobs },
      modules: includeCervicalModule ? { cervical: cervicalModule } : {},
      activeModules,
    },
  };
}

describe('enumerateCervicalTaskEntities', () => {
  it('cervical 모듈이 activeModules에 없으면 빈 배열(관측 행 0개)', () => {
    const entities = enumerateCervicalTaskEntities(
      migrate(cervicalBaseCase({ activeModules: [], cervicalModule: { tasks: [{ id: 'task-1' }] } })),
    );
    expect(entities).toEqual([]);
  });

  it('data.modules.cervical이 plain object가 아니면 빈 배열', () => {
    const entities = enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ includeCervicalModule: false })));
    expect(entities).toEqual([]);
  });

  it('tasks가 없거나 빈 배열이면 빈 배열', () => {
    expect(enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ cervicalModule: {} })))).toEqual([]);
    expect(enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ cervicalModule: { tasks: [] } })))).toEqual([]);
  });

  it('정상 입력 — id+sharedJobId가 있으면 entityKey=[jobId, id], flag 없음', () => {
    const task = { id: 'task-1', sharedJobId: 'job-1', name: '박스 운반' };
    const entities = enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ cervicalModule: { tasks: [task] } })));
    expect(entities).toEqual([{ entityKey: ['job-1', 'task-1'], source: task, qualityFlags: [] }]);
  });

  it('spine이 활성이어도 cervical이 비활성이면 이 grain은 영향받지 않는다(완전 분리 확인)', () => {
    const payload = {
      data: {
        shared: { jobs: JOBS },
        modules: { spine: { tasks: [{ id: 'spine-task-1', sharedJobId: 'job-1' }] } },
        activeModules: ['spine'],
      },
    };
    expect(enumerateCervicalTaskEntities(migrate(payload))).toEqual([]);
    // 같은 case에서 spine의 task grain은 정상 동작 — 두 grain이 서로의 데이터를 넘보지 않는다.
    expect(enumerateTaskEntities(migrate(payload))).toHaveLength(1);
  });

  it('id가 결측이면 배열 index 기반으로 결정적으로 보정하고 invalid 플래그를 붙인다', () => {
    const task = { sharedJobId: 'job-1', name: '박스 운반' };
    const entities = enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ cervicalModule: { tasks: [task] } })));
    expect(entities[0].entityKey).toEqual(['job-1', '__missing_0']);
    expect(entities[0].qualityFlags).toEqual(['invalid']);
  });

  it('sharedJobId가 없으면 첫 직력에 귀속', () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const task = { id: 'task-1' };
    const entities = enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ jobs, cervicalModule: { tasks: [task] } })));
    expect(entities[0].entityKey).toEqual(['job-1', 'task-1']);
  });

  it('존재하지 않는 job을 가리키는 sharedJobId는 orphan_reference 플래그가 붙지만 엔터티는 그대로 만든다', () => {
    const task = { id: 'task-1', sharedJobId: 'no-such-job' };
    const entities = enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ cervicalModule: { tasks: [task] } })));
    expect(entities[0].qualityFlags).toEqual(['orphan_reference']);
  });

  it('배열 원소 방어: tasks에 null/비객체가 섞여 있어도 예외를 던지지 않고 걸러낸다', () => {
    const valid = { id: 'task-1', sharedJobId: 'job-1' };
    expect(() =>
      enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ cervicalModule: { tasks: [null, 'not-an-object', 42, valid] } }))),
    ).not.toThrow();
    const entities = enumerateCervicalTaskEntities(
      migrate(cervicalBaseCase({ cervicalModule: { tasks: [null, 'not-an-object', 42, valid] } })),
    );
    expect(entities).toEqual([{ entityKey: ['job-1', 'task-1'], source: valid, qualityFlags: [] }]);
  });

  it('tasks 자체가 배열이 아니면(손상 데이터) 빈 배열', () => {
    const entities = enumerateCervicalTaskEntities(migrate(cervicalBaseCase({ cervicalModule: { tasks: 'not-an-array' as unknown } })));
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

// PR0-B4 Slice 8b — job_diagnosis grain. normalizeElbowModuleData/normalizeWristModuleData가
// 만드는 cross join(§job_diagnosis 계약)을 그대로 재사용하므로, 여기서는 "그 계약이 실제로
// 재현되는가"(cross join, 모듈 분리, dedup, ':' 제외)만 검증한다 — 정규화 자체의 상세 동작은
// legacyNormalize.ts를 직접 쓰는 elbow/wrist derived.test.ts가 이미 검증한다.
describe('enumerateJobDiagnosisEntities', () => {
  const JOBS = [{ id: 'job-1', jobName: '조립공' }];
  const ELBOW_DX = { id: 'dx-e1', code: 'M770', name: '', moduleId: 'elbow', side: 'right' };
  const WRIST_DX = { id: 'dx-w1', code: 'Z00', name: '', moduleId: 'wrist', side: 'right' };

  function jobDiagnosisCase(overrides: {
    jobs?: unknown[];
    diagnoses?: unknown[];
    activeModules?: string[];
    elbow?: Record<string, unknown> | null;
    wrist?: Record<string, unknown> | null;
  }) {
    const { jobs = JOBS, diagnoses = [], activeModules = [], elbow = null, wrist = null } = overrides;
    const modules: Record<string, unknown> = {};
    if (elbow !== null) modules.elbow = elbow;
    if (wrist !== null) modules.wrist = wrist;
    return { data: { shared: { jobs, diagnoses }, modules, activeModules } };
  }

  it('elbow만 활성이면 elbow 진단만 cross join으로 나온다', () => {
    const entities = enumerateJobDiagnosisEntities(
      migrate(jobDiagnosisCase({ diagnoses: [ELBOW_DX, WRIST_DX], activeModules: ['elbow'], elbow: { jobEvaluations: [] } })),
    );
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ entityKey: ['job-1', 'dx-e1'], source: { moduleId: 'elbow' } });
  });

  it('elbow+wrist 동시 활성 — 전체 entity 수는 elbow(잡×진단) + wrist(잡×진단)', () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [ELBOW_DX, WRIST_DX],
          activeModules: ['elbow', 'wrist'],
          elbow: { jobEvaluations: [] },
          wrist: { jobEvaluations: [] },
        }),
      ),
    );
    // elbow: 2 jobs × 1 diagnosis = 2, wrist: 2 jobs × 1 diagnosis = 2 → 총 4.
    expect(entities).toHaveLength(4);
    const elbowKeys = entities.filter((e) => e.source.moduleId === 'elbow').map((e) => e.entityKey);
    const wristKeys = entities.filter((e) => e.source.moduleId === 'wrist').map((e) => e.entityKey);
    expect(elbowKeys.sort()).toEqual([['job-1', 'dx-e1'], ['job-2', 'dx-e1']].sort());
    expect(wristKeys.sort()).toEqual([['job-1', 'dx-w1'], ['job-2', 'dx-w1']].sort());
  });

  it('두 모듈 다 비활성이면 빈 배열', () => {
    const entities = enumerateJobDiagnosisEntities(
      migrate(jobDiagnosisCase({ diagnoses: [ELBOW_DX, WRIST_DX], activeModules: [] })),
    );
    expect(entities).toEqual([]);
  });

  it("':' 포함 id는 job/diagnosis 양쪽에서 분석 대상에서 제외된다", () => {
    const badJob = { id: 'job:1' };
    const badDx = { id: 'dx:1', code: 'M770', name: '', moduleId: 'elbow', side: 'right' };
    const entities = enumerateJobDiagnosisEntities(
      migrate(jobDiagnosisCase({ jobs: [badJob], diagnoses: [badDx], activeModules: ['elbow'], elbow: { jobEvaluations: [] } })),
    );
    expect(entities).toEqual([]);
  });

  it('중복 job id·diagnosis id는 첫 번째 등장만 채택(dedup)', () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-1', jobName: 'dup' }];
    const diagnoses = [ELBOW_DX, { ...ELBOW_DX, name: 'dup' }];
    const entities = enumerateJobDiagnosisEntities(
      migrate(jobDiagnosisCase({ jobs, diagnoses, activeModules: ['elbow'], elbow: { jobEvaluations: [] } })),
    );
    expect(entities).toHaveLength(1);
    expect(entities[0].entityKey).toEqual(['job-1', 'dx-e1']);
  });

  it('entityKey는 [jobId, diagnosisId] 2원소 배열이다(콜론 결합 문자열 아님)', () => {
    const entities = enumerateJobDiagnosisEntities(
      migrate(jobDiagnosisCase({ diagnoses: [ELBOW_DX], activeModules: ['elbow'], elbow: { jobEvaluations: [] } })),
    );
    expect(entities[0].entityKey).toEqual(['job-1', 'dx-e1']);
    expect(entities[0].entityKey).toHaveLength(2);
  });

  it('결정성 — 동일 payload로 두 번 열거해도 동일한 결과', () => {
    const payload = jobDiagnosisCase({ diagnoses: [ELBOW_DX, WRIST_DX], activeModules: ['elbow', 'wrist'], elbow: { jobEvaluations: [] }, wrist: { jobEvaluations: [] } });
    const first = enumerateJobDiagnosisEntities(migrate(payload));
    const second = enumerateJobDiagnosisEntities(migrate(payload));
    expect(first).toEqual(second);
  });

  // 9차 검토 P2 재현 — ':' 포함 id로 첫 직력이 배제되면, buildLegacyEntryMap
  // (legacyNormalize.ts)이 linkedJobId 없는 레거시 항목을 그 "첫 직력"에 귀속시키는데,
  // 배제 필터를 정규화 호출 *이전에* 적용하면 정규화 내부의 firstJobId가 실제로는 두
  // 번째 직력으로 바뀌어 그 값이 엉뚱한 직력으로 옮겨 붙는다. dedup은 정규화 호출 전에,
  // ':' 배제는 정규화 이후 엔터티 생성 시점에 적용해야 값이 새지 않는다.
  it('제외된 첫 직력(：포함 id)의 레거시 노출값이 다른 직력으로 옮겨 붙지 않는다', () => {
    const jobs = [{ id: 'legacy:job' }, { id: 'job-b' }];
    const legacyEntry = {
      diagnosisId: 'dx-e1',
      // linkedJobId 없음 — buildLegacyEntryMap 기준 firstJobId(원래는 'legacy:job')에 귀속돼야 한다.
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [ELBOW_DX],
          activeModules: ['elbow'],
          elbow: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    // 'legacy:job'은 ':' 포함이라 엔터티 자체가 없다 — 'job-b'만 남아야 한다.
    expect(entities).toHaveLength(1);
    expect(entities[0].entityKey).toEqual(['job-b', 'dx-e1']);
    // job-b는 이 레거시 값과 무관한 직력이므로 daily_exposure_hours가 8로 새면 안 된다
    // (기본값인 빈 문자열 그대로여야 한다).
    expect(entities[0].source.entry.daily_exposure_hours).toBe('');
  });

  it('wrist에서도 동일한 보호가 적용된다', () => {
    const jobs = [{ id: 'legacy:job' }, { id: 'job-b' }];
    const legacyEntry = {
      diagnosisId: 'dx-w1',
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [WRIST_DX],
          activeModules: ['wrist'],
          wrist: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    expect(entities).toHaveLength(1);
    expect(entities[0].entityKey).toEqual(['job-b', 'dx-w1']);
    expect(entities[0].source.entry.daily_exposure_hours).toBe('');
  });

  // 10차 검토 P2 재현 — 9차 수정은 ':' 포함 id만 정규화 호출 이후로 배제 시점을 옮겼을
  // 뿐, 숫자·빈 문자열·undefined id를 가진 첫 직력은 여전히 정규화 호출 *전에* dedup
  // 필터에서 제거돼 같은 버그가 재현됐다. 셋 다 buildLegacyEntryMap 기준으로는 서로 다른
  // 경로를 타지만(숫자는 실제로 그 직력에 귀속된 뒤 출력 단계에서 배제되고, ''/undefined는
  // firstJobId가 falsy가 돼 legacyNormalize.ts 자체 가드로 애초에 드롭됨) 어느 쪽이든
  // job-b로 값이 새면 안 된다는 결과는 동일하다.
  it.each([
    ['숫자 id(123)', 123 as unknown],
    ['빈 문자열', '' as unknown],
    ['undefined(id 필드 자체 없음)', undefined as unknown],
  ])('첫 직력 id가 %s이면 다음 직력(job-b)으로 레거시 값이 옮겨 붙지 않는다', (_label, firstJobId) => {
    const firstJob = firstJobId === undefined ? {} : { id: firstJobId };
    const jobs = [firstJob, { id: 'job-b' }];
    const legacyEntry = {
      diagnosisId: 'dx-e1',
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [ELBOW_DX],
          activeModules: ['elbow'],
          elbow: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    // 첫 직력은 어떤 경로로든(숫자→출력 단계 배제, ''/undefined→legacyNormalize 자체
    // 가드) 엔터티가 없다 — job-b 하나만 남아야 한다.
    expect(entities).toHaveLength(1);
    expect(entities[0].entityKey).toEqual(['job-b', 'dx-e1']);
    expect(entities[0].source.entry.daily_exposure_hours).toBe('');
  });

  // 11차 검토 P2 재현 — buildLegacyEntryMap(legacyNormalize.ts)이 `${sharedJobId}:${
  // diagnosisId}` 키를 문자열 템플릿으로 만드는데, 숫자 123과 문자열 '123'은 같은
  // 문자열("123")로 합쳐진다. 첫 직력(숫자 123, 분석 제외 대상)의 레거시 값이 완전히
  // 무관한 유효 직력(문자열 '123')으로 새면 안 된다 — elbow/wrist 둘 다 확인.
  it.each([
    ['elbow', ELBOW_DX, { elbow: {} } as const],
    ['wrist', WRIST_DX, { wrist: {} } as const],
  ] as const)('%s — 숫자 첫 직력(123)과 문자열 직력(\'123\')이 레거시 키에서 충돌하지 않는다', (moduleName, dx) => {
    const jobs = [{ id: 123 }, { id: '123' }];
    const legacyEntry = {
      diagnosisId: dx.id,
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [dx],
          activeModules: [moduleName],
          [moduleName]: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    // 숫자 123 직력은 entityKey를 만들 수 없어 제외되고, 문자열 '123' 직력만 남는다 —
    // 그 직력은 이 레거시 값과 무관하므로 기본값(빈 문자열)이어야 한다.
    expect(entities).toHaveLength(1);
    expect(entities[0].entityKey).toEqual(['123', dx.id]);
    expect(entities[0].source.entry.daily_exposure_hours).toBe('');
  });

  it('linkedJobId가 명시된 레거시 항목은 firstJobId가 위험해도(숫자 등) 그대로 보존된다', () => {
    const jobs = [{ id: 123 }, { id: '123' }, { id: 'job-c' }];
    const legacyEntry = {
      diagnosisId: 'dx-e1',
      linkedJobId: 'job-c',
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [ELBOW_DX],
          activeModules: ['elbow'],
          elbow: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    // 숫자 123은 제외, '123'과 'job-c' 둘 다 남는다 — linkedJobId로 명시된 job-c에만
    // 값이 정상적으로 붙어야 한다.
    expect(entities).toHaveLength(2);
    const jobC = entities.find((e) => e.entityKey[0] === 'job-c')!;
    const job123 = entities.find((e) => e.entityKey[0] === '123')!;
    expect(jobC.source.entry.daily_exposure_hours).toBe(8);
    expect(job123.source.entry.daily_exposure_hours).toBe('');
  });

  // 12차 검토 P2 재현 — 11차 수정은 firstJobId가 위험할 때만 linkedJobId 없는 항목을
  // 걸렀다. 이번엔 firstJobId 자체는 정상(usable)인데, 레거시 항목이 명시한 linkedJobId
  // 값 자체가 숫자라 문자열 '123' 직력과 충돌하는 경로 — 그리고 diagnosisId가 숫자라
  // 문자열 '7' 진단과 충돌하는 경로를 각각 확인한다. 둘 다 elbow/wrist에서 재현.
  it.each([
    ['elbow', ELBOW_DX, 'elbow'] as const,
    ['wrist', WRIST_DX, 'wrist'] as const,
  ])('%s — linkedJobId가 숫자(123)면 문자열 \'123\' 직력과 충돌하지 않는다(firstJobId는 정상)', (_label, dx, moduleName) => {
    // firstJobId('job-a')는 정상 — 10/11차 수정의 가드에 걸리지 않는 경로임을 명시한다.
    const jobs = [{ id: 'job-a' }, { id: '123' }];
    const legacyEntry = {
      diagnosisId: dx.id,
      linkedJobId: 123, // 숫자 — 문자열 '123' 직력과 템플릿 키에서 충돌 위험
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [dx],
          activeModules: [moduleName],
          [moduleName]: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    expect(entities).toHaveLength(2);
    const job123 = entities.find((e) => e.entityKey[0] === '123')!;
    const jobA = entities.find((e) => e.entityKey[0] === 'job-a')!;
    // '123' 직력은 이 레거시 값과 무관하므로 유출되면 안 된다. job-a도 linkedJobId가
    // 숫자 123을 가리켜 job-a 자신과도 무관하므로 마찬가지로 기본값이어야 한다.
    expect(job123.source.entry.daily_exposure_hours).toBe('');
    expect(jobA.source.entry.daily_exposure_hours).toBe('');
  });

  it.each([
    ['elbow', 'elbow'] as const,
    ['wrist', 'wrist'] as const,
  ])('%s — diagnosisId가 숫자(7)면 문자열 \'7\' 진단과 충돌하지 않는다(firstJobId는 정상)', (_label, moduleName) => {
    const jobs = [{ id: 'job-a' }];
    const dx = { id: '7', code: moduleName === 'elbow' ? 'M770' : 'Z00', name: '', moduleId: moduleName, side: 'right' };
    const legacyEntry = {
      diagnosisId: 7, // 숫자 — 문자열 '7' 진단과 템플릿 키에서 충돌 위험
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [dx],
          activeModules: [moduleName],
          [moduleName]: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    expect(entities).toHaveLength(1);
    // 문자열 '7' 진단은 이 레거시 값(숫자 7을 가리킴)과 무관하므로 유출되면 안 된다.
    expect(entities[0].source.entry.daily_exposure_hours).toBe('');
  });

  it('유효한 문자열 linkedJobId·diagnosisId를 가진 정상 레거시 항목은 그대로 연결된다(회귀 방지)', () => {
    const jobs = [{ id: 'job-a' }, { id: 'job-b' }];
    const legacyEntry = {
      diagnosisId: 'dx-e1',
      linkedJobId: 'job-b',
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [ELBOW_DX],
          activeModules: ['elbow'],
          elbow: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    expect(entities).toHaveLength(2);
    const jobB = entities.find((e) => e.entityKey[0] === 'job-b')!;
    const jobA = entities.find((e) => e.entityKey[0] === 'job-a')!;
    expect(jobB.source.entry.daily_exposure_hours).toBe(8);
    expect(jobA.source.entry.daily_exposure_hours).toBe('');
  });

  // 13차 검토 P2 재현 — `record.linkedJobId || firstJobId`는 0·false처럼 "값은 있지만
  // falsy인" 손상 타입도 "미입력"과 똑같이 취급해 firstJobId(첫 직력, 정상)로 조용히
  // 재위임한다. 진짜 미입력(undefined/null/빈 문자열)과 구분해 0·false는 손상된 명시적
  // 참조로 보고 제외해야 한다 — elbow/wrist 둘 다 확인.
  it.each([
    ['elbow', ELBOW_DX, 'elbow'] as const,
    ['wrist', WRIST_DX, 'wrist'] as const,
  ])('%s — linkedJobId가 0이면 첫 직력으로 폴백하지 않는다(진짜 미입력과 구분)', (_label, dx, moduleName) => {
    const jobs = [{ id: 'job-a' }, { id: 'job-b' }];
    const legacyEntry = {
      diagnosisId: dx.id,
      linkedJobId: 0,
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [dx],
          activeModules: [moduleName],
          [moduleName]: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    expect(entities).toHaveLength(2);
    // job-a(첫 직력)로 값이 새면 안 된다 — 0은 미입력이 아니라 손상된 참조다.
    const jobA = entities.find((e) => e.entityKey[0] === 'job-a')!;
    const jobB = entities.find((e) => e.entityKey[0] === 'job-b')!;
    expect(jobA.source.entry.daily_exposure_hours).toBe('');
    expect(jobB.source.entry.daily_exposure_hours).toBe('');
  });

  it('linkedJobId가 false여도 첫 직력으로 폴백하지 않는다', () => {
    const jobs = [{ id: 'job-a' }, { id: 'job-b' }];
    const legacyEntry = {
      diagnosisId: 'dx-e1',
      linkedJobId: false,
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [ELBOW_DX],
          activeModules: ['elbow'],
          elbow: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    expect(entities).toHaveLength(2);
    const jobA = entities.find((e) => e.entityKey[0] === 'job-a')!;
    expect(jobA.source.entry.daily_exposure_hours).toBe('');
  });

  it('linkedJobId가 진짜 미입력(undefined)이면 여전히 첫 직력으로 정상 폴백한다(회귀 방지)', () => {
    const jobs = [{ id: 'job-a' }, { id: 'job-b' }];
    const legacyEntry = {
      diagnosisId: 'dx-e1',
      // linkedJobId 필드 자체가 없음 — 진짜 미입력.
      direct_anatomic_link: 'yes',
      daily_exposure_hours: 8,
    };
    const entities = enumerateJobDiagnosisEntities(
      migrate(
        jobDiagnosisCase({
          jobs,
          diagnoses: [ELBOW_DX],
          activeModules: ['elbow'],
          elbow: { diagnosisEvaluations: [legacyEntry] },
        }),
      ),
    );
    expect(entities).toHaveLength(2);
    const jobA = entities.find((e) => e.entityKey[0] === 'job-a')!;
    expect(jobA.source.entry.daily_exposure_hours).toBe(8);
  });
});

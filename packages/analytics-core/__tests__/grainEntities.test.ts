import { describe, it, expect } from 'vitest';
import { enumerateDiseaseEntities, enumerateJobEntities } from '../grainEntities';
import { deterministicMigrate } from '../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

// PR0-B3 Part B — diagnosis_side grain. shared.diagnoses[]는 activeModules/spine 모듈과
// 무관하게 독립적으로 존재하므로(무릎/어깨 등 다른 모듈 진단도 이 배열에 함께 담김),
// 위 vibration_interval과 달리 spine 모듈 활성 여부를 검사하지 않는다.
function diagnosesCase(diagnoses: unknown[]) {
  return { data: { shared: { diagnoses }, modules: {}, activeModules: [] } };
}

describe('enumerateDiseaseEntities', () => {
  it('shared.diagnoses가 없거나 빈 배열이면 빈 배열', () => {
    expect(enumerateDiseaseEntities(migrate({ data: { shared: {}, modules: {}, activeModules: [] } }))).toEqual([]);
    expect(enumerateDiseaseEntities(migrate(diagnosesCase([])))).toEqual([]);
  });

  it('code/name이 둘 다 공백인 빈 placeholder 진단은 엔터티를 만들지 않는다', () => {
    const placeholder = { id: 'dx-1', code: '', name: '', side: '' };
    expect(enumerateDiseaseEntities(migrate(diagnosesCase([placeholder])))).toEqual([]);
  });

  it('side가 both면 right/left 두 엔터티로 explode한다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both' };
    const entities = enumerateDiseaseEntities(migrate(diagnosesCase([dx])));
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
    const entities = enumerateDiseaseEntities(migrate(diagnosesCase([right, left])));
    expect(entities.map((e) => e.entityKey)).toEqual([
      ['dx-1', 'right'],
      ['dx-2', 'left'],
    ]);
  });

  it('side가 공백/미인식이면 unspecified 하나로 만든다(드롭하지 않는다)', () => {
    const blank = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', side: '' };
    const entities = enumerateDiseaseEntities(migrate(diagnosesCase([blank])));
    expect(entities).toEqual([{ entityKey: ['dx-1', 'unspecified'], source: { diagnosis: blank, side: 'unspecified' }, qualityFlags: [] }]);
  });

  it('id가 결측이면 배열 index 기반으로 결정적으로 보정하고 invalid 플래그를 붙인다(both explode 두 엔터티 모두에 반영)', () => {
    const dx = { code: 'M17.1', name: '무릎관절증', side: 'both' }; // id 없음
    const entities = enumerateDiseaseEntities(migrate(diagnosesCase([dx])));
    expect(entities).toHaveLength(2);
    expect(entities[0].entityKey).toEqual(['__missing_0', 'right']);
    expect(entities[1].entityKey).toEqual(['__missing_0', 'left']);
    expect(entities[0].qualityFlags).toEqual(['invalid']);
    expect(entities[1].qualityFlags).toEqual(['invalid']);
  });

  it('중복 id는 유일해질 때까지 suffix를 붙이고 invalid 플래그를 붙인다', () => {
    const a = { id: 'dup', code: 'M17.1', name: '무릎관절증A', side: 'right' };
    const b = { id: 'dup', code: 'M17.2', name: '무릎관절증B', side: 'right' };
    const entities = enumerateDiseaseEntities(migrate(diagnosesCase([a, b])));
    expect(entities).toHaveLength(2);
    expect(entities[0].entityKey).toEqual(['dup', 'right']);
    expect(entities[0].qualityFlags).toEqual([]);
    expect(entities[1].entityKey).toEqual(['dup#1', 'right']);
    expect(entities[1].qualityFlags).toEqual(['invalid']);
  });

  it('배열 원소 방어: diagnoses에 null/비객체가 섞여 있어도 예외를 던지지 않고 걸러낸다', () => {
    const valid = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right' };
    expect(() => enumerateDiseaseEntities(migrate(diagnosesCase([null, 'not-an-object', 42, valid])))).not.toThrow();
    const entities = enumerateDiseaseEntities(migrate(diagnosesCase([null, 'not-an-object', 42, valid])));
    expect(entities).toEqual([{ entityKey: ['dx-1', 'right'], source: { diagnosis: valid, side: 'right' }, qualityFlags: [] }]);
  });

  it('diagnoses 자체가 배열이 아니면(손상 데이터) 빈 배열', () => {
    const entities = enumerateDiseaseEntities(
      migrate({ data: { shared: { diagnoses: 'not-an-array' as unknown }, modules: {}, activeModules: [] } }),
    );
    expect(entities).toEqual([]);
  });

  it('결정성 — 동일 payload로 두 번 열거해도 동일한 결과', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both' };
    const payload = diagnosesCase([dx]);
    const first = enumerateDiseaseEntities(migrate(payload));
    const second = enumerateDiseaseEntities(migrate(payload));
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

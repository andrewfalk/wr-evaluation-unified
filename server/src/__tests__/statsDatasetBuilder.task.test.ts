// PR0-B3 Part C-2 — buildDataset의 반복 grain(task) 경로 전용 테스트. job/vibration_interval
// 과 대칭 구조 — task는 spine 모듈 하위 반복 컬렉션이라 activeModules/mddmStatus 게이트를
// 공유한다(vibration_interval과 동일 계약).
import { describe, it, expect } from 'vitest';
import { buildDataset } from '../statsDatasetBuilder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function taskSnapshotRow(
  id: string,
  personId: string,
  jobs: Array<Record<string, unknown>>,
  tasks: Array<Record<string, unknown>>,
): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: { shared: { jobs }, modules: { spine: { mddmStatus: 'present', tasks } }, activeModules: ['spine'] },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'task',
    variableKeys: ['spine.task.weightKg'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const JOBS = [{ id: 'job-1', jobName: '용접공' }];
const HEAVY_TASK = { id: 'task-1', sharedJobId: 'job-1', weight: 30, frequency: 60 };

describe('buildDataset(grain=task) — 기본 모집단', () => {
  it('한 case에 task가 여러 개면 case당 여러 행을 낸다 — observationCount>caseCount', () => {
    const rows = [
      taskSnapshotRow('case-1', 'person-1', JOBS, [HEAVY_TASK, { ...HEAVY_TASK, id: 'task-2', weight: 10 }]),
      taskSnapshotRow('case-2', 'person-2', JOBS, [HEAVY_TASK]),
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.caseCount).toBe(2);
    expect(result.personCount).toBe(2);
    expect(result.observationCount).toBe(3);
  });

  it('spine 모듈이 비활성인 case는 이 grain에서 행을 0개 낸다', () => {
    const active = taskSnapshotRow('case-1', 'person-1', JOBS, [HEAVY_TASK]);
    const inactive: SnapshotRow = {
      id: 'case-2',
      patientPersonId: 'person-2',
      assignedDoctorUserId: null,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      payload: { data: { shared: { jobs: JOBS }, modules: {}, activeModules: [] } },
    };
    const result = buildDataset([active, inactive], recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(1);
    expect(result.rows.every((r) => r.caseId === 'case-1')).toBe(true);
  });
});

describe('buildDataset(grain=task) — 변수 선택과 무관하게 엔터티 모집단 불변', () => {
  it('weightKg만 요청·frequencyPerDay만 요청·둘 다 요청 — 세 경우 모두 행 개수·entityKey가 같다', () => {
    // weight는 공백이지만 frequency는 있는 task — weightKg는 not_entered, frequencyPerDay는 정상.
    const task = { id: 'task-1', sharedJobId: 'job-1', frequency: 40 };
    const rows = [taskSnapshotRow('case-1', 'person-1', JOBS, [task])];

    const onlyWeight = buildDataset(rows, recipe({ variableKeys: ['spine.task.weightKg'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const onlyFreq = buildDataset(rows, recipe({ variableKeys: ['spine.task.frequencyPerDay'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const both = buildDataset(
      rows,
      recipe({ variableKeys: ['spine.task.weightKg', 'spine.task.frequencyPerDay'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );

    expect(onlyWeight.observationCount).toBe(1);
    expect(onlyFreq.observationCount).toBe(1);
    expect(both.observationCount).toBe(1);
    expect(onlyWeight.rows[0].entityKey).toEqual(onlyFreq.rows[0].entityKey);
    expect(onlyWeight.rows[0].entityKey).toEqual(both.rows[0].entityKey);

    expect(onlyWeight.rows[0].values['spine.task.weightKg'].missing).toBe('not_entered');
    expect(onlyFreq.rows[0].values['spine.task.frequencyPerDay'].missing).toBeNull();
  });
});

describe('buildDataset(grain=task) — 결정성', () => {
  it('동일 입력을 2회 실행하면 fact rows와 digest가 완전히 동일하다(byte-identical)', () => {
    const rows = [taskSnapshotRow('case-1', 'person-1', JOBS, [HEAVY_TASK])];
    const r = recipe();
    const first = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    const second = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(first.rows).toEqual(second.rows);
    expect(first.internalResultDigest).toBe(second.internalResultDigest);
  });
});

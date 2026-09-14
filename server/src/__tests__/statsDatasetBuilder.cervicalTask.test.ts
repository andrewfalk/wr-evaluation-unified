// PR0-B4 Slice 7 — buildDataset의 반복 grain(cervical_task) 경로 전용 테스트. spine의
// task grain(statsDatasetBuilder.task.test.ts)과 대칭 구조이지만, cervical_task는 완전히
// 분리된 별도 grain이다(계획 결정) — 두 grain이 서로의 데이터에 영향을 주지 않는지도 함께
// 확인한다.
import { describe, it, expect } from 'vitest';
import { buildDataset } from '../statsDatasetBuilder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function cervicalTaskSnapshotRow(
  id: string,
  personId: string,
  jobs: Array<Record<string, unknown>>,
  tasks: Array<Record<string, unknown>>,
  activeModules: string[] = ['cervical'],
): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: { shared: { jobs }, modules: { cervical: { tasks } }, activeModules },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'cervical_task',
    variableKeys: ['cervical.task.name'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const JOBS = [{ id: 'job-1', jobName: '조립공' }];
const CORE_TASK = {
  id: 'task-1',
  sharedJobId: 'job-1',
  name: '박스 운반',
  exposure_types: ['shoulder_heavy_load'],
  load_weight_kg: '45',
  carry_hours_per_shift: '2',
  forced_neck_posture: 'yes',
};

describe('buildDataset(grain=cervical_task) — 기본 모집단', () => {
  it('한 case에 task가 여러 개면 case당 여러 행을 낸다 — observationCount>caseCount', () => {
    const rows = [
      cervicalTaskSnapshotRow('case-1', 'person-1', JOBS, [CORE_TASK, { ...CORE_TASK, id: 'task-2', name: '조립' }]),
      cervicalTaskSnapshotRow('case-2', 'person-2', JOBS, [CORE_TASK]),
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.caseCount).toBe(2);
    expect(result.personCount).toBe(2);
    expect(result.observationCount).toBe(3);
  });

  it('cervical 모듈이 비활성인 case는 이 grain에서 행을 0개 낸다', () => {
    const active = cervicalTaskSnapshotRow('case-1', 'person-1', JOBS, [CORE_TASK]);
    const inactive = cervicalTaskSnapshotRow('case-2', 'person-2', JOBS, [CORE_TASK], []);
    const result = buildDataset([active, inactive], recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(1);
    expect(result.rows.every((r) => r.caseId === 'case-1')).toBe(true);
  });

  // spine의 task grain과 완전 분리 확인 — 같은 case가 spine 모듈만 활성이고 cervical은
  // 비활성이면 cervical_task grain은 행이 0개여야 한다(두 grain이 서로 새지 않는다).
  it('spine 모듈만 활성인 case는 cervical_task grain에서 행을 0개 낸다', () => {
    const spineOnly: SnapshotRow = {
      id: 'case-1',
      patientPersonId: 'person-1',
      assignedDoctorUserId: null,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      payload: {
        data: {
          shared: { jobs: JOBS },
          modules: { spine: { tasks: [{ id: 'spine-task-1', sharedJobId: 'job-1', weight: 10 }] } },
          activeModules: ['spine'],
        },
      },
    };
    const result = buildDataset([spineOnly], recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(0);
  });
});

describe('buildDataset(grain=cervical_task) — 게이트된 변수(exposure_types 의존)', () => {
  it('exposure_types에 shoulder_heavy_load가 없으면 loadWeightKg는 not_applicable', () => {
    const task = { ...CORE_TASK, exposure_types: ['awkward_static_neck_load'] };
    const rows = [cervicalTaskSnapshotRow('case-1', 'person-1', JOBS, [task])];
    const result = buildDataset(rows, recipe({ variableKeys: ['cervical.task.loadWeightKg'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.rows[0].values['cervical.task.loadWeightKg'].missing).toBe('not_applicable');
  });

  it('exposure_types에 shoulder_heavy_load가 있으면 loadWeightKg가 정상 추출된다', () => {
    const rows = [cervicalTaskSnapshotRow('case-1', 'person-1', JOBS, [CORE_TASK])];
    const result = buildDataset(rows, recipe({ variableKeys: ['cervical.task.loadWeightKg'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.rows[0].values['cervical.task.loadWeightKg']).toEqual({ value: 45, missing: null, qualityFlags: [] });
  });
});

describe('buildDataset(grain=cervical_task) — 변수 선택과 무관하게 엔터티 모집단 불변', () => {
  it('name만 요청·loadWeightKg만 요청·둘 다 요청 — 세 경우 모두 행 개수·entityKey가 같다', () => {
    // name은 있지만 load_weight_kg는 게이트가 닫혀 not_applicable인 task.
    const task = { ...CORE_TASK, exposure_types: [] };
    const rows = [cervicalTaskSnapshotRow('case-1', 'person-1', JOBS, [task])];

    const onlyName = buildDataset(rows, recipe({ variableKeys: ['cervical.task.name'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const onlyWeight = buildDataset(rows, recipe({ variableKeys: ['cervical.task.loadWeightKg'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const both = buildDataset(
      rows,
      recipe({ variableKeys: ['cervical.task.name', 'cervical.task.loadWeightKg'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );

    expect(onlyName.observationCount).toBe(1);
    expect(onlyWeight.observationCount).toBe(1);
    expect(both.observationCount).toBe(1);
    expect(onlyName.rows[0].entityKey).toEqual(onlyWeight.rows[0].entityKey);
    expect(onlyName.rows[0].entityKey).toEqual(both.rows[0].entityKey);

    expect(onlyName.rows[0].values['cervical.task.name'].missing).toBeNull();
    expect(onlyWeight.rows[0].values['cervical.task.loadWeightKg'].missing).toBe('not_applicable');
  });
});

describe('buildDataset(grain=cervical_task) — 결정성', () => {
  it('동일 입력을 2회 실행하면 fact rows와 digest가 완전히 동일하다(byte-identical)', () => {
    const rows = [cervicalTaskSnapshotRow('case-1', 'person-1', JOBS, [CORE_TASK])];
    const r = recipe();
    const first = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    const second = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(first.rows).toEqual(second.rows);
    expect(first.internalResultDigest).toBe(second.internalResultDigest);
  });
});

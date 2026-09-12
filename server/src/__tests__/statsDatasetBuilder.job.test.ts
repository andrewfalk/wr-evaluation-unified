// PR0-B3 Part C — buildDataset의 반복 grain(job) 경로 전용 테스트. Part A/B의
// vibration_interval/diagnosis_side와 대칭 구조 — job은 그 둘과 달리 어떤 모듈에도
// 속하지 않는 공유 필드(shared.jobs[])라는 점이 특유하다(activeModules 게이트 없음).
import { describe, it, expect } from 'vitest';
import { buildDataset } from '../statsDatasetBuilder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function jobSnapshotRow(id: string, personId: string, jobs: Array<Record<string, unknown>>): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: { shared: { jobs }, modules: {}, activeModules: [] },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'job',
    variableKeys: ['job.identity.jobNameNormalized'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const WELDER_JOB = { id: 'job-1', jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01' };

describe('buildDataset(grain=job) — 기본 모집단', () => {
  it('한 case에 직력이 여러 개면 case당 여러 행을 낸다 — observationCount>caseCount', () => {
    const rows = [
      jobSnapshotRow('case-1', 'person-1', [WELDER_JOB, { id: 'job-2', jobName: '조립공', startDate: '2020-01-01', endDate: '2021-01-01' }]),
      jobSnapshotRow('case-2', 'person-2', [WELDER_JOB]),
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.caseCount).toBe(2);
    expect(result.personCount).toBe(2);
    expect(result.observationCount).toBe(3);
  });

  it('빈 placeholder 직력(이름·기간 다 공백)이 섞여 있어도 실제 직력만 행이 된다', () => {
    const rows = [
      jobSnapshotRow('case-1', 'person-1', [
        { id: 'job-empty', jobName: '', startDate: '', endDate: '', workPeriodOverride: '' },
        WELDER_JOB,
      ]),
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].entityKey).toEqual(['job-1']);
  });

  it('직력이 없는 case는 이 grain에서 행을 0개 낸다', () => {
    const rows = [jobSnapshotRow('case-1', 'person-1', [WELDER_JOB]), jobSnapshotRow('case-2', 'person-2', [])];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(1);
    expect(result.rows.every((r) => r.caseId === 'case-1')).toBe(true);
  });
});

describe('buildDataset(grain=job) — 변수 선택과 무관하게 엔터티 모집단 불변', () => {
  it('jobNameNormalized만 요청·tenureYears만 요청·둘 다 요청 — 세 경우 모두 행 개수·entityKey가 같다', () => {
    // 이름은 공백이지만 기간은 있는 job — jobNameNormalized는 not_entered, tenureYears는 정상.
    const job = { id: 'job-1', jobName: '', startDate: '2015-01-01', endDate: '2020-01-01' };
    const rows = [jobSnapshotRow('case-1', 'person-1', [job])];

    const onlyName = buildDataset(rows, recipe({ variableKeys: ['job.identity.jobNameNormalized'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const onlyTenure = buildDataset(rows, recipe({ variableKeys: ['job.identity.tenureYears'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const both = buildDataset(
      rows,
      recipe({ variableKeys: ['job.identity.jobNameNormalized', 'job.identity.tenureYears'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );

    expect(onlyName.observationCount).toBe(1);
    expect(onlyTenure.observationCount).toBe(1);
    expect(both.observationCount).toBe(1);
    expect(onlyName.rows[0].entityKey).toEqual(onlyTenure.rows[0].entityKey);
    expect(onlyName.rows[0].entityKey).toEqual(both.rows[0].entityKey);

    expect(onlyName.rows[0].values['job.identity.jobNameNormalized'].missing).toBe('not_entered');
    expect(onlyName.rows[0].values['job.identity.tenureYears']).toBeUndefined();
    expect(onlyTenure.rows[0].values['job.identity.tenureYears'].missing).toBeNull();
    expect(both.rows[0].values['job.identity.jobNameNormalized'].missing).toBe('not_entered');
    expect(both.rows[0].values['job.identity.tenureYears'].missing).toBeNull();
  });
});

describe('buildDataset(grain=job) — 결정성', () => {
  it('동일 입력을 2회 실행하면 fact rows와 digest가 완전히 동일하다(byte-identical)', () => {
    const rows = [jobSnapshotRow('case-1', 'person-1', [WELDER_JOB, { ...WELDER_JOB, id: 'job-2' }])];
    const r = recipe();
    const first = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    const second = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(first.rows).toEqual(second.rows);
    expect(first.internalResultDigest).toBe(second.internalResultDigest);
  });
});

describe('buildDataset(grain=job) — 필터', () => {
  it('job grain 필터도 정상적으로 AND 결합된다', () => {
    const rows = [
      jobSnapshotRow('case-1', 'person-1', [WELDER_JOB]), // tenure 5년
      jobSnapshotRow('case-2', 'person-2', [{ ...WELDER_JOB, id: 'job-2', startDate: '2019-01-01' }]), // tenure 1년
    ];
    const result = buildDataset(
      rows,
      recipe({
        variableKeys: ['job.identity.tenureYears'],
        filters: [{ key: 'job.identity.tenureYears', operator: 'gt', value: 3 }],
      }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].caseId).toBe('case-1');
  });
});

describe('buildDataset(grain=case) — job.rollup.longestTenureJobNameNormalized', () => {
  it('case grain 레시피에서 정상적으로 대표 직종명을 계산한다(job grain과 다른 grain 디스패치 경로)', () => {
    const rows = [
      jobSnapshotRow('case-1', 'person-1', [
        WELDER_JOB, // 5년
        { id: 'job-2', jobName: '조립공', startDate: '2020-01-01', endDate: '2021-01-01' }, // 1년
      ]),
    ];
    const result = buildDataset(
      rows,
      { grain: 'case', variableKeys: ['job.rollup.longestTenureJobNameNormalized'], filters: [], analysisPurpose: 'association', formulaPolicies: {}, analysisMode: 'descriptive' },
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].values['job.rollup.longestTenureJobNameNormalized']).toEqual({
      value: '용접공',
      missing: null,
      qualityFlags: [],
    });
  });
});

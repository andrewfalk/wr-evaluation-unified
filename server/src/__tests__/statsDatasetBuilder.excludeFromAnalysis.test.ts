// 직력별 "신체부담평가 미포함"(shared.jobs[].excludeFromAnalysis) — 통계 데이터셋 빌더 관점.
//  · job grain: 미포함 직력도 행(엔터티)으로 남는다 — 직업력 정보 변수(job.identity.*)는 그대로 집계,
//    신체부담 변수(knee.job.*)만 not_applicable. 모듈 job grain 관측은 엔터티와 1:1이어야 하므로(생략 금지)
//    assertObservationsMatchCanonicalEntities 검증을 통과해야 한다.
//  · case grain: 신체부담 집계는 포함 직력만 반영한다.
import { describe, it, expect } from 'vitest';
import { buildDataset } from '../statsDatasetBuilder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const DIGEST = 'test-recipe-digest';

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, jobName: id, startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250, ...extra,
});

function row(id: string, jobs: Array<Record<string, unknown>>, kneeModule: Record<string, unknown> = {}): SnapshotRow {
  return {
    id,
    patientPersonId: `person-${id}`,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: {
        shared: { jobs, birthDate: '1970-01-01', injuryDate: '2020-01-01' },
        modules: { knee: kneeModule },
        activeModules: ['knee'],
      },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe>): StatsAnalysisRecipe {
  return {
    grain: 'job',
    variableKeys: [],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const extras = [{ sharedJobId: 'a', weight: '5000', squatting: '200' }, { sharedJobId: 'b', weight: '10', squatting: '5' }];

describe('buildDataset(grain=job) — 미포함 직력', () => {
  it('미포함 직력도 행으로 남고, 직업력 정보 변수는 값이 있으며 신체부담 변수만 not_applicable', () => {
    const rows = [row('c1', [job('a'), job('b', { excludeFromAnalysis: true })], { jobExtras: extras })];
    const result = buildDataset(rows, recipe({ variableKeys: ['job.identity.tenureYears', 'knee.job.dailyLoadKg'] }), DIGEST, CATALOG_BY_KEY);

    expect(result.observationCount).toBe(2);
    const byEntity = Object.fromEntries(result.rows.map((r) => [(r.entityKey as string[])[0], r.values]));
    expect(byEntity.a['job.identity.tenureYears'].missing).toBeNull();
    expect(byEntity.b['job.identity.tenureYears'].missing).toBeNull(); // 직업력 정보는 미포함 직력도 집계
    expect(byEntity.a['knee.job.dailyLoadKg']).toMatchObject({ value: 5000, missing: null });
    expect(byEntity.b['knee.job.dailyLoadKg']).toMatchObject({ value: null, missing: 'not_applicable' });
  });

  it('전부 미포함이어도 행 수는 그대로이고 신체부담 변수만 전부 not_applicable (엔터티 불일치로 throw하지 않는다)', () => {
    const rows = [row('c1', [job('a', { excludeFromAnalysis: true }), job('b', { excludeFromAnalysis: true })], { jobExtras: extras })];
    const result = buildDataset(rows, recipe({ variableKeys: ['job.identity.tenureYears', 'knee.job.dailyLoadKg'] }), DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(2);
    expect(result.rows.every((r) => r.values['knee.job.dailyLoadKg'].missing === 'not_applicable')).toBe(true);
    expect(result.rows.every((r) => r.values['job.identity.tenureYears'].missing === null)).toBe(true);
  });

  it('미포함 플래그가 없는 환자는 신체부담 변수도 전부 값이 있다 (회귀)', () => {
    const rows = [row('c1', [job('a'), job('b')], { jobExtras: extras })];
    const result = buildDataset(rows, recipe({ variableKeys: ['knee.job.dailyLoadKg'] }), DIGEST, CATALOG_BY_KEY);
    expect(result.rows.map((r) => r.values['knee.job.dailyLoadKg'].value)).toEqual([5000, 10]);
  });
});

describe('buildDataset(grain=case) — 미포함 직력', () => {
  it('knee.case.sumDailyLoadKg는 포함 직력만 합산, 전부 미포함이면 not_applicable', () => {
    const rows = [
      row('c1', [job('a'), job('b', { excludeFromAnalysis: true })], { jobExtras: extras }),
      row('c2', [job('a'), job('b')], { jobExtras: extras }),
      row('c3', [job('a', { excludeFromAnalysis: true }), job('b', { excludeFromAnalysis: true })], { jobExtras: extras }),
    ];
    const result = buildDataset(rows, recipe({ grain: 'case', variableKeys: ['knee.case.sumDailyLoadKg'] }), DIGEST, CATALOG_BY_KEY);
    const sum = Object.fromEntries(result.rows.map((r) => [r.caseId, r.values['knee.case.sumDailyLoadKg']]));
    expect(sum.c1).toMatchObject({ value: 5000, missing: null });
    expect(sum.c2).toMatchObject({ value: 5010, missing: null });
    expect(sum.c3).toMatchObject({ value: null, missing: 'not_applicable' });
  });
});

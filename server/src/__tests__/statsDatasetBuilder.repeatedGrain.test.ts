// PR0-B3 Part A(2차 리뷰 반영) — buildDataset의 반복 grain(vibration_interval) 경로 전용
// 테스트. 기존 statsDatasetBuilder.test.ts는 case grain 중심이라, §2.2(caseCount≠
// observationCount)·엔터티 모집단의 변수-독립성·assertObservationsMatchCanonicalEntities
// 계약 위반 거부를 별도로 검증한다.
import { describe, it, expect } from 'vitest';
import { buildDataset, assertObservationsMatchCanonicalEntities } from '../statsDatasetBuilder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';
import type { GrainEntity, RepeatedObservation } from '@wr/analytics-core';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function vibrationSnapshotRow(
  id: string,
  personId: string,
  intervals: Array<Record<string, unknown>>,
): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: {
        shared: { jobs: [{ id: 'job-1', jobName: '조립공' }] },
        modules: { spine: { vibrationExposureStatus: 'present', vibrationIntervals: intervals } },
        activeModules: ['spine'],
      },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'vibration_interval',
    variableKeys: ['spine.vibration.intervalA8Max'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const VALID_INTERVAL = { id: 'iv-1', sharedJobId: 'job-1', awMin: 1.0, awMax: 1.5, timeValue: 4, timeUnit: 'hr' };

describe('buildDataset(grain=vibration_interval) — §2.2 caseCount≠observationCount', () => {
  it('한 case가 구간 2개를 가지면 observationCount>caseCount, personCount는 caseCount와 같을 수 있다', () => {
    const rows = [
      vibrationSnapshotRow('case-1', 'person-1', [VALID_INTERVAL, { ...VALID_INTERVAL, id: 'iv-2' }]),
      vibrationSnapshotRow('case-2', 'person-2', [VALID_INTERVAL]),
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.caseCount).toBe(2);
    expect(result.personCount).toBe(2);
    expect(result.observationCount).toBe(3);
  });

  it('동일인이 사례 2건을 가지면 personCount<caseCount(=observationCount, 구간 1개씩)', () => {
    const rows = [
      vibrationSnapshotRow('case-1', 'person-solo', [VALID_INTERVAL]),
      vibrationSnapshotRow('case-2', 'person-solo', [VALID_INTERVAL]),
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.personCount).toBe(1);
    expect(result.caseCount).toBe(2);
    expect(result.observationCount).toBe(2);
  });

  it('상병/구간이 없는 case는 이 grain에서 행을 0개 낸다(§11 exact-count 요구)', () => {
    const rows = [
      vibrationSnapshotRow('case-1', 'person-1', [VALID_INTERVAL]),
      vibrationSnapshotRow('case-2', 'person-2', []), // 구간 없음
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(1);
    expect(result.rows.every((r) => r.caseId === 'case-1')).toBe(true);
  });
});

describe('buildDataset(grain=vibration_interval) — 변수 추가/제거 시 엔터티 모집단 불변', () => {
  // awMax가 없는 구간 — intervalA8Max는 not_entered, intervalExposureHours는 정상 계산.
  // 어느 변수를 요청하든 "행이 몇 개 나오는가"는 절대 바뀌면 안 된다(join, union 아님).
  const INTERVAL_WITHOUT_AWMAX = { id: 'iv-1', sharedJobId: 'job-1', timeValue: 4, timeUnit: 'hr' };

  it('intervalA8Max만 요청·intervalExposureHours만 요청·둘 다 요청 — 세 경우 모두 행 개수가 같다', () => {
    const rows = [vibrationSnapshotRow('case-1', 'person-1', [INTERVAL_WITHOUT_AWMAX])];

    const onlyA8 = buildDataset(rows, recipe({ variableKeys: ['spine.vibration.intervalA8Max'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const onlyHours = buildDataset(rows, recipe({ variableKeys: ['spine.vibration.intervalExposureHours'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const both = buildDataset(
      rows,
      recipe({ variableKeys: ['spine.vibration.intervalA8Max', 'spine.vibration.intervalExposureHours'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );

    expect(onlyA8.observationCount).toBe(1);
    expect(onlyHours.observationCount).toBe(1);
    expect(both.observationCount).toBe(1);
    // entityKey(행 식별자) 자체도 어느 변수를 골랐는지와 무관하게 동일해야 한다.
    expect(onlyA8.rows[0].entityKey).toEqual(onlyHours.rows[0].entityKey);
    expect(onlyA8.rows[0].entityKey).toEqual(both.rows[0].entityKey);

    // 값의 존재 여부는 변수 선택에 따라 달라지는 게 맞다 — 모집단(행)은 불변, 값은 요청한 변수만.
    expect(onlyA8.rows[0].values['spine.vibration.intervalA8Max'].missing).toBe('not_entered');
    expect(onlyA8.rows[0].values['spine.vibration.intervalExposureHours']).toBeUndefined();
    expect(onlyHours.rows[0].values['spine.vibration.intervalExposureHours'].missing).toBeNull();
    expect(both.rows[0].values['spine.vibration.intervalA8Max'].missing).toBe('not_entered');
    expect(both.rows[0].values['spine.vibration.intervalExposureHours'].missing).toBeNull();
  });
});

describe('buildDataset(grain=vibration_interval) — 결정성', () => {
  it('동일 입력을 2회 실행하면 fact rows와 digest가 완전히 동일하다(byte-identical)', () => {
    const rows = [
      vibrationSnapshotRow('case-1', 'person-1', [VALID_INTERVAL, { ...VALID_INTERVAL, id: 'iv-2', awMax: 0.8 }]),
    ];
    const r = recipe();
    const first = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    const second = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(first.rows).toEqual(second.rows);
    expect(first.internalResultDigest).toBe(second.internalResultDigest);
    expect(first.personCount).toBe(second.personCount);
    expect(first.caseCount).toBe(second.caseCount);
    expect(first.observationCount).toBe(second.observationCount);
  });
});

describe('buildDataset(grain=vibration_interval) — 필터', () => {
  it('vibration_interval grain 필터도 정상적으로 AND 결합된다', () => {
    const rows = [
      vibrationSnapshotRow('case-1', 'person-1', [VALID_INTERVAL]), // awMax=1.5
      vibrationSnapshotRow('case-2', 'person-2', [{ ...VALID_INTERVAL, awMax: 0.1 }]),
    ];
    const result = buildDataset(
      rows,
      recipe({ filters: [{ key: 'spine.vibration.intervalA8Max', operator: 'gt', value: 0.5 }] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].caseId).toBe('case-1');
  });
});

// PR0-B3 Part A(2차 리뷰 지적) — 길이 비교만으로는 canonical=[A,B]에 [A,A]를 반환하는
// 계약 위반(A가 덮어써지고 B가 결측인 채 남음)을 못 잡는다. 실제 extractor 없이 조작된
// 입력으로 이 함수를 직접 검증한다.
describe('assertObservationsMatchCanonicalEntities — 계약 위반 감지', () => {
  function entity(key: string): GrainEntity<unknown> {
    return { entityKey: [key], source: null, qualityFlags: [] };
  }
  function observation(key: string): RepeatedObservation<unknown> {
    return { entityKey: [key], value: 1, missing: null, qualityFlags: [] };
  }

  it('정상 — canonical과 반환이 정확히 1:1 대응하면 통과한다', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A'), observation('B')], [entity('A'), entity('B')]),
    ).not.toThrow();
  });

  it('중복 반환 — canonical=[A,B]인데 [A,A]를 반환하면 던진다(길이는 같아도 B가 누락된다)', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A'), observation('A')], [entity('A'), entity('B')]),
    ).toThrow(/중복/);
  });

  it('canonical에 없는 entityKey 반환 — 즉시 던진다', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A'), observation('C')], [entity('A'), entity('B')]),
    ).toThrow(/canonical 목록에 없는/);
  });

  it('개수 부족 — canonical 2개인데 1개만 반환하면 던진다', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A')], [entity('A'), entity('B')]),
    ).toThrow(/다르다/);
  });

  it('canonical이 빈 배열이고 반환도 빈 배열이면 통과한다(그 case는 이 grain에서 관측 0개)', () => {
    expect(() => assertObservationsMatchCanonicalEntities('test.key', 'case-1', [], [])).not.toThrow();
  });
});

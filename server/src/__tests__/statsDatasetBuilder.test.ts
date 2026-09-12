import { describe, it, expect } from 'vitest';
import { buildDataset, matchesFilter } from '../statsDatasetBuilder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import { getIntegratedCatalog } from '../statsCatalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe, StatsFilter } from '@wr/contracts';
import type { ExtractedValue } from '@wr/analytics-core';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const INTEGRATED_CATALOG_BY_KEY = new Map(getIntegratedCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function makeSnapshotRow(id: string, personId: string, overrides: Partial<SnapshotRow['payload']> = {}): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: {
        shared: {},
        modules: {},
        activeModules: [],
        ...overrides,
      },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'case',
    variableKeys: ['knee.relatedness.max'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

describe('buildDataset — 필터 결측 취급', () => {
  it('결측 행은 eq/neq를 포함한 어떤 비교 연산자에도 매치되지 않는다', () => {
    // knee 모듈이 비활성이라 knee.relatedness.max는 항상 structural_missing이다.
    const rows = [makeSnapshotRow('case-1', 'person-1')];
    const result = buildDataset(
      rows,
      recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'neq', value: 0 }] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    // neq 0은 "missing이니까 다르다"고 오판하면 안 되므로 매치 결과가 0건이어야 한다.
    expect(result.caseCount).toBe(0);
  });

  it('is_missing 필터는 결측 행을 정확히 매치한다', () => {
    const rows = [makeSnapshotRow('case-1', 'person-1')];
    const result = buildDataset(
      rows,
      recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'is_missing' }] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.caseCount).toBe(1);
  });
});

describe('matchesFilter — 문자열 필터의 NFC 정규화 (회귀)', () => {
  // 리뷰에서 실제로 재현된 버그: canonicalSerialize(§G, recipeDigest 등이 쓰는 규칙)는
  // 문자열 leaf 값을 NFC로 정규화한 뒤 해시하는데, 필터 비교(matchesFilter)는 원문을
  // 그대로 비교했다 — 그 결과 '고도'의 NFC 표현과 NFD 표현(자모가 분리된 결합 문자)이
  // recipeDigest는 동일한데 실제 매치 결과는 갈렸다(같은 recipeDigest가 다른 분석 대상을
  // 가리킬 수 있는 상태). ExtractedValue를 직접 주입해 elbow 모듈 전체 계산 없이 이
  // 비교 규칙만 저렴하게 검증한다.
  function stringValue(v: string): ExtractedValue<string> {
    return { value: v, missing: null, qualityFlags: [] };
  }

  it('NFC와 NFD로 다르게 인코딩된 동일 문자열이 eq에서 항상 매치된다', () => {
    const nfc = '고도'.normalize('NFC');
    const nfd = '고도'.normalize('NFD');
    expect(nfc).not.toBe(nfd); // 전제 확인 — 코드유닛 자체가 실제로 다르다.

    const filterWithNfd: StatsFilter = { key: 'elbow.assessment.burdenGradeMax', operator: 'eq', value: nfd };
    expect(matchesFilter(stringValue(nfc), filterWithNfd)).toBe(true);

    const filterWithNfc: StatsFilter = { key: 'elbow.assessment.burdenGradeMax', operator: 'eq', value: nfc };
    expect(matchesFilter(stringValue(nfd), filterWithNfc)).toBe(true);
  });

  it('neq도 정규화 후 비교하므로 같은 문자열의 다른 인코딩을 "다르다"고 오판하지 않는다', () => {
    const nfc = '고도'.normalize('NFC');
    const nfd = '고도'.normalize('NFD');
    const filter: StatsFilter = { key: 'elbow.assessment.burdenGradeMax', operator: 'neq', value: nfd };
    expect(matchesFilter(stringValue(nfc), filter)).toBe(false);
  });

  it('in 연산자도 배열 원소 각각을 NFC 정규화한 뒤 비교한다', () => {
    const nfc = '고도'.normalize('NFC');
    const nfd = '고도'.normalize('NFD');
    const filter: StatsFilter = { key: 'elbow.assessment.burdenGradeMax', operator: 'in', value: [nfd, '경도'] };
    expect(matchesFilter(stringValue(nfc), filter)).toBe(true);
  });
});

describe('buildDataset — 다중 필터 AND 결합', () => {
  it('두 필터 모두 만족하는 행만 남는다', () => {
    const rows = [makeSnapshotRow('case-1', 'person-1'), makeSnapshotRow('case-2', 'person-2')];
    const result = buildDataset(
      rows,
      recipe({
        filters: [
          { key: 'knee.relatedness.max', operator: 'is_missing' },
          { key: 'spine.vibration.dvMax', operator: 'is_missing' },
        ],
      }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    // 둘 다 모듈 비활성이라 두 조건 모두 만족(is_missing=true) — 2건 전부 남아야 한다.
    expect(result.caseCount).toBe(2);
  });
});

describe('buildDataset — 결정성', () => {
  it('동일 입력을 2회 실행하면 출력이 완전히 동일하다(byte-identical)', () => {
    const rows = [makeSnapshotRow('case-1', 'person-1'), makeSnapshotRow('case-2', 'person-2')];
    const r = recipe();
    const first = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    const second = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(first.rows).toEqual(second.rows);
    expect(first.internalResultDigest).toBe(second.internalResultDigest);
    expect(first.personCount).toBe(second.personCount);
    expect(first.caseCount).toBe(second.caseCount);
  });
});

describe('buildDataset — 담당의 cluster 수', () => {
  it('NULL(미배정)은 cluster 수에서 제외된다', () => {
    const rows: SnapshotRow[] = [
      { ...makeSnapshotRow('case-1', 'person-1'), assignedDoctorUserId: 'doctor-a' },
      { ...makeSnapshotRow('case-2', 'person-2'), assignedDoctorUserId: null },
      { ...makeSnapshotRow('case-3', 'person-3'), assignedDoctorUserId: 'doctor-b' },
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.distinctAssignedDoctorClusters).toBe(2);
  });
});

// PR0-B3 Part C-2 — 담당의(case.staff.assignedDoctorUserId)·등록일(case.meta.registeredAt)은
// payload가 아니라 SnapshotRow 컬럼에서 직접 온다(analytics-core를 거치지 않음). 일반
// analytics-core 전용 카탈로그(CATALOG_BY_KEY)가 아니라 통합 카탈로그를 써야 한다
// (실제 서버 경로가 validateRecipe→getIntegratedCatalog()로 만드는 catalogByKey를 그대로
// 넘기는 것과 동일한 전제).
describe('buildDataset — SnapshotRow 컬럼 변수(담당의·등록일)', () => {
  it('담당의는 SnapshotRow.assignedDoctorUserId를 그대로 값으로 반환한다', () => {
    const rows: SnapshotRow[] = [{ ...makeSnapshotRow('case-1', 'person-1'), assignedDoctorUserId: 'doctor-a' }];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['case.staff.assignedDoctorUserId'] }),
      RECIPE_DIGEST,
      INTEGRATED_CATALOG_BY_KEY,
    );
    expect(result.rows[0].values['case.staff.assignedDoctorUserId']).toEqual({
      value: 'doctor-a',
      missing: null,
      qualityFlags: [],
    });
  });

  it('담당의 미배정(null)은 not_entered다', () => {
    const rows = [makeSnapshotRow('case-1', 'person-1')]; // assignedDoctorUserId: null(기본값)
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['case.staff.assignedDoctorUserId'] }),
      RECIPE_DIGEST,
      INTEGRATED_CATALOG_BY_KEY,
    );
    expect(result.rows[0].values['case.staff.assignedDoctorUserId'].missing).toBe('not_entered');
  });

  it('등록일은 SnapshotRow.createdAt을 ISO 날짜 문자열로 반환하고, 필터(gte)에도 정상 매치된다', () => {
    const rows: SnapshotRow[] = [
      { ...makeSnapshotRow('case-1', 'person-1'), createdAt: new Date('2024-01-01T00:00:00.000Z') },
      { ...makeSnapshotRow('case-2', 'person-2'), createdAt: new Date('2024-06-01T00:00:00.000Z') },
    ];
    const result = buildDataset(
      rows,
      recipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'case.meta.registeredAt', operator: 'gte', value: '2024-03-01' }],
      }),
      RECIPE_DIGEST,
      INTEGRATED_CATALOG_BY_KEY,
    );
    expect(result.caseCount).toBe(1);
    expect(result.rows[0].caseId).toBe('case-2');
  });

  it('등록일은 filter_only라 variableKeys 결과 행에는 값이 노출되지 않는다(필터로만 쓰였을 때)', () => {
    const rows = [makeSnapshotRow('case-1', 'person-1')];
    const result = buildDataset(
      rows,
      recipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'case.meta.registeredAt', operator: 'not_missing' }],
      }),
      RECIPE_DIGEST,
      INTEGRATED_CATALOG_BY_KEY,
    );
    expect(result.rows[0].values['case.meta.registeredAt']).toBeUndefined();
  });
});

describe('buildDataset — personClusterKey', () => {
  it('같은 recipeDigest에서는 같은 personId가 항상 같은 personClusterKey를 낸다(결정성)', () => {
    const rows = [makeSnapshotRow('case-1', 'person-1'), makeSnapshotRow('case-2', 'person-1')];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.rows[0].personClusterKey).toBe(result.rows[1].personClusterKey);
    expect(result.personCount).toBe(1);
    expect(result.caseCount).toBe(2);
  });

  it('다른 recipeDigest에서는 같은 personId라도 다른 personClusterKey를 낸다', () => {
    const rows = [makeSnapshotRow('case-1', 'person-1')];
    const a = buildDataset(rows, recipe(), 'digest-a', CATALOG_BY_KEY);
    const b = buildDataset(rows, recipe(), 'digest-b', CATALOG_BY_KEY);
    expect(a.rows[0].personClusterKey).not.toBe(b.rows[0].personClusterKey);
  });
});

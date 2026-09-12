// PR0-B3 Part B — buildDataset의 반복 grain(diagnosis_side) 경로 전용 테스트.
// statsDatasetBuilder.repeatedGrain.test.ts(vibration_interval)와 대칭 구조 — 이 grain은
// side==='both' explode라는 vibration_interval에는 없는 특유의 모집단 규칙이 있어 별도로
// 검증한다.
import { describe, it, expect } from 'vitest';
import { buildDataset } from '../statsDatasetBuilder';
import { buildPairedDataset, groupPairsByLevel } from '../statsBivariateDataset';
import { computeAvailableMethods } from '../statsMethodCatalog';
import { getOrdinalOrder } from '../statsOrdinalOrder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function diagnosisSnapshotRow(id: string, personId: string, diagnoses: Array<Record<string, unknown>>): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: {
        shared: { diagnoses },
        modules: {},
        activeModules: [],
      },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'diagnosis_side',
    variableKeys: ['knee.diagnosisSide.klGrade'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const KNEE_BOTH = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both', klgRight: '2', klgLeft: '3' };

describe('buildDataset(grain=diagnosis_side) — side===both explode', () => {
  it('한 case의 진단 1개가 side=both면 행 2개(우/좌)를 낸다 — observationCount>caseCount', () => {
    const rows = [diagnosisSnapshotRow('case-1', 'person-1', [KNEE_BOTH])];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.caseCount).toBe(1);
    expect(result.observationCount).toBe(2);
    expect(result.rows.map((r) => r.entityKey)).toEqual([
      ['dx-1', 'right'],
      ['dx-1', 'left'],
    ]);
    expect(result.rows[0].values['knee.diagnosisSide.klGrade'].value).toBe('2');
    expect(result.rows[1].values['knee.diagnosisSide.klGrade'].value).toBe('3');
  });

  it('빈 placeholder 진단(code/name 공백)이 섞여 있어도 실제 진단만 행이 된다', () => {
    const rows = [
      diagnosisSnapshotRow('case-1', 'person-1', [
        { id: 'dx-empty', code: '', name: '', side: '' },
        { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: '1' },
      ]),
    ];
    const result = buildDataset(rows, recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].entityKey).toEqual(['dx-1', 'right']);
  });
});

describe('buildDataset(grain=diagnosis_side) — 변수 선택과 무관하게 엔터티 모집단 불변', () => {
  it('klGrade만 요청·confirmedStatus만 요청·둘 다 요청 — 세 경우 모두 행 개수·entityKey가 같다', () => {
    const rows = [diagnosisSnapshotRow('case-1', 'person-1', [KNEE_BOTH])];

    const onlyKlg = buildDataset(rows, recipe({ variableKeys: ['knee.diagnosisSide.klGrade'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const onlyConfirmed = buildDataset(rows, recipe({ variableKeys: ['knee.diagnosisSide.confirmedStatus'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const both = buildDataset(
      rows,
      recipe({ variableKeys: ['knee.diagnosisSide.klGrade', 'knee.diagnosisSide.confirmedStatus'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );

    expect(onlyKlg.observationCount).toBe(2);
    expect(onlyConfirmed.observationCount).toBe(2);
    expect(both.observationCount).toBe(2);
    expect(onlyKlg.rows.map((r) => r.entityKey)).toEqual(onlyConfirmed.rows.map((r) => r.entityKey));
    expect(onlyKlg.rows.map((r) => r.entityKey)).toEqual(both.rows.map((r) => r.entityKey));

    expect(onlyKlg.rows[0].values['knee.diagnosisSide.confirmedStatus']).toBeUndefined();
    expect(onlyConfirmed.rows[0].values['knee.diagnosisSide.confirmedStatus'].missing).toBe('not_entered'); // confirmedRight 미입력
    expect(both.rows[0].values['knee.diagnosisSide.klGrade'].value).toBe('2');
  });
});

describe('buildDataset(grain=diagnosis_side) — 결정성', () => {
  it('동일 입력을 2회 실행하면 fact rows와 digest가 완전히 동일하다(byte-identical)', () => {
    const rows = [diagnosisSnapshotRow('case-1', 'person-1', [KNEE_BOTH])];
    const r = recipe();
    const first = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    const second = buildDataset(rows, r, RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(first.rows).toEqual(second.rows);
    expect(first.internalResultDigest).toBe(second.internalResultDigest);
  });
});

describe('buildDataset(grain=diagnosis_side) — 필터', () => {
  it('diagnosis_side grain 필터도 정상적으로 AND 결합된다', () => {
    const rows = [
      diagnosisSnapshotRow('case-1', 'person-1', [{ id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: '3' }]),
      diagnosisSnapshotRow('case-2', 'person-2', [{ id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: '1' }]),
    ];
    const result = buildDataset(
      rows,
      recipe({ filters: [{ key: 'knee.diagnosisSide.klGrade', operator: 'eq', value: '3' }] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].caseId).toBe('case-1');
  });
});

// 3차 리뷰 지적 [검증 누락] — 계획 §"검증" 1·2번을 지금까지 statsRecipeValidation.test.ts의
// 정적 카탈로그 검사(validateRecipe)로만 확인했다. 그건 "타입 조합이 허용되는가"만 보고
// 실제 추출값·KNEE_KLG_ORDER가 buildPairedDataset/groupPairsByLevel/computeAvailableMethods
// 실행 경로에서 함께 작동하는지는 증명하지 못한다 — 여기서는 buildDataset()의 실제 출력을
// 그대로 이변량 파이프라인에 흘려 실측한다.
//
// 4차 리뷰 지적 — 이전 판은 computeAvailableMethods()의 status만 확인해 "실제 분할표"를
// 검증하지 않았다(제목과 실제 검증 범위가 어긋남). 실제 Python 왕복과 HTTP /analyze
// 성공까지는 이 세션에 실행 환경이 없어 못 하지만(기존 프로젝트 관례상 그 depth의
// bivariate 검증도 statsBivariateHttp.integration.test.ts의 실 Postgres+실 Python
// Tier-3 전용이다 — mocked HTTP 인프라는 이 목적으로 없음, 이 파일 위쪽 §9 주석 참고),
// groupPairsByLevel()을 직접 호출해 실제 분할표 셀 값까지는 이 세션에서 검증한다.
describe('buildDataset(grain=diagnosis_side) — 이변량 경로 실측(계획 §11 "검증" 1·2번)', () => {
  it('K-L Grade(ordinal) × 신청≠확정 여부(boolean) — personCount===rowCount면 실제 분할표가 KNEE_KLG_ORDER 순서로 정확히 만들어지고 chi_square/fisher_exact가 available이다', () => {
    const rows = [
      // klGrade='2' & mismatch=false(신청=확정) 10명, klGrade='3' & mismatch=true(신청≠확정) 10명.
      ...Array.from({ length: 10 }, (_, i) =>
        diagnosisSnapshotRow(`case-a-${i}`, `person-a-${i}`, [
          { id: `dx-a-${i}`, code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: '2', confirmedCode: 'M17.1', confirmedName: '무릎관절증' },
        ]),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        diagnosisSnapshotRow(`case-b-${i}`, `person-b-${i}`, [
          { id: `dx-b-${i}`, code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: '3', confirmedCode: 'M17.9', confirmedName: '다른상병' },
        ]),
      ),
    ];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['knee.diagnosisSide.klGrade', 'knee.diagnosisSide.appliedConfirmedMismatch'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(20);
    expect(result.personCount).toBe(20); // side='right'뿐이라 explode 없음 — case당 행 1개, 각기 다른 person.

    const paired = buildPairedDataset(result.rows, 'knee.diagnosisSide.klGrade', 'knee.diagnosisSide.appliedConfirmedMismatch');
    expect(paired.includedPersonCount).toBe(20);
    expect(paired.includedCaseCount).toBe(20); // personCount===rowCount — §6.1 반복측정 게이트를 통과해야 한다.

    // 실제 분할표 — groupPairsByLevel을 그대로 호출해 evaluateContingency()가 내부적으로
    // 만드는 것과 동일한 셀 값을 직접 확인한다(카탈로그 순서 밖 값이 조용히 섞이지
    // 않는지, KNEE_KLG_ORDER 순서로 행이 나오는지).
    const klgOrder = getOrdinalOrder('knee.diagnosisSide.klGrade');
    expect(klgOrder).not.toBeNull();
    const { groups: xGroups } = groupPairsByLevel(paired.pairs, 'x', klgOrder!);
    const { groups: yGroups } = groupPairsByLevel(paired.pairs, 'y', [false, true]);
    expect([...xGroups.keys()]).toEqual(['2', '3']); // KNEE_KLG_ORDER(['1','2','3','4']) 부분집합 순서 그대로.
    expect([...yGroups.keys()]).toEqual([false, true]);
    expect(xGroups.get('2')).toHaveLength(10);
    expect(xGroups.get('3')).toHaveLength(10);
    // 분할표 셀 — klGrade='2'는 전부 mismatch=false, '3'은 전부 mismatch=true(교차 0건).
    expect(xGroups.get('2')!.every((p) => p.y === false)).toBe(true);
    expect(xGroups.get('3')!.every((p) => p.y === true)).toBe(true);

    const methods = computeAvailableMethods(
      'knee.diagnosisSide.klGrade',
      'knee.diagnosisSide.appliedConfirmedMismatch',
      CATALOG_BY_KEY,
      paired,
      'v1',
    );
    const chiSquare = methods.find((m) => m.id === 'chi_square')!;
    const fisherExact = methods.find((m) => m.id === 'fisher_exact')!;
    // available이려면 resolveLevelOrder('ordinal', 'knee.diagnosisSide.klGrade')가
    // statsOrdinalOrder.ts에 정확히 등록돼 있어야 하고(없으면 METHOD_TYPE_MISMATCH),
    // groupPairsByLevel이 그 순서로 실제 추출값 '2'/'3'을 올바르게 묶어야 한다
    // (기대도수 5=5는 <5가 아니라 LOW_EXPECTED_COUNT로 새지 않는다).
    expect(chiSquare.status).toBe('available');
    expect(chiSquare.reasonCode).toBeNull();
    expect(fisherExact.status).toBe('available');
  });

  it('동일인의 양측(side=both) 유효 관측 2건 — personCount<rowCount라 실행가능 8종 전부 REPEATED_MEASURES_NOT_ALIGNED로 차단된다(기술통계는 별도로 계속 허용됨, §6.9.3)', () => {
    const rows = [
      diagnosisSnapshotRow('case-1', 'person-1', [
        {
          id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both',
          klgRight: '2', klgLeft: '3', confirmedCode: 'M17.9', confirmedName: '다른상병',
        },
      ]),
    ];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['knee.diagnosisSide.klGrade', 'knee.diagnosisSide.appliedConfirmedMismatch'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(2); // side=both explode — 우/좌 2행.
    expect(result.personCount).toBe(1); // 같은 case, 같은 사람.

    const paired = buildPairedDataset(result.rows, 'knee.diagnosisSide.klGrade', 'knee.diagnosisSide.appliedConfirmedMismatch');
    expect(paired.includedPersonCount).toBe(1);
    expect(paired.includedCaseCount).toBe(2); // = rowCount. personCount(1) < rowCount(2).

    const methods = computeAvailableMethods(
      'knee.diagnosisSide.klGrade',
      'knee.diagnosisSide.appliedConfirmedMismatch',
      CATALOG_BY_KEY,
      paired,
      'v1',
    );
    // 대응검정 2종은 §6.1 게이트와 무관하게 항상 PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING이므로
    // 제외하고, 나머지 실행가능 8종 전부가 이 게이트로 막히는지 확인한다.
    const executableMethods = methods.filter((m) => m.id !== 'paired_t' && m.id !== 'wilcoxon_signed_rank');
    expect(executableMethods).toHaveLength(8);
    for (const m of executableMethods) {
      expect(m.status, m.id).toBe('unsupported');
      expect(m.reasonCode, m.id).toBe('REPEATED_MEASURES_NOT_ALIGNED');
    }
  });
});

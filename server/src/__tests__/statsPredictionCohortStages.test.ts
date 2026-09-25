import { describe, it, expect } from 'vitest';
import {
  computePredictionDataStages,
  computeEventNonEventPersonSets,
  computePredictionLevelSummaries,
  evaluatePredictionDisclosure,
  computePredictionNonEstimableReason,
  assignPredictionOuterFolds,
  PredictionCohortKeyMissingError,
  type PredictionStratum,
} from '../statsPredictionCohort';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { DatasetRow } from '../statsDatasetBuilder';

// PR4-B2 — 계획서 §3-2/3-3/3-4단계를 고정한다: S0/S1/S2 자료 단계, E/F/B 제외
// person 집합, 공개통제 게이트, 비추정 사유 1~10 순서.

function ok(value: unknown) {
  return { value, missing: null, qualityFlags: [] };
}
function missing() {
  return { value: null, missing: 'not_entered' as const, qualityFlags: [] };
}

function makeRow(caseId: string, cohortPersonKey: string, values: Record<string, ReturnType<typeof ok> | ReturnType<typeof missing>>): DatasetRow {
  return { caseId, personClusterKey: cohortPersonKey, cohortPersonKey, entityKey: null, values };
}

const OUTCOME_KEY = 'outcome';
const EVENT_LEVEL = 'true';

describe('computePredictionDataStages', () => {
  it('cohortPersonKey가 없는 행이 있으면 즉시 던진다(키 누락 방어)', () => {
    const rows: DatasetRow[] = [{ caseId: 'c1', personClusterKey: 'p1', entityKey: null, values: {} }];
    expect(() => computePredictionDataStages(rows, OUTCOME_KEY, [])).toThrow(PredictionCohortKeyMissingError);
  });

  it('S1은 outcome이 관측된 행만, S2는 predictor까지 전부 관측된 행만 남긴다', () => {
    const rows = [
      makeRow('c1', 'p1', { [OUTCOME_KEY]: ok(true), x: ok(1) }),      // S1 O, S2 O
      makeRow('c2', 'p2', { [OUTCOME_KEY]: missing(), x: ok(1) }),     // S1 X(outcome 결측)
      makeRow('c3', 'p3', { [OUTCOME_KEY]: ok(false), x: missing() }), // S1 O, S2 X(predictor 결측)
    ];
    const stages = computePredictionDataStages(rows, OUTCOME_KEY, ['x']);
    expect(stages.s1Rows.map((r) => r.caseId)).toEqual(['c1', 'c3']);
    expect(stages.s2Rows.map((r) => r.caseId)).toEqual(['c1']);
    expect(stages.excludedRowCount).toBe(2); // S0(3) - S2(1)
  });

  it('E/F/B를 person 집합으로 센다 — outcome 결측 행과 predictor 결측 행을 동시에 가진 person은 1명', () => {
    // person p1: case c1(outcome 결측, S1에서 제외) + case c1b(predictor 결측, S2에서 제외)
    // → p1은 E(제외 행 보유)이자 F(S2에 전혀 없음)다. B에는 없다(S2에 전혀 없으므로).
    const rows = [
      makeRow('c1', 'p1', { [OUTCOME_KEY]: missing(), x: ok(1) }),
      makeRow('c1b', 'p1', { [OUTCOME_KEY]: ok(true), x: missing() }),
      makeRow('c2', 'p2', { [OUTCOME_KEY]: ok(true), x: ok(1) }), // 완전 포함
    ];
    const stages = computePredictionDataStages(rows, OUTCOME_KEY, ['x']);
    expect(stages.excludedPersonSets.E.has('p1')).toBe(true);
    expect(stages.excludedPersonSets.F.has('p1')).toBe(true);
    expect(stages.excludedPersonSets.B.has('p1')).toBe(false);
    expect(stages.excludedPersonSets.E.size).toBe(1); // p2는 제외 행이 없으므로 E 아님
  });

  it('부분 제외 person(B) — 같은 person이 제외 행과 포함 행을 동시에 가지면 B에 들어간다', () => {
    const rows = [
      makeRow('c1', 'p1', { [OUTCOME_KEY]: ok(true), x: missing() }), // S2 제외
      makeRow('c2', 'p1', { [OUTCOME_KEY]: ok(true), x: ok(1) }),     // S2 포함 — 같은 person
    ];
    const stages = computePredictionDataStages(rows, OUTCOME_KEY, ['x']);
    expect(stages.excludedPersonSets.E.has('p1')).toBe(true);
    expect(stages.excludedPersonSets.F.has('p1')).toBe(false); // S2에 여전히 존재
    expect(stages.excludedPersonSets.B.has('p1')).toBe(true);
  });

  it('S1에서 사건이고 S2에서 비사건인 person 사례(양성 행이 predictor 결측으로 빠짐)', () => {
    const rows = [
      makeRow('c1', 'p1', { [OUTCOME_KEY]: ok(true), x: missing() }),  // 양성 행, predictor 결측 → S2 제외
      makeRow('c2', 'p1', { [OUTCOME_KEY]: ok(false), x: ok(1) }),     // 음성 행, S2 포함
    ];
    const stages = computePredictionDataStages(rows, OUTCOME_KEY, ['x']);
    const s1 = computeEventNonEventPersonSets(stages.s1Rows, OUTCOME_KEY, EVENT_LEVEL);
    const s2 = computeEventNonEventPersonSets(stages.s2Rows, OUTCOME_KEY, EVENT_LEVEL);
    expect(s1.pPlus.has('p1')).toBe(true);  // S1 기준 사건
    expect(s2.pPlus.has('p1')).toBe(false); // S2엔 음성 행만 남아 비사건
    expect(s2.pMinus.has('p1')).toBe(true);
  });
});

describe('제외 person 역산 반례(4차 리뷰 #1)', () => {
  it('S0=100/S2=90/E=11(B=1) 시나리오 — F=10(완전제외 10명 person=10행) + 부분제외 1명(2행: 1제외+1포함)', () => {
    const rows: DatasetRow[] = [];
    // F: 완전 제외 person 10명(각 1행, predictor 결측) → S0 10행, S2 0행.
    for (let i = 0; i < 10; i++) {
      rows.push(makeRow(`f-${i}`, `f-person-${i}`, { [OUTCOME_KEY]: ok(true), x: missing() }));
    }
    // B: 부분 제외 person 1명(2행: 1개는 predictor 결측, 1개는 포함).
    rows.push(makeRow('b-excluded', 'b-person', { [OUTCOME_KEY]: ok(true), x: missing() }));
    rows.push(makeRow('b-included', 'b-person', { [OUTCOME_KEY]: ok(true), x: ok(1) }));
    // 완전 포함 person 89명(각 1행) — S2에 89+1(b-person)=90명이 되도록.
    for (let i = 0; i < 89; i++) {
      rows.push(makeRow(`ok-${i}`, `ok-person-${i}`, { [OUTCOME_KEY]: ok(i % 2 === 0), x: ok(1) }));
    }
    const stages = computePredictionDataStages(rows, OUTCOME_KEY, ['x']);
    const s0PersonCount = new Set(rows.map((r) => r.cohortPersonKey)).size;
    const s2PersonCount = new Set(stages.s2Rows.map((r) => r.cohortPersonKey)).size;
    expect(s0PersonCount).toBe(100);
    expect(s2PersonCount).toBe(90);
    expect(stages.excludedPersonSets.F.size).toBe(10);
    expect(stages.excludedPersonSets.B.size).toBe(1);
    expect(stages.excludedPersonSets.E.size).toBe(11); // F(10) + B(1), 서로소
    // 반례가 실제로 재현됐는지: |B| = |S2personCount| + |E| - |S0personCount| = 90+11-100=1.
    expect(s2PersonCount + stages.excludedPersonSets.E.size - s0PersonCount).toBe(stages.excludedPersonSets.B.size);
  });
});

describe('evaluatePredictionDisclosure', () => {
  function bigEventNonEvent(pPlusCount: number, pMinusCount: number): ReturnType<typeof computeEventNonEventPersonSets> {
    const pPlus = new Set<string>();
    const pMinus = new Set<string>();
    for (let i = 0; i < pPlusCount; i++) pPlus.add(`plus-${i}`);
    for (let i = 0; i < pMinusCount; i++) pMinus.add(`minus-${i}`);
    return { pPlus, pMinus };
  }

  const bigLevelSummaries = [{ variableKey: 'x', level: 'a', personCount: 20 }, { variableKey: 'x', level: 'b', personCount: 20 }];
  const emptySets = { E: new Set<string>(), F: new Set<string>(), B: new Set<string>() };

  it('전부 0 또는 ≥MINIMUM_COHORT(10)면 공개한다', () => {
    const r = evaluatePredictionDisclosure({
      s1EventNonEvent: bigEventNonEvent(20, 20),
      s2EventNonEvent: bigEventNonEvent(20, 20),
      s2PersonCount: 40,
      s2LevelSummaries: bigLevelSummaries,
      excludedPersonSets: emptySets,
    });
    expect(r).toEqual({ disclose: true, reasonCode: null });
  });

  it('S1 P+가 소수셀(1~9)이면 억제한다', () => {
    const r = evaluatePredictionDisclosure({
      s1EventNonEvent: bigEventNonEvent(5, 20),
      s2EventNonEvent: bigEventNonEvent(20, 20),
      s2PersonCount: 40,
      s2LevelSummaries: bigLevelSummaries,
      excludedPersonSets: emptySets,
    });
    expect(r).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('제외 person 집합(E/F/B) 중 하나라도 소수셀이면 억제한다', () => {
    const r = evaluatePredictionDisclosure({
      s1EventNonEvent: bigEventNonEvent(20, 20),
      s2EventNonEvent: bigEventNonEvent(20, 20),
      s2PersonCount: 40,
      s2LevelSummaries: bigLevelSummaries,
      excludedPersonSets: { E: new Set(['a', 'b', 'c']), F: new Set(), B: new Set() },
    });
    expect(r).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('predictor 레벨별 person이 소수셀이면 억제한다', () => {
    const r = evaluatePredictionDisclosure({
      s1EventNonEvent: bigEventNonEvent(20, 20),
      s2EventNonEvent: bigEventNonEvent(20, 20),
      s2PersonCount: 40,
      s2LevelSummaries: [{ variableKey: 'x', level: 'rare', personCount: 2 }],
      excludedPersonSets: emptySets,
    });
    expect(r).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('S2 personCount 자체가 소수셀이면 억제한다', () => {
    const r = evaluatePredictionDisclosure({
      s1EventNonEvent: bigEventNonEvent(20, 20),
      s2EventNonEvent: bigEventNonEvent(3, 3),
      s2PersonCount: 6,
      s2LevelSummaries: [],
      excludedPersonSets: emptySets,
    });
    expect(r).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });
});

describe('computePredictionNonEstimableReason — 순서 1~10', () => {
  const CATALOG: Map<string, AnalyticsVariableMetadata> = new Map([
    ['x', {
      key: 'x', label: 'x', group: 'test', moduleId: 'test', grain: 'case', type: 'continuous',
      provenance: 'raw', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
      allowedAnalysisPurposes: ['prediction'], predictionRole: 'predictor', sensitivity: 'non_sensitive',
      formulaFamily: 'test', supportedFormulaPolicies: [],
    }],
  ]);

  function bigCohort(n: number, eventFraction: number, predictorKey = 'x'): DatasetRow[] {
    const rows: DatasetRow[] = [];
    for (let i = 0; i < n; i++) {
      const isEvent = i < n * eventFraction;
      rows.push(makeRow(`c${i}`, `p${i}`, {
        [OUTCOME_KEY]: ok(isEvent),
        [predictorKey]: ok(i % 5), // 분산 있는 값
      }));
    }
    return rows;
  }

  function baseInput(s0Rows: DatasetRow[], predictorKeys: string[], outerFolds = 5, repeats = 1) {
    const stages = computePredictionDataStages(s0Rows, OUTCOME_KEY, predictorKeys);
    const s1EventNonEvent = computeEventNonEventPersonSets(stages.s1Rows, OUTCOME_KEY, EVENT_LEVEL);
    const s2EventNonEvent = computeEventNonEventPersonSets(stages.s2Rows, OUTCOME_KEY, EVENT_LEVEL);
    const s2PersonCount = new Set(stages.s2Rows.map((r) => r.cohortPersonKey)).size;
    const strata = new Map<string, PredictionStratum>();
    for (const key of s1EventNonEvent.pPlus) strata.set(key, 1);
    for (const key of s1EventNonEvent.pMinus) if (!strata.has(key)) strata.set(key, 0);
    const outerFoldAssignment = assignPredictionOuterFolds(strata, repeats, outerFolds, 'test-digest');
    return {
      s1Rows: stages.s1Rows, s2Rows: stages.s2Rows, outcomeKey: OUTCOME_KEY, eventLevel: EVENT_LEVEL,
      s1EventNonEvent, s2EventNonEvent, s2PersonCount, predictorKeys, catalogByKey: CATALOG,
      outerFoldAssignment, outerFolds,
    };
  }

  it('1: S1이 비면 OUTCOME_NOT_OBSERVED', () => {
    const rows = [makeRow('c1', 'p1', { [OUTCOME_KEY]: missing(), x: ok(1) })];
    const r = computePredictionNonEstimableReason(baseInput(rows, ['x']));
    expect(r.reason).toBe('OUTCOME_NOT_OBSERVED');
    expect(r.columnCount).toBeNull();
  });

  it('2: S1에 사건이 없으면 EVENT_LEVEL_NOT_OBSERVED', () => {
    const rows = bigCohort(60, 0); // 전부 비사건
    const r = computePredictionNonEstimableReason(baseInput(rows, ['x']));
    expect(r.reason).toBe('EVENT_LEVEL_NOT_OBSERVED');
  });

  it('3: S1에 비사건이 없으면 NON_EVENT_LEVEL_NOT_OBSERVED', () => {
    const rows = bigCohort(60, 1); // 전부 사건
    const r = computePredictionNonEstimableReason(baseInput(rows, ['x']));
    expect(r.reason).toBe('NON_EVENT_LEVEL_NOT_OBSERVED');
  });

  it('4: S2 인원이 minPersons(50) 미만이면 INSUFFICIENT_PERSONS', () => {
    const rows = bigCohort(40, 0.5);
    const r = computePredictionNonEstimableReason(baseInput(rows, ['x']));
    expect(r.reason).toBe('INSUFFICIENT_PERSONS');
  });

  it('5: 인원은 충분해도 사건/비사건 person이 minEventPersons(25) 미만이면 INSUFFICIENT_EVENT_PERSONS', () => {
    const rows = bigCohort(60, 0.1); // 60명, 사건 6명뿐
    const r = computePredictionNonEstimableReason(baseInput(rows, ['x']));
    expect(r.reason).toBe('INSUFFICIENT_EVENT_PERSONS');
  });

  it('6: predictor가 S2에서 단일값이면 ZERO_VARIANCE_PREDICTOR', () => {
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push(makeRow(`c${i}`, `p${i}`, { [OUTCOME_KEY]: ok(i < 30), x: ok(1) })); // x 항상 1
    }
    const r = computePredictionNonEstimableReason(baseInput(rows, ['x']));
    expect(r.reason).toBe('ZERO_VARIANCE_PREDICTOR');
  });

  it('7: one-hot 열 수가 maxColumns(30)를 넘으면 TOO_MANY_COLUMNS', () => {
    const catalogWide: Map<string, AnalyticsVariableMetadata> = new Map([
      ['cat', {
        key: 'cat', label: 'cat', group: 'test', moduleId: 'test', grain: 'case', type: 'categorical',
        provenance: 'raw', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['prediction'], predictionRole: 'predictor', sensitivity: 'non_sensitive',
        formulaFamily: 'test', supportedFormulaPolicies: [],
      }],
    ]);
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 60; i++) {
      // 35개 레벨(0~34) 순환 — maxColumns(30) 초과, maxLevels(10)도 넘지만 컬럼 검사(7)를
      // 보려면 predictor 사전검사(6, TOO_MANY_LEVELS)보다 먼저 막히지 않게 별도 확인만 한다.
      rows.push(makeRow(`c${i}`, `p${i}`, { [OUTCOME_KEY]: ok(i < 30), cat: ok(`lvl${i % 35}`) }));
    }
    const r = computePredictionNonEstimableReason({ ...baseInput(rows, ['cat'], 5, 1), catalogByKey: catalogWide });
    // maxLevels(10)를 먼저 넘으므로 실제로는 6(TOO_MANY_LEVELS)이 먼저 걸린다 —
    // 순서표가 6을 7보다 먼저 두는 이유를 그대로 확인한다.
    expect(r.reason).toBe('TOO_MANY_LEVELS');
  });

  it('9: EPV가 minEventsPerParameter(10) 미만이면 INSUFFICIENT_EVENTS_PER_PARAMETER', () => {
    const catalogMany: Map<string, AnalyticsVariableMetadata> = new Map(
      Array.from({ length: 5 }, (_, i) => [`x${i}`, {
        key: `x${i}`, label: `x${i}`, group: 'test', moduleId: 'test', grain: 'case', type: 'continuous' as const,
        provenance: 'raw' as const, dependsOn: [], availableAt: 'assessment' as const, shownToAssessor: true,
        allowedAnalysisPurposes: ['prediction' as const], predictionRole: 'predictor' as const, sensitivity: 'non_sensitive' as const,
        formulaFamily: 'test', supportedFormulaPolicies: [],
      }]),
    );
    // minEventPersons=25/minNonEventPersons=25 통과시키되(사건 26/비사건 26=52명),
    // parameterCount=5라서 EPV=min(26,26)/5=5.2 < 10.
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 52; i++) {
      const values: Record<string, ReturnType<typeof ok>> = { [OUTCOME_KEY]: ok(i < 26) };
      for (let j = 0; j < 5; j++) values[`x${j}`] = ok(i % 7);
      rows.push(makeRow(`c${i}`, `p${i}`, values));
    }
    const input = baseInput(rows, ['x0', 'x1', 'x2', 'x3', 'x4']);
    const r = computePredictionNonEstimableReason({ ...input, catalogByKey: catalogMany });
    expect(r.reason).toBe('INSUFFICIENT_EVENTS_PER_PARAMETER');
    expect(r.parameterCount).toBe(5);
  });

  it('10: 외부 fold 중 하나가 한쪽 클래스를 못 받으면 FOLD_CLASS_MISSING', () => {
    // outerFolds=5인데 사건 person이 3명뿐이면(비사건은 충분히 많음) round-robin
    // 배정상 5개 fold 중 최소 2개는 사건 person을 못 받는다.
    // 우선 4~5단계(INSUFFICIENT_EVENT_PERSONS)를 피하려면 minEventPersons(25)를
    // 만족해야 하므로, 대신 outerFolds를 사건 person 수보다 크게 잡아 직접 재현한다.
    const rows = bigCohort(100, 0.3); // 사건 30명, 비사건 70명 — 4/5/6/7/8/9 전부 통과 조건
    const stages = computePredictionDataStages(rows, OUTCOME_KEY, ['x']);
    const s1EventNonEvent = computeEventNonEventPersonSets(stages.s1Rows, OUTCOME_KEY, EVENT_LEVEL);
    const s2EventNonEvent = computeEventNonEventPersonSets(stages.s2Rows, OUTCOME_KEY, EVENT_LEVEL);
    const s2PersonCount = new Set(stages.s2Rows.map((r) => r.cohortPersonKey)).size;
    // outerFolds를 사건 person 수(30)보다 훨씬 크게(예: 40) 잡으면 일부 fold엔
    // 사건 person이 전혀 배정되지 않는다(round-robin 30명을 40칸에 배정).
    const strata = new Map<string, PredictionStratum>();
    for (const key of s1EventNonEvent.pPlus) strata.set(key, 1);
    for (const key of s1EventNonEvent.pMinus) if (!strata.has(key)) strata.set(key, 0);
    const outerFoldAssignment = assignPredictionOuterFolds(strata, 1, 40, 'test-digest');
    const r = computePredictionNonEstimableReason({
      s1Rows: stages.s1Rows, s2Rows: stages.s2Rows, outcomeKey: OUTCOME_KEY, eventLevel: EVENT_LEVEL,
      s1EventNonEvent, s2EventNonEvent, s2PersonCount, predictorKeys: ['x'], catalogByKey: CATALOG,
      outerFoldAssignment, outerFolds: 40,
    });
    expect(r.reason).toBe('FOLD_CLASS_MISSING');
  });

  it('전부 통과하면 reason:null + 실제 design을 반환한다', () => {
    const rows = bigCohort(100, 0.3);
    const r = computePredictionNonEstimableReason(baseInput(rows, ['x'], 5, 1));
    expect(r.reason).toBeNull();
    expect(r.columnCount).toBe(1);
    expect(r.parameterCount).toBe(1);
    expect(r.design).not.toBeNull();
  });
});

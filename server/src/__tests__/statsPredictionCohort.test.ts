import { describe, it, expect } from 'vitest';
import { computePredictionCohortDigest, assignPredictionOuterFolds } from '../statsPredictionCohort';
import type { StatsAnalysisRecipe } from '@wr/contracts';

// PR4-B2 — 계획서 §3-1단계 "코호트 person 키 — snapshot에서 만들어 frozen 입력으로
// 운반" + "fold 배정(순수 함수)"을 고정한다.

function baseRecipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'case',
    variableKeys: ['diagnosis.rollup.anyHighRelatedness', 'patient.identity.gender'],
    filters: [],
    analysisPurpose: 'prediction',
    formulaPolicies: {},
    analysisMode: 'prediction',
    prediction: { outcomeKey: 'diagnosis.rollup.anyHighRelatedness', eventLevel: 'true' },
    ...overrides,
  };
}

describe('computePredictionCohortDigest', () => {
  it('같은 레시피는 항상 같은 digest를 낸다', () => {
    const r = baseRecipe();
    expect(computePredictionCohortDigest(r)).toBe(computePredictionCohortDigest(r));
  });

  it('predictor(variableKeys)가 바뀌어도 digest는 불변이다(3차 리뷰 #3-1 — 예측변수와 무관)', () => {
    const a = computePredictionCohortDigest(baseRecipe({
      variableKeys: ['diagnosis.rollup.anyHighRelatedness', 'patient.identity.gender'],
    }));
    const b = computePredictionCohortDigest(baseRecipe({
      variableKeys: ['diagnosis.rollup.anyHighRelatedness', 'patient.identity.gender', 'patient.identity.bmi'],
    }));
    expect(a).toBe(b);
  });

  it('필터 배열 순서가 달라도 digest는 같다(정규 정렬)', () => {
    const a = computePredictionCohortDigest(baseRecipe({
      filters: [
        { key: 'patient.identity.gender', operator: 'eq', value: 'male' },
        { key: 'case.meta.registeredAt', operator: 'not_missing' },
      ],
    }));
    const b = computePredictionCohortDigest(baseRecipe({
      filters: [
        { key: 'case.meta.registeredAt', operator: 'not_missing' },
        { key: 'patient.identity.gender', operator: 'eq', value: 'male' },
      ],
    }));
    expect(a).toBe(b);
  });

  it('필터 내용이 바뀌면 digest가 바뀐다', () => {
    const a = computePredictionCohortDigest(baseRecipe({ filters: [] }));
    const b = computePredictionCohortDigest(baseRecipe({
      filters: [{ key: 'patient.identity.gender', operator: 'eq', value: 'male' }],
    }));
    expect(a).not.toBe(b);
  });

  it('outcomeKey가 바뀌면 digest가 바뀐다', () => {
    const a = computePredictionCohortDigest(baseRecipe());
    const b = computePredictionCohortDigest(baseRecipe({
      variableKeys: ['diagnosis.assessment.status', 'patient.identity.gender'],
      prediction: { outcomeKey: 'diagnosis.assessment.status', eventLevel: 'high' },
    }));
    expect(a).not.toBe(b);
  });

  it('eventLevel이 바뀌면 digest가 바뀐다', () => {
    const a = computePredictionCohortDigest(baseRecipe({
      variableKeys: ['diagnosis.assessment.status', 'patient.identity.gender'],
      prediction: { outcomeKey: 'diagnosis.assessment.status', eventLevel: 'high' },
    }));
    const b = computePredictionCohortDigest(baseRecipe({
      variableKeys: ['diagnosis.assessment.status', 'patient.identity.gender'],
      prediction: { outcomeKey: 'diagnosis.assessment.status', eventLevel: 'low' },
    }));
    expect(a).not.toBe(b);
  });

  it('grain이 바뀌면 digest가 바뀐다', () => {
    const a = computePredictionCohortDigest(baseRecipe({ grain: 'case' }));
    const b = computePredictionCohortDigest(baseRecipe({ grain: 'disease' }));
    expect(a).not.toBe(b);
  });

  it('analysisMode가 prediction이 아니면 던진다', () => {
    expect(() => computePredictionCohortDigest(baseRecipe({ analysisMode: 'descriptive' })))
      .toThrow();
  });
});

describe('assignPredictionOuterFolds', () => {
  function makeStrata(eventCount: number, nonEventCount: number): Map<string, 0 | 1> {
    const m = new Map<string, 0 | 1>();
    for (let i = 0; i < eventCount; i++) m.set(`event-${i}`, 1);
    for (let i = 0; i < nonEventCount; i++) m.set(`nonevent-${i}`, 0);
    return m;
  }

  it('같은 입력은 항상 같은 배정을 낸다(결정성)', () => {
    const strata = makeStrata(20, 30);
    const a = assignPredictionOuterFolds(strata, 3, 5, 'digest-1');
    const b = assignPredictionOuterFolds(strata, 3, 5, 'digest-1');
    for (let repeat = 1; repeat <= 3; repeat++) {
      expect(Object.fromEntries(a.get(repeat)!)).toEqual(Object.fromEntries(b.get(repeat)!));
    }
  });

  it('cohortDigest가 다르면 배정이 달라진다', () => {
    const strata = makeStrata(20, 30);
    const a = assignPredictionOuterFolds(strata, 1, 5, 'digest-1').get(1)!;
    const b = assignPredictionOuterFolds(strata, 1, 5, 'digest-2').get(1)!;
    let anyDifferent = false;
    for (const [key, fold] of a) {
      if (b.get(key) !== fold) { anyDifferent = true; break; }
    }
    expect(anyDifferent).toBe(true);
  });

  it('모든 person이 [0, outerFolds) 범위의 fold를 정확히 하나씩 받는다', () => {
    const strata = makeStrata(20, 30);
    const result = assignPredictionOuterFolds(strata, 2, 5, 'digest-1');
    for (let repeat = 1; repeat <= 2; repeat++) {
      const assignment = result.get(repeat)!;
      expect(assignment.size).toBe(strata.size);
      for (const fold of assignment.values()) {
        expect(fold).toBeGreaterThanOrEqual(0);
        expect(fold).toBeLessThan(5);
      }
    }
  });

  it('층별로 각 fold의 인원 편차가 1 이하다(round-robin 균등 배정)', () => {
    const strata = makeStrata(23, 37); // 5로 나누어떨어지지 않는 인원수
    const assignment = assignPredictionOuterFolds(strata, 1, 5, 'digest-1').get(1)!;
    for (const stratumValue of [0, 1] as const) {
      const counts = new Array(5).fill(0);
      for (const [key, fold] of assignment) {
        if (strata.get(key) === stratumValue) counts[fold]++;
      }
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      expect(max - min).toBeLessThanOrEqual(1);
    }
  });

  it('같은 person이 반복(repeat)마다 다른 fold에 배정될 수 있다(반복 grouped CV)', () => {
    const strata = makeStrata(30, 40);
    const result = assignPredictionOuterFolds(strata, 5, 5, 'digest-1');
    let anyRepeatDiffers = false;
    const repeat1 = result.get(1)!;
    for (let repeat = 2; repeat <= 5; repeat++) {
      const assignment = result.get(repeat)!;
      for (const [key, fold] of assignment) {
        if (repeat1.get(key) !== fold) { anyRepeatDiffers = true; break; }
      }
      if (anyRepeatDiffers) break;
    }
    expect(anyRepeatDiffers).toBe(true);
  });
});

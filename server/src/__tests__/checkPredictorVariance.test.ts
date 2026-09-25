import { describe, it, expect } from 'vitest';
import { checkPredictorVariance } from '../statsRegressionDesign';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { DatasetRow } from '../statsDatasetBuilder';

// PR4-B2 — statsRegressionDesign.ts에서 추출한 predictor 사전검사(계획서 §3단계
// "association 코드는 동작을 바꾸지 않는 추출로만 공유한다"). 회귀 쪽 동작 불변은
// statsRegressionDesign.test.ts(25개, 무수정 통과)가 이미 고정했으므로, 여기서는
// 추출된 함수 자체의 계약(maxLevels 인자화 포함)만 직접 확인한다.

function makeVariable(type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key: 'x', label: 'x', group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'raw', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association'], sensitivity: 'non_sensitive',
    formulaFamily: 'test', supportedFormulaPolicies: [],
  };
}

function makeRows(values: unknown[]): DatasetRow[] {
  return values.map((v, i) => ({
    caseId: `case-${i}`, personClusterKey: `person-${i}`, entityKey: null,
    values: { x: { value: v, missing: null, qualityFlags: [] } },
  }));
}

describe('checkPredictorVariance', () => {
  it('continuous: 값이 전부 같으면 ZERO_VARIANCE_PREDICTOR', () => {
    const r = checkPredictorVariance('x', makeVariable('continuous'), makeRows([1, 1, 1]), 10);
    expect(r).toEqual({ ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' });
  });

  it('continuous: 값이 다양하면 통과', () => {
    const r = checkPredictorVariance('x', makeVariable('continuous'), makeRows([1, 2, 3]), 10);
    expect(r).toEqual({ ok: true });
  });

  it('boolean: 한 레벨만 관측되면 ZERO_VARIANCE_PREDICTOR', () => {
    const r = checkPredictorVariance('x', makeVariable('boolean'), makeRows([true, true, true]), 10);
    expect(r).toEqual({ ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' });
  });

  it('boolean: 두 레벨 다 관측되면 통과', () => {
    const r = checkPredictorVariance('x', makeVariable('boolean'), makeRows([true, false]), 10);
    expect(r).toEqual({ ok: true });
  });

  it('categorical: 한 레벨만 관측되면 ZERO_VARIANCE_PREDICTOR', () => {
    const r = checkPredictorVariance('x', makeVariable('categorical'), makeRows(['a', 'a']), 10);
    expect(r).toEqual({ ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' });
  });

  it('categorical: 관측 레벨 수가 maxLevels를 넘으면 TOO_MANY_LEVELS', () => {
    const r = checkPredictorVariance('x', makeVariable('categorical'), makeRows(['a', 'b', 'c', 'd']), 3);
    expect(r).toEqual({ ok: false, reason: 'TOO_MANY_LEVELS' });
  });

  it('categorical: maxLevels 인자가 회귀(REGRESSION_POLICY.maxLevels=10)와 다른 값을 써도 그대로 적용된다', () => {
    // 예측 정책(PREDICTION_POLICY.maxLevels)도 10이지만, 이 함수 자체는 정책과
    // 무관한 순수 함수임을 확인 — 임의 값 2로도 정상 동작해야 한다.
    const r = checkPredictorVariance('x', makeVariable('categorical'), makeRows(['a', 'b', 'c']), 2);
    expect(r).toEqual({ ok: false, reason: 'TOO_MANY_LEVELS' });
  });

  it('ordinal도 categorical과 동일 규칙을 따른다', () => {
    const ok = checkPredictorVariance('x', makeVariable('ordinal'), makeRows(['1', '2']), 10);
    expect(ok).toEqual({ ok: true });
    const zeroVariance = checkPredictorVariance('x', makeVariable('ordinal'), makeRows(['1', '1']), 10);
    expect(zeroVariance).toEqual({ ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' });
  });
});

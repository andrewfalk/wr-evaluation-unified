// PR4-B2 — computePredictionAvailableMethods 단위테스트. 회귀와 달리 방법이
// l2_logistic 1종뿐이라 outcome 타입별 후보 순회가 없다 — A-1 구조적 사실
// (S2 인원 0건·outcome 역할 불일치)만 판정한다.
import { describe, it, expect } from 'vitest';
import { computePredictionAvailableMethods } from '../statsMethodCatalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

const METHOD_POLICY_VERSION = 'v1-prediction';

function makeVariable(key: string, predictionRole?: 'outcome' | 'predictor'): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type: 'boolean',
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['prediction'], predictionRole, sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: [],
  };
}

describe('computePredictionAvailableMethods', () => {
  // 코드리뷰(2026-09-25) — s2PersonCount===0을 여기서 unsupported로 끝내면
  // statsAnalyzeHandler.ts의 실행가능 게이트가 400 METHOD_NOT_AVAILABLE로
  // 종결시켜, OUTCOME_NOT_OBSERVED/INSUFFICIENT_PERSONS 같은 계획에 명시된
  // non_estimable 사유가 응답에 영영 나타나지 못하게 됐다(공개통제 통과 후에도).
  // 데이터량 판정은 오직 statsPredictionCohort.ts의 비추정 파이프라인 몫이다.
  it('s2PersonCount===0이어도 outcome 역할이 맞으면 available(데이터량 판정은 비추정 파이프라인 몫)', () => {
    const catalog = new Map([['outcomeVar', makeVariable('outcomeVar', 'outcome')]]);
    const methods = computePredictionAvailableMethods(0, 'outcomeVar', catalog, METHOD_POLICY_VERSION);
    expect(methods).toHaveLength(1);
    expect(methods[0].id).toBe('l2_logistic');
    expect(methods[0].status).toBe('available');
    expect(methods[0].reasonCode).toBeNull();
    expect(methods[0].observed).toEqual({ personCount: 0, rowCount: 0 });
  });

  it('outcome 미지정이면 METHOD_TYPE_MISMATCH', () => {
    const catalog = new Map<string, AnalyticsVariableMetadata>();
    const methods = computePredictionAvailableMethods(40, null, catalog, METHOD_POLICY_VERSION);
    expect(methods[0].status).toBe('unsupported');
    expect(methods[0].reasonCode).toBe('METHOD_TYPE_MISMATCH');
  });

  it('outcomeKey가 predictionRole:predictor인 변수를 가리키면 METHOD_TYPE_MISMATCH', () => {
    const catalog = new Map([['predictorVar', makeVariable('predictorVar', 'predictor')]]);
    const methods = computePredictionAvailableMethods(40, 'predictorVar', catalog, METHOD_POLICY_VERSION);
    expect(methods[0].status).toBe('unsupported');
    expect(methods[0].reasonCode).toBe('METHOD_TYPE_MISMATCH');
  });

  it('정상 조건이면 available', () => {
    const catalog = new Map([['outcomeVar', makeVariable('outcomeVar', 'outcome')]]);
    const methods = computePredictionAvailableMethods(40, 'outcomeVar', catalog, METHOD_POLICY_VERSION);
    expect(methods[0].status).toBe('available');
    expect(methods[0].reasonCode).toBeNull();
    expect(methods[0].purpose).toBe('prediction');
    expect(methods[0].observed).toEqual({ personCount: 40, rowCount: 40 });
  });
});

import { describe, it, expect } from 'vitest';
import { assertPredictionCatalogInvariants } from '../statsCatalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

// PR4-B2 — 계획서 §2단계 "getIntegratedCatalog() 기동 시 throw하는 검사 4종"을 합성
// 카탈로그로 각각 재현한다. 실제 카탈로그는 statsCatalog.test.ts가 이미 이 함수를
// 통과하는 것으로 간접 검증한다 — 여기는 "왜 막히는지" 4가지 경로를 각각 고정한다.

function makeVariable(overrides: Partial<AnalyticsVariableMetadata> & { key: string }): AnalyticsVariableMetadata {
  return {
    label: overrides.key,
    group: 'test',
    moduleId: 'test',
    grain: 'case',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: [],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: [],
    sensitivity: 'non_sensitive',
    formulaFamily: 'test_family',
    supportedFormulaPolicies: [],
    ...overrides,
  };
}

describe('assertPredictionCatalogInvariants', () => {
  it('predictionRole 없이 predictor/outcome이 아닌 정상 카탈로그는 통과한다', () => {
    expect(() => assertPredictionCatalogInvariants([
      makeVariable({ key: 'a', allowedAnalysisPurposes: ['association'] }),
    ])).not.toThrow();
  });

  it('정상 predictor + 명세에 있는 outcome 조합은 통과한다', () => {
    expect(() => assertPredictionCatalogInvariants([
      makeVariable({
        key: 'diagnosis.rollup.anyHighRelatedness', type: 'boolean', predictionRole: 'outcome',
        allowedAnalysisPurposes: ['prediction'],
      }),
      makeVariable({
        key: 'predictor.raw', provenance: 'raw', predictionRole: 'predictor',
        allowedAnalysisPurposes: ['prediction'],
      }),
    ])).not.toThrow();
  });

  describe('검사 1 — prediction 허용 ⇔ predictionRole 존재', () => {
    it('allowedAnalysisPurposes에 prediction이 있는데 predictionRole이 없으면 거부한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({ key: 'x', allowedAnalysisPurposes: ['prediction'] }),
      ])).toThrow(/predictionRole이 없다/);
    });

    it('predictionRole이 있는데 prediction을 허용하지 않으면 거부한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({ key: 'x', predictionRole: 'predictor', allowedAnalysisPurposes: ['association'] }),
      ])).toThrow(/'prediction'이 없다/);
    });
  });

  describe('검사 2 — predictor는 post_decision이면 안 된다', () => {
    it('predictor의 availableAt이 post_decision이면 거부한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'x', predictionRole: 'predictor', availableAt: 'post_decision',
          allowedAnalysisPurposes: ['prediction'],
        }),
      ])).toThrow(/판정 이전 정보만 predictor로 허용/);
    });

    it('outcome은 post_decision이어도 통과한다(outcome 자체는 재검사 대상이 아님)', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'diagnosis.rollup.anyHighRelatedness', type: 'boolean', predictionRole: 'outcome',
          availableAt: 'post_decision', allowedAnalysisPurposes: ['prediction'],
        }),
      ])).not.toThrow();
    });
  });

  describe('검사 3 — outcome은 boolean/categorical + 명세 필수', () => {
    it('outcome의 type이 continuous면 거부한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({ key: 'x', type: 'continuous', predictionRole: 'outcome', allowedAnalysisPurposes: ['prediction'] }),
      ])).toThrow(/boolean 또는 categorical만 허용/);
    });

    it('boolean/categorical이어도 PREDICTION_OUTCOME_SPECS에 없으면 거부한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({ key: 'not.in.spec', type: 'boolean', predictionRole: 'outcome', allowedAnalysisPurposes: ['prediction'] }),
      ])).toThrow(/PREDICTION_OUTCOME_SPECS 명세가 없다/);
    });

    it('실제 outcome 명세 키(diagnosis.rollup.anyHighRelatedness)는 통과한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'diagnosis.rollup.anyHighRelatedness', type: 'boolean', predictionRole: 'outcome',
          allowedAnalysisPurposes: ['prediction'],
        }),
      ])).not.toThrow();
    });

    it('실제 outcome 명세 키(diagnosis.assessment.status, categorical)는 통과한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'diagnosis.assessment.status', type: 'categorical', predictionRole: 'outcome',
          allowedAnalysisPurposes: ['prediction'],
        }),
      ])).not.toThrow();
    });
  });

  describe('검사 4 — derived predictor는 검토목록 필수', () => {
    it('검토목록에 없는 derived predictor는 거부한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'not.reviewed.derived', provenance: 'derived', predictionRole: 'predictor',
          allowedAnalysisPurposes: ['prediction'],
        }),
      ])).toThrow(/PREDICTION_REVIEWED_DERIVED_PREDICTORS 검토목록에 없다/);
    });

    it('검토목록에 있는 derived predictor(patient.identity.bmi)는 통과한다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'patient.identity.bmi', provenance: 'derived', predictionRole: 'predictor',
          allowedAnalysisPurposes: ['prediction'],
        }),
      ])).not.toThrow();
    });

    it('raw predictor는 derived가 아니므로 검토목록 검사를 받지 않는다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'raw.predictor', provenance: 'raw', predictionRole: 'predictor',
          allowedAnalysisPurposes: ['prediction'],
        }),
      ])).not.toThrow();
    });

    it('clinician_judgment predictor도 검토목록 검사를 받지 않는다', () => {
      expect(() => assertPredictionCatalogInvariants([
        makeVariable({
          key: 'judgment.predictor', provenance: 'clinician_judgment', predictionRole: 'predictor',
          allowedAnalysisPurposes: ['prediction'],
        }),
      ])).not.toThrow();
    });
  });
});

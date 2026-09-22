// PR4-A1 — computeRegressionAvailableMethods 단위테스트 + 리뷰가 잡은 함정
// (Object.keys(METHOD_LABELS) 전수 순회가 회귀 방법을 이변량 목록에 섞는 것)이
// 재발하지 않는지 고정한다.
import { describe, it, expect } from 'vitest';
import { computeAvailableMethods, computeRegressionAvailableMethods } from '../statsMethodCatalog';
import type { PairedDatasetResult, PairedRow } from '../statsBivariateDataset';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';

const METHOD_POLICY_VERSION = 'v2-regression';

function makeVariable(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}

describe('computeRegressionAvailableMethods', () => {
  it('datasetPersonCount===0이면 두 방법 다 INSUFFICIENT_DATA', () => {
    const catalog = new Map([['outcomeVar', makeVariable('outcomeVar', 'continuous')]]);
    const methods = computeRegressionAvailableMethods(0, 'outcomeVar', catalog, METHOD_POLICY_VERSION);
    expect(methods).toHaveLength(2);
    for (const m of methods) {
      expect(m.status).toBe('unsupported');
      expect(m.reasonCode).toBe('INSUFFICIENT_DATA');
    }
  });

  it('outcome 미지정이면 두 방법 다 METHOD_TYPE_MISMATCH', () => {
    const catalog = new Map<string, AnalyticsVariableMetadata>();
    const methods = computeRegressionAvailableMethods(40, null, catalog, METHOD_POLICY_VERSION);
    for (const m of methods) {
      expect(m.status).toBe('unsupported');
      expect(m.reasonCode).toBe('METHOD_TYPE_MISMATCH');
    }
  });

  it('outcome이 continuous면 ols_linear만 available', () => {
    const catalog = new Map([['age', makeVariable('age', 'continuous')]]);
    const methods = computeRegressionAvailableMethods(40, 'age', catalog, METHOD_POLICY_VERSION);
    const ols = methods.find((m) => m.id === 'ols_linear')!;
    const logistic = methods.find((m) => m.id === 'binary_logistic')!;
    expect(ols.status).toBe('available');
    expect(logistic.status).toBe('unsupported');
    expect(logistic.reasonCode).toBe('METHOD_TYPE_MISMATCH');
  });

  it('outcome이 boolean이면 binary_logistic만 available', () => {
    const catalog = new Map([['approved', makeVariable('approved', 'boolean')]]);
    const methods = computeRegressionAvailableMethods(40, 'approved', catalog, METHOD_POLICY_VERSION);
    const ols = methods.find((m) => m.id === 'ols_linear')!;
    const logistic = methods.find((m) => m.id === 'binary_logistic')!;
    expect(ols.status).toBe('unsupported');
    expect(ols.reasonCode).toBe('METHOD_TYPE_MISMATCH');
    expect(logistic.status).toBe('available');
  });

  it('outcome이 categorical이면 binary_logistic만 available(PR4-A2 — 정확히 2레벨인지는 ④에서 데이터로 최종 판정)', () => {
    const catalog = new Map([['group', makeVariable('group', 'categorical')]]);
    const methods = computeRegressionAvailableMethods(40, 'group', catalog, METHOD_POLICY_VERSION);
    const ols = methods.find((m) => m.id === 'ols_linear')!;
    const logistic = methods.find((m) => m.id === 'binary_logistic')!;
    expect(ols.status).toBe('unsupported');
    expect(ols.reasonCode).toBe('METHOD_TYPE_MISMATCH');
    expect(logistic.status).toBe('available');
  });

  it('non_estimable 세부 사유(TOO_MANY_LEVELS 등)를 이 단계에서 노출하지 않는다', () => {
    // A-1 수준 함수라 구조적 사실(0건·타입 불일치)만 판정한다는 계약을 문서화 —
    // 반환되는 reasonCode 전체가 기존 StatsMethodReasonCode 집합(INSUFFICIENT_DATA/
    // METHOD_TYPE_MISMATCH)뿐인지 확인한다.
    const catalog = new Map([['age', makeVariable('age', 'continuous')]]);
    const methods = computeRegressionAvailableMethods(40, 'age', catalog, METHOD_POLICY_VERSION);
    for (const m of methods) {
      if (m.reasonCode !== null) {
        expect(['INSUFFICIENT_DATA', 'METHOD_TYPE_MISMATCH']).toContain(m.reasonCode);
      }
    }
  });
});

describe('회귀 방법이 이변량 availableMethods 목록에 섞이지 않는다 (리뷰 함정 재발 방지)', () => {
  it('computeAvailableMethods 결과에 ols_linear/binary_logistic이 없다', () => {
    const pairs: PairedRow[] = [
      { caseId: 'c1', personClusterKey: 'p1', x: 1.0, y: 2.0 },
      { caseId: 'c2', personClusterKey: 'p2', x: 1.5, y: 2.5 },
    ];
    const paired: PairedDatasetResult = {
      pairs,
      includedCaseCount: 2,
      includedPersonCount: 2,
      excludedCaseCount: 0,
      excludedPersonCount: 0,
      exclusions: [],
    };
    const catalog = new Map([
      ['x', makeVariable('x', 'continuous')],
      ['y', makeVariable('y', 'continuous')],
    ]);
    const methods = computeAvailableMethods('x', 'y', catalog, paired, 'v1-bivariate');
    const ids = methods.map((m) => m.id);
    expect(ids).not.toContain('ols_linear');
    expect(ids).not.toContain('binary_logistic');
    expect(methods).toHaveLength(10); // 기존 이변량 10종 그대로
  });
});

// PR4-A1 — statsRegressionDesign.ts(④) 단위테스트. 계획서(pr4-a-lexical-reddy.md)
// 리뷰 #12(기준 레벨은 관측 레벨과 교집합)·#18(선언 없는 동적 변수 처리)·
// #20(단일 레벨 범주형을 더미 생성 전에 차단)을 실제로 재현·고정한다.
import { describe, it, expect } from 'vitest';
import { buildRegressionDesignMatrix, matrixRank } from '../statsRegressionDesign';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';

function makeVariable(
  key: string,
  type: AnalyticsVariableMetadata['type'],
  label = key,
): AnalyticsVariableMetadata {
  return {
    key, label, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'], sensitivity: 'non_sensitive',
    formulaFamily: 'test_family', supportedFormulaPolicies: ['recompute_current'],
  };
}
function makeRow(caseId: string, personClusterKey: string, values: DatasetRow['values']): DatasetRow {
  return { caseId, personClusterKey, values };
}
function pv<T>(value: T): ExtractedValue<T> {
  return { value, missing: null, qualityFlags: [] };
}

describe('matrixRank — Gram 행렬 기반 rank 계산', () => {
  it('독립 열 2개는 rank 2', () => {
    const x = [[1, 0], [1, 1], [1, 2], [1, 3]];
    expect(matrixRank(x)).toBe(2);
  });
  it('완전 공선(동일 열 복제)은 rank가 줄어든다', () => {
    const x = [[1, 5], [1, 5], [1, 5]];
    expect(matrixRank(x)).toBe(1);
  });
  it('선형종속 열(3번째 열=1번째+2번째)이 있으면 rank가 줄어든다', () => {
    const x = [
      [1, 0, 1],
      [1, 1, 2],
      [1, 2, 3],
      [1, 3, 4],
    ];
    expect(matrixRank(x)).toBe(2);
  });
});

describe('buildRegressionDesignMatrix — OLS 기본', () => {
  it('continuous predictor 1개로 정상 설계행렬을 만든다', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['x1', makeVariable('x1', 'continuous')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 40 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.1), x1: pv(i * 0.5) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['x1'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.design.columns).toHaveLength(2); // intercept + x1
      expect(result.design.x).toHaveLength(40);
      expect(result.design.x[0]).toHaveLength(2);
      expect(result.design.x.every((row) => row[0] === 1)).toBe(true); // 절편 열
    }
  });

  it('outcome이 상수(분산 0)면 CONSTANT_OUTCOME', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['x1', makeVariable('x1', 'continuous')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 10 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(5.0), x1: pv(i) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['x1'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result).toEqual({ ok: false, reason: 'CONSTANT_OUTCOME' });
  });

  it('continuous predictor가 상수(분산 0)면 ZERO_VARIANCE_PREDICTOR', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['x1', makeVariable('x1', 'continuous')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 10 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i), x1: pv(7.0) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['x1'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result).toEqual({ ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' });
  });

  it('boolean predictor가 단일값뿐이면 ZERO_VARIANCE_PREDICTOR', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['flag', makeVariable('flag', 'boolean')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 10 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i), flag: pv(true) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['flag'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result).toEqual({ ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' });
  });
});

describe('buildRegressionDesignMatrix — 리뷰 #20 단일 레벨 범주형(더미 생성 전 차단)', () => {
  it('completeRows에서 레벨이 하나만 남은 categorical predictor는 ZERO_VARIANCE_PREDICTOR로 종료한다', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['group', makeVariable('group', 'categorical')],
    ]);
    // 전부 'A'만 관측(결측 제외 후 한 레벨만 남은 상황을 시뮬레이션)
    const rows: DatasetRow[] = Array.from({ length: 30 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.0), group: pv('A') }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['group'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result).toEqual({ ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' });
  });

  it('레벨이 maxLevels(10)를 넘으면 TOO_MANY_LEVELS', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['group', makeVariable('group', 'categorical')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 55 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.0), group: pv(`L${i % 11}`) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['group'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result).toEqual({ ok: false, reason: 'TOO_MANY_LEVELS' });
  });
});

describe('buildRegressionDesignMatrix — 리뷰 #12/#18 기준 레벨 해석', () => {
  // residualDf = n - parameterCount가 minResidualDf(10) 이상이어야 통과하므로,
  // 이 describe의 모든 픽스처는 레벨 구조를 유지한 채 행 수를 충분히 늘린다
  // (n≈40, 절편+더미 몇 개라도 residualDf 여유가 크게 남도록).
  it('선언 순서(KNEE_KLG_ORDER=[1,2,3,4])가 있는데 완전사례엔 [2,3]만 관측되면 기본 기준은 2다(1이 아님)', () => {
    // getOrdinalOrder('knee.diagnosisSide.klGrade') → KNEE_KLG_ORDER(실제 선언 키).
    // 이 키로 실제 "선언 있음" 경로(declared ∩ observed)를 검증한다 — 인위적으로
    // 만든 키로는 이 경로를 재현할 수 없다(getOrdinalOrder는 고정 키 목록만 인식).
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['knee.diagnosisSide.klGrade', makeVariable('knee.diagnosisSide.klGrade', 'ordinal')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 40 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.0), 'knee.diagnosisSide.klGrade': pv(i % 2 === 0 ? '2' : '3') }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['knee.diagnosisSide.klGrade'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 선언 순서 [1,2,3,4] ∩ 관측 [2,3] = [2,3] → 첫 값 '2'가 기준(선언 첫 값 '1'이 아님).
      expect(result.design.referenceLevelsUsed['knee.diagnosisSide.klGrade']).toBe('2');
      const dummies = result.design.columns.filter((c) => c.variableKey === 'knee.diagnosisSide.klGrade');
      expect(dummies).toHaveLength(1);
      expect(dummies[0].level).toBe('3');
    }
  });

  it('선언 없는 동적 categorical — 관측 레벨만 후보가 되고 결정적으로 정렬된다', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['assignedDoctor', makeVariable('assignedDoctor', 'categorical')],
    ]);
    const levels = ['doctorB', 'doctorA', 'doctorC'];
    const rows: DatasetRow[] = Array.from({ length: 39 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.0), assignedDoctor: pv(levels[i % 3]) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['assignedDoctor'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // sortDeterministic(['doctorB','doctorA','doctorC']) → doctorA가 첫 값(기준)
      expect(result.design.referenceLevelsUsed.assignedDoctor).toBe('doctorA');
      const dummyNames = result.design.columns.filter((c) => c.variableKey === 'assignedDoctor').map((c) => c.level);
      expect(dummyNames.sort()).toEqual(['doctorB', 'doctorC']);
    }
  });

  it('사용자가 관측된 레벨을 기준으로 지정하면(선언 없음) 그대로 쓰인다', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['assignedDoctor', makeVariable('assignedDoctor', 'categorical')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 40 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.0), assignedDoctor: pv(i % 2 === 0 ? 'doctorB' : 'doctorA') }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['assignedDoctor'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: { assignedDoctor: 'doctorB' }, eventSummary: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.design.referenceLevelsUsed.assignedDoctor).toBe('doctorB');
      expect(result.design.qualityFlags).not.toContain('reference_level_fallback');
    }
  });

  it('사용자가 관측되지 않은 레벨을 지정하면(선언 없음) 폴백 + 플래그', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['assignedDoctor', makeVariable('assignedDoctor', 'categorical')],
    ]);
    const rows: DatasetRow[] = Array.from({ length: 40 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.0), assignedDoctor: pv(i % 2 === 0 ? 'doctorB' : 'doctorA') }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['assignedDoctor'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: { assignedDoctor: 'doctorZ_never_observed' }, eventSummary: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.design.referenceLevelsUsed.assignedDoctor).toBe('doctorA'); // sortDeterministic 첫 값
      expect(result.design.qualityFlags).toContain('reference_level_fallback');
    }
  });
});

describe('buildRegressionDesignMatrix — 로지스틱 EPV·파라미터 게이트', () => {
  function boolCatalog() {
    return new Map([
      ['outcome', makeVariable('outcome', 'boolean')],
      ['x1', makeVariable('x1', 'continuous')],
    ]);
  }

  it('EPV(사건 person 최소값 / 파라미터 수) 미달이면 INSUFFICIENT_EVENTS_PER_PARAMETER', () => {
    const catalog = boolCatalog();
    // event 5명, non-event 50명 — min(5,50)/1 = 5 < 10(기본 임계)
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 5; i += 1) rows.push(makeRow(`ce${i}`, `pe${i}`, { outcome: pv(true), x1: pv(i) }));
    for (let i = 0; i < 50; i += 1) rows.push(makeRow(`cn${i}`, `pn${i}`, { outcome: pv(false), x1: pv(i + 100) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'outcome', predictorKeys: ['x1'], catalogByKey: catalog,
      method: 'binary_logistic', referenceLevels: {}, eventSummary: { eventPersonCount: 5, nonEventPersonCount: 50 },
    });
    expect(result).toEqual({ ok: false, reason: 'INSUFFICIENT_EVENTS_PER_PARAMETER' });
  });

  it('EPV가 충분하면 통과한다', () => {
    const catalog = boolCatalog();
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 30; i += 1) rows.push(makeRow(`ce${i}`, `pe${i}`, { outcome: pv(true), x1: pv(i) }));
    for (let i = 0; i < 30; i += 1) rows.push(makeRow(`cn${i}`, `pn${i}`, { outcome: pv(false), x1: pv(i + 100) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'outcome', predictorKeys: ['x1'], catalogByKey: catalog,
      method: 'binary_logistic', referenceLevels: {}, eventSummary: { eventPersonCount: 30, nonEventPersonCount: 30 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.design.eventLevel).toBe('true');
      expect(result.design.method).toBe('binary_logistic');
    }
  });

  it('파라미터 수가 maxParameters(20)를 넘으면 TOO_MANY_PARAMETERS', () => {
    const catalog = new Map<string, AnalyticsVariableMetadata>([['y', makeVariable('y', 'continuous')]]);
    const predictorKeys: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      catalog.set(`x${i}`, makeVariable(`x${i}`, 'continuous'));
      predictorKeys.push(`x${i}`);
    }
    const rows: DatasetRow[] = Array.from({ length: 100 }, (_, i) => {
      const values: DatasetRow['values'] = { y: pv(i * 1.0) };
      for (let j = 0; j < 25; j += 1) values[`x${j}`] = pv(i * (j + 1) * 0.01);
      return makeRow(`c${i}`, `p${i}`, values);
    });
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys, catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result).toEqual({ ok: false, reason: 'TOO_MANY_PARAMETERS' });
  });
});

describe('buildRegressionDesignMatrix — rank deficiency', () => {
  it('predictor 2개가 완전 공선이면 RANK_DEFICIENT', () => {
    const catalog = new Map([
      ['y', makeVariable('y', 'continuous')],
      ['x1', makeVariable('x1', 'continuous')],
      ['x2', makeVariable('x2', 'continuous')],
    ]);
    // x2 = 2*x1 항상 — 완전 공선
    const rows: DatasetRow[] = Array.from({ length: 40 }, (_, i) =>
      makeRow(`c${i}`, `p${i}`, { y: pv(i * 1.0), x1: pv(i), x2: pv(i * 2) }));
    const result = buildRegressionDesignMatrix({
      completeRows: rows, outcomeKey: 'y', predictorKeys: ['x1', 'x2'], catalogByKey: catalog,
      method: 'ols_linear', referenceLevels: {}, eventSummary: null,
    });
    expect(result).toEqual({ ok: false, reason: 'RANK_DEFICIENT' });
  });
});

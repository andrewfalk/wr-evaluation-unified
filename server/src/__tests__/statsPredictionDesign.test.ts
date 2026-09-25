import { describe, it, expect } from 'vitest';
import { buildPredictionDesignMatrix } from '../statsPredictionDesign';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { DatasetRow } from '../statsDatasetBuilder';

// PR4-B2 — 계획서 §3-5단계 "predictor를 full one-hot으로 만든다" + "parameterCount:
// Σ(continuous·boolean 1, categorical/ordinal K−1), 절편 제외" + "columnCount:
// one-hot 열 수"를 고정한다. columnCount(실제 열 수, K개)와 parameterCount(EPV
// 계산용 보수적 값, K-1개)가 서로 다르다는 것이 이 파일의 핵심 계약이다.

function makeVariable(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'raw', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['prediction'], predictionRole: 'predictor', sensitivity: 'non_sensitive',
    formulaFamily: 'test', supportedFormulaPolicies: [],
  };
}

function row(caseId: string, values: Record<string, unknown>): DatasetRow {
  return {
    caseId, personClusterKey: caseId, cohortPersonKey: caseId, entityKey: null,
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, missing: null, qualityFlags: [] }])),
  };
}

describe('buildPredictionDesignMatrix', () => {
  it('continuous/boolean은 열 1개씩, parameterCount에 1씩 더한다', () => {
    const catalog = new Map([
      ['age', makeVariable('age', 'continuous')],
      ['flag', makeVariable('flag', 'boolean')],
    ]);
    const rows = [row('c1', { age: 30, flag: true }), row('c2', { age: 40, flag: false })];
    const design = buildPredictionDesignMatrix(rows, ['age', 'flag'], catalog);
    expect(design.columnCount).toBe(2);
    expect(design.parameterCount).toBe(2);
    expect(design.columns.map((c) => c.name)).toEqual(['age', 'flag']);
    expect(design.x).toEqual([[30, 1], [40, 0]]);
  });

  it('categorical은 관측 레벨 전부를 one-hot 열로 만든다(기준 레벨 없음)', () => {
    const catalog = new Map([['gender', makeVariable('gender', 'categorical')]]);
    const rows = [row('c1', { gender: 'male' }), row('c2', { gender: 'female' }), row('c3', { gender: 'male' })];
    const design = buildPredictionDesignMatrix(rows, ['gender'], catalog);
    // 2개 레벨 → columnCount=2(전부), parameterCount=1(K-1).
    expect(design.columnCount).toBe(2);
    expect(design.parameterCount).toBe(1);
  });

  it('columnCount(전체 one-hot)와 parameterCount(K-1)가 categorical에서 다르다', () => {
    const catalog = new Map([['level', makeVariable('level', 'categorical')]]);
    const rows = [row('c1', { level: 'a' }), row('c2', { level: 'b' }), row('c3', { level: 'c' })];
    const design = buildPredictionDesignMatrix(rows, ['level'], catalog);
    expect(design.columnCount).toBe(3); // a,b,c 전부 열로
    expect(design.parameterCount).toBe(2); // K-1 = 2
    expect(design.columnCount).not.toBe(design.parameterCount);
  });

  it('여러 predictor 조합에서 parameterCount/columnCount를 합산한다', () => {
    const catalog = new Map([
      ['age', makeVariable('age', 'continuous')],
      ['gender', makeVariable('gender', 'categorical')],
    ]);
    const rows = [row('c1', { age: 20, gender: 'a' }), row('c2', { age: 30, gender: 'b' }), row('c3', { age: 40, gender: 'c' })];
    const design = buildPredictionDesignMatrix(rows, ['age', 'gender'], catalog);
    // age: 1열/1param + gender(3레벨): 3열/2param
    expect(design.columnCount).toBe(4);
    expect(design.parameterCount).toBe(3);
  });

  it('선언된 순서(ordinal order)가 있으면 그 순서로 열을 만든다', () => {
    const catalog = new Map([['knee.diagnosisSide.klGrade', makeVariable('knee.diagnosisSide.klGrade', 'ordinal')]]);
    const rows = [row('c1', { 'knee.diagnosisSide.klGrade': '2' }), row('c2', { 'knee.diagnosisSide.klGrade': '1' }), row('c3', { 'knee.diagnosisSide.klGrade': '3' })];
    const design = buildPredictionDesignMatrix(rows, ['knee.diagnosisSide.klGrade'], catalog);
    // KNEE_KLG_ORDER = ['1','2','3','4'] — 관측된 1,2,3만 그 순서대로.
    expect(design.columns.map((c) => c.level)).toEqual(['1', '2', '3']);
  });

  it('N×columnCount 행렬 shape을 만든다', () => {
    const catalog = new Map([['age', makeVariable('age', 'continuous')]]);
    const rows = [row('c1', { age: 1 }), row('c2', { age: 2 }), row('c3', { age: 3 })];
    const design = buildPredictionDesignMatrix(rows, ['age'], catalog);
    expect(design.x.length).toBe(3);
    expect(design.x.every((r) => r.length === design.columnCount)).toBe(true);
  });
});

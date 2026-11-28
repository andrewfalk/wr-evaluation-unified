// 작업대의 레시피 순수 함수(P2-77a에서 statistics/recipeBuild.ts로 꺼냄) — 조건 키·예측 변수 거르기·레시피·완성 판정의 지금 규칙.
import { describe, expect, it } from 'vitest';
import { buildConditionKey, buildRecipe, isRecipeComplete, predictionEffectiveVariableKeys } from '../recipeBuild';
import { KEY, statsCatalog } from '../../../fixtures/statsScreenFixtures';
import type { CatalogVariable } from '@wr/contracts/stats';

const catalogByKey = new Map<string, CatalogVariable>(statsCatalog().variables.map((v) => [v.key, v]));

describe('buildConditionKey', () => {
  const key = (mode: string, vars: string[], extra: Partial<{ outcome: string | null; eventLevel: string; stratify: string | null; method: string | null }> = {}) =>
    JSON.parse(buildConditionKey(
      'case', mode, vars, extra.method ?? null, 'association', {}, [],
      extra.outcome ?? null, true, [[KEY.age, KEY.sex]], [KEY.vibration], extra.eventLevel ?? 'M', extra.stratify ?? null,
    ));

  it('기술통계·상관행렬은 변수를 정렬하고, 이변량·회귀·예측은 선택 순서 그대로', () => {
    const vars = [KEY.vibration, KEY.age];
    expect(key('descriptive', vars).variableKeys).toEqual([KEY.age, KEY.vibration]);
    expect(key('correlation_matrix', vars).variableKeys).toEqual([KEY.age, KEY.vibration]);
    for (const mode of ['bivariate', 'regression', 'prediction']) expect(key(mode, vars).variableKeys, mode).toEqual(vars);
  });

  it('결과변수·사건 레벨은 회귀·예측만, 표준화·상호작용·스플라인은 회귀만, 그룹 변수는 기술통계만', () => {
    const reg = key('regression', [KEY.age], { outcome: KEY.relatedness, stratify: KEY.doctor });
    expect(reg).toMatchObject({ outcomeKey: KEY.relatedness, eventLevel: 'M', standardizePredictors: true, splineKeys: [KEY.vibration], stratifyByKey: null });
    expect(reg.interactionTerms).toEqual([[KEY.age, KEY.sex]]);
    const pred = key('prediction', [KEY.age], { outcome: KEY.outcome });
    expect(pred).toMatchObject({ outcomeKey: KEY.outcome, eventLevel: 'M', standardizePredictors: false, interactionTerms: [], splineKeys: [] });
    const desc = key('descriptive', [KEY.age], { outcome: KEY.outcome, stratify: KEY.doctor, eventLevel: '' });
    expect(desc).toMatchObject({ outcomeKey: null, eventLevel: null, stratifyByKey: KEY.doctor });
  });

  it('방법이 없으면 null로 적는다(방법 미선택에서도 유효한 키 — 미리보기가 나가야 한다)', () => {
    expect(key('bivariate', [KEY.age, KEY.sex]).requestedMethod).toBeNull();
    expect(key('bivariate', [KEY.age, KEY.sex], { method: 'welch_t' }).requestedMethod).toBe('welch_t');
  });
});

describe('predictionEffectiveVariableKeys', () => {
  it('결과변수(outcome 역할)를 맨 앞에, 설명변수는 predictor 역할만', () => {
    expect(predictionEffectiveVariableKeys([KEY.relatedness, KEY.exceeded, KEY.outcome, KEY.age], KEY.outcome, catalogByKey))
      .toEqual([KEY.outcome, KEY.relatedness, KEY.age]);
  });

  it('결과변수가 없거나 outcome 역할이 아니면 설명변수만', () => {
    expect(predictionEffectiveVariableKeys([KEY.relatedness, KEY.outcome], null, catalogByKey)).toEqual([KEY.relatedness]);
    expect(predictionEffectiveVariableKeys([KEY.relatedness, KEY.age], KEY.age, catalogByKey)).toEqual([KEY.relatedness]);
  });
});

describe('buildRecipe', () => {
  const build = (mode: string, vars: string[], outcome: string | null, method: string | null, eventLevel = '', stratify: string | null = null) =>
    buildRecipe('case', mode, vars, method, mode === 'prediction' ? 'prediction' : 'association', {}, [],
      outcome, false, [], [], eventLevel, catalogByKey, stratify);

  it('기술통계: 방법 없음, 그룹 변수가 있을 때만 descriptive', () => {
    expect(build('descriptive', [KEY.age], null, 'welch_t')).toEqual({
      grain: 'case', variableKeys: [KEY.age], filters: [], analysisPurpose: 'association', formulaPolicies: {}, analysisMode: 'descriptive',
    });
    expect(build('descriptive', [KEY.age], null, null, '', KEY.doctor).descriptive).toEqual({ stratifyByKey: KEY.doctor });
  });

  it('회귀: 결과변수가 있을 때만 regression 객체, 사건 레벨은 값이 있을 때만', () => {
    expect(build('regression', [KEY.relatedness, KEY.age], null, 'ols_linear').regression).toBeUndefined();
    expect(build('regression', [KEY.relatedness, KEY.age], KEY.relatedness, 'ols_linear')).toMatchObject({
      requestedMethod: 'ols_linear',
      regression: { outcomeKey: KEY.relatedness, standardizePredictors: false, interactionTerms: [], splineKeys: [] },
    });
    expect(build('regression', [KEY.sex, KEY.age], KEY.sex, 'binary_logistic', 'M').regression?.eventLevel).toBe('M');
  });

  it('예측: 변수는 역할로 거르고, 결과변수·사건 레벨이 둘 다 있을 때만 prediction', () => {
    const r = build('prediction', [KEY.relatedness, KEY.exceeded, KEY.outcome], KEY.outcome, 'l2_logistic', 'true');
    expect(r.variableKeys).toEqual([KEY.outcome, KEY.relatedness]);
    expect(r.prediction).toEqual({ outcomeKey: KEY.outcome, eventLevel: 'true' });
    expect(build('prediction', [KEY.relatedness, KEY.outcome], KEY.outcome, 'l2_logistic', '').prediction).toBeUndefined();
  });
});

describe('isRecipeComplete', () => {
  const complete = (mode: string, vars: string[], extra: Partial<{ outcome: string | null; eventLevel: string; policies: Record<string, string>; stratify: string | null }> = {}) =>
    isRecipeComplete(mode, vars, extra.policies ?? {}, catalogByKey, [], extra.outcome ?? null, extra.eventLevel ?? '', extra.stratify ?? null);

  it('이변량은 서로 다른 변수 정확히 2개, 상관행렬은 서로 다른 3개 이상', () => {
    expect(complete('bivariate', [KEY.age, KEY.sex])).toBe(true);
    expect(complete('bivariate', [KEY.age])).toBe(false);
    expect(complete('bivariate', [KEY.age, KEY.age])).toBe(false);
    expect(complete('correlation_matrix', [KEY.age, KEY.vibration, KEY.relatedness])).toBe(true);
    expect(complete('correlation_matrix', [KEY.age, KEY.vibration, KEY.vibration])).toBe(false);
  });

  it('회귀는 고른 변수 안의 결과변수 + 2개 이상, 예측은 outcome 역할 결과변수·사건 레벨·predictor 1개 이상', () => {
    expect(complete('regression', [KEY.relatedness, KEY.age], { outcome: KEY.relatedness })).toBe(true);
    expect(complete('regression', [KEY.relatedness, KEY.age], { outcome: KEY.sex })).toBe(false);
    expect(complete('prediction', [KEY.outcome, KEY.age], { outcome: KEY.outcome, eventLevel: 'true' })).toBe(true);
    expect(complete('prediction', [KEY.outcome, KEY.age], { outcome: KEY.outcome })).toBe(false);
    expect(complete('prediction', [KEY.outcome, KEY.exceeded], { outcome: KEY.outcome, eventLevel: 'true' })).toBe(false);
  });

  it('기술통계는 1개 이상, 정책이 여럿인 공식 가족은 정책을 골라야 완성(그룹 변수 포함)', () => {
    expect(complete('descriptive', [])).toBe(false);
    expect(complete('descriptive', [KEY.cumulative])).toBe(false);
    expect(complete('descriptive', [KEY.cumulative], { policies: { spine_cumulative: 'recompute_current' } })).toBe(true);
    expect(complete('descriptive', [KEY.age], { stratify: KEY.cumulative })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { planModePurposeTransition, pruneStaleSelections } from '../workbenchTransitions';

function v(key, purposes, extra = {}) {
  return { key, label: `L(${key})`, allowedAnalysisPurposes: purposes, ...extra };
}
const catalogByKey = new Map([
  ['assocOnly', v('assocOnly', ['association'])],
  ['both', v('both', ['association', 'formula_audit'])],
  ['pred', v('pred', ['association', 'prediction'], { predictionRole: 'predictor' })],
  ['out', v('out', ['prediction'], { predictionRole: 'outcome' })],
  ['case.meta.registeredAt', v('case.meta.registeredAt', ['association'])],
]);

function draft(overrides = {}) {
  return {
    analysisMode: 'descriptive', analysisPurpose: 'association', variableKeys: [], outcomeKey: null, eventLevel: '',
    standardizePredictors: false, interactionTerms: [], splineKeys: [], stratifyByKey: null, requestedMethod: null,
    filterDraft: [], appliedFilters: [],
    ...overrides,
  };
}

describe('planModePurposeTransition', () => {
  it('목적을 공식 감사로 바꾸면 비호환 변수만 제거하고 안내를 만든다', () => {
    const { patch, notice } = planModePurposeTransition(
      draft({ variableKeys: ['assocOnly', 'both'] }), 'descriptive', 'formula_audit', catalogByKey,
    );
    expect(patch.variableKeys).toEqual(['both']);
    expect(notice.removedVariables).toEqual(['L(assocOnly)']);
  });

  it('제거할 게 없으면 notice는 null이고 모드·변수가 그대로면 requestedMethod를 유지한다', () => {
    const changed = planModePurposeTransition(
      draft({ analysisMode: 'bivariate', variableKeys: ['both', 'pred'], requestedMethod: 'pearson' }),
      'bivariate', 'formula_audit', catalogByKey,
    );
    // pred는 formula_audit 비허용 → 변수 구성이 바뀌므로 방법 초기화.
    expect(changed.patch.variableKeys).toEqual(['both']);
    expect(changed.patch.requestedMethod).toBeNull();
    const same = planModePurposeTransition(
      draft({ analysisMode: 'bivariate', variableKeys: ['both'], requestedMethod: 'pearson' }),
      'bivariate', 'association', catalogByKey,
    );
    expect(same.notice).toBeNull();
    expect(same.patch.requestedMethod).toBe('pearson');
  });

  it('같은 변수로 회귀→이변량 전환하면 requestedMethod와 결과변수를 초기화한다', () => {
    const { patch } = planModePurposeTransition(
      draft({ analysisMode: 'regression', variableKeys: ['both', 'pred'], outcomeKey: 'both', requestedMethod: 'binary_logistic' }),
      'bivariate', 'association', catalogByKey,
    );
    expect(patch.requestedMethod).toBeNull();
    expect(patch.outcomeKey).toBeNull();
  });

  it('예측으로 들어가면 항상 l2_logistic이고, 목적 메뉴 경로(모드 불변)에서도 덮어쓰이지 않는다', () => {
    const toPred = planModePurposeTransition(draft({ variableKeys: ['pred'] }), 'prediction', 'prediction', catalogByKey);
    expect(toPred.patch.requestedMethod).toBe('l2_logistic');
    // 연관성 전용 변수는 예측 목적에서 제거된다.
    const withAssoc = planModePurposeTransition(draft({ variableKeys: ['assocOnly', 'pred'] }), 'prediction', 'prediction', catalogByKey);
    expect(withAssoc.patch.variableKeys).toEqual(['pred']);
    expect(withAssoc.patch.requestedMethod).toBe('l2_logistic');
    const stay = planModePurposeTransition(
      draft({ analysisMode: 'prediction', analysisPurpose: 'prediction', variableKeys: ['pred'], requestedMethod: 'l2_logistic' }),
      'prediction', 'prediction', catalogByKey,
    );
    expect(stay.patch.requestedMethod).toBe('l2_logistic');
  });

  it('같은 모드에서 결과변수가 비호환이 되면 outcome과 eventLevel을 함께 비우고 연결된 옵션도 정리한다', () => {
    const { patch } = planModePurposeTransition(
      draft({
        analysisMode: 'regression', variableKeys: ['assocOnly', 'both'], outcomeKey: 'assocOnly', eventLevel: 'yes',
        interactionTerms: [['assocOnly', 'both']], splineKeys: ['assocOnly'],
      }),
      'regression', 'formula_audit', catalogByKey,
    );
    expect(patch.outcomeKey).toBeNull();
    expect(patch.eventLevel).toBe('');
    expect(patch.interactionTerms).toEqual([]);
    expect(patch.splineKeys).toEqual([]);
  });

  it('비호환 그룹 변수(stratifyByKey)도 정리한다', () => {
    const { patch, notice } = planModePurposeTransition(
      draft({ variableKeys: ['both'], stratifyByKey: 'assocOnly' }), 'descriptive', 'formula_audit', catalogByKey,
    );
    expect(patch.stratifyByKey).toBeNull();
    expect(notice.removedVariables).toEqual(['L(assocOnly)']);
  });

  it('예측 진입 시 허용되지 않는 필터만 제거하고(허용 필터·등록일은 유지) 안내에 담는다', () => {
    const bad = { key: 'both', operator: 'gt', value: 1 };
    const goodPred = { key: 'pred', operator: 'gt', value: 1 };
    const reg = { key: 'case.meta.registeredAt', operator: 'gt', value: '2024-01-01' };
    const { patch, notice } = planModePurposeTransition(
      draft({ filterDraft: [bad, goodPred, reg], appliedFilters: [bad] }), 'prediction', 'prediction', catalogByKey,
    );
    expect(patch.filterDraft).toEqual([goodPred, reg]);
    expect(patch.appliedFilters).toEqual([]);
    expect(notice.removedFilters).toEqual([bad]); // appliedFilters와 중복돼도 한 번만
  });

  it('예측에서 나올 때는 필터를 복원·삭제하지 않고 안내는 새 계산 결과(null)로 대체된다', () => {
    const f = { key: 'both', operator: 'gt', value: 1 };
    const { patch, notice } = planModePurposeTransition(
      draft({ analysisMode: 'prediction', analysisPurpose: 'prediction', filterDraft: [f], appliedFilters: [f], requestedMethod: 'l2_logistic' }),
      'bivariate', 'association', catalogByKey,
    );
    expect(patch.filterDraft).toEqual([f]);
    expect(notice).toBeNull();
    expect(patch.requestedMethod).toBeNull();
  });
});

describe('pruneStaleSelections', () => {
  it('새 카탈로그에 없는 키만 정리하고 나머지는 보존한다(구 키를 새 키로 바꾸지 않는다)', () => {
    const f = { key: 'both', operator: 'gt', value: 1 };
    const stale = { key: 'old.key', operator: 'gt', value: 1 };
    const res = pruneStaleSelections(
      draft({
        analysisMode: 'regression', variableKeys: ['old.key', 'both', 'pred'], outcomeKey: 'old.key', eventLevel: 'x',
        interactionTerms: [['old.key', 'both'], ['both', 'pred']], splineKeys: ['old.key', 'pred'], stratifyByKey: 'old.key',
        filterDraft: [stale, f], appliedFilters: [stale], requestedMethod: 'ols',
      }),
      catalogByKey,
    );
    expect(res.removed).toEqual(['old.key']);
    expect(res.patch.variableKeys).toEqual(['both', 'pred']);
    expect(res.patch.outcomeKey).toBeNull();
    expect(res.patch.eventLevel).toBe('');
    expect(res.patch.interactionTerms).toEqual([['both', 'pred']]);
    expect(res.patch.splineKeys).toEqual(['pred']);
    expect(res.patch.stratifyByKey).toBeNull();
    expect(res.patch.filterDraft).toEqual([f]);
    expect(res.patch.appliedFilters).toEqual([]);
    expect(res.patch.requestedMethod).toBeNull();
  });

  it('정리할 게 없으면 null', () => {
    expect(pruneStaleSelections(draft({ variableKeys: ['both'] }), catalogByKey)).toBeNull();
  });
});

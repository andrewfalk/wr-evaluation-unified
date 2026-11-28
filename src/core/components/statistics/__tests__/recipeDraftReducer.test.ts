// 레시피 초안 reducer(P2-77b) — 옛 작업대 핸들러의 지금 동작을 사례로 못 박는다(계획 K8b ①~④)와 순수성.
import { describe, expect, it } from 'vitest';
import {
  createInitialRecipeDraft,
  planModePurposeTransition,
  pruneStaleSelections,
  recipeDraftReducer,
} from '../workbenchTransitions';
import type { RecipeDraftAction, RecipeDraftState } from '../workbenchTransitions';
import { KEY, statsCatalog } from '../../../fixtures/statsScreenFixtures';
import type { CatalogVariable } from '@wr/contracts/stats';

const catalogByKey = new Map<string, CatalogVariable>(statsCatalog().variables.map((v) => [v.key, v]));

function draft(overrides: Partial<RecipeDraftState> = {}): RecipeDraftState {
  return { ...createInitialRecipeDraft(), ...overrides };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Map)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('recipeDraftReducer — ① 변수 토글', () => {
  it('이변량 상한(2개)에서 세 번째를 눌러도 변수는 그대로이고 requestedMethod는 초기화된다', () => {
    const before = draft({ analysisMode: 'bivariate', variableKeys: [KEY.relatedness, KEY.exceeded], requestedMethod: 'welch_t' });
    const after = recipeDraftReducer(before, { type: 'toggleVariable', key: KEY.vibration });
    expect(after.variableKeys).toEqual([KEY.relatedness, KEY.exceeded]);
    expect(after.requestedMethod).toBeNull();
    expect(after).not.toBe(before); // "변화 없으면 state 그대로"로 줄이지 않는다
  });

  it('예측 모드는 방법을 l2_logistic으로 둔다, 해제는 목록에서 뺀다', () => {
    const after = recipeDraftReducer(
      draft({ analysisMode: 'prediction', variableKeys: [KEY.outcome, KEY.age], requestedMethod: 'l2_logistic' }),
      { type: 'toggleVariable', key: KEY.age },
    );
    expect(after.variableKeys).toEqual([KEY.outcome]);
    expect(after.requestedMethod).toBe('l2_logistic');
  });

  it('해제된 변수가 쓰이던 interaction·spline·그룹 변수를 함께 정리한다', () => {
    const after = recipeDraftReducer(
      draft({ variableKeys: [KEY.age, KEY.sex, KEY.vibration], interactionTerms: [[KEY.age, KEY.sex]], splineKeys: [KEY.vibration], stratifyByKey: KEY.sex }),
      { type: 'toggleVariable', key: KEY.sex },
    );
    expect(after).toMatchObject({ variableKeys: [KEY.age, KEY.vibration], interactionTerms: [], splineKeys: [KEY.vibration], stratifyByKey: null });
  });
});

describe('recipeDraftReducer — ② eventLevel은 그 액션 직전의 outcomeKey로 판정', () => {
  it('결과변수를 해제하면 결과변수와 사건 레벨을 함께 비운다', () => {
    const after = recipeDraftReducer(
      draft({ analysisMode: 'regression', variableKeys: [KEY.sex, KEY.age], outcomeKey: KEY.sex, eventLevel: 'M' }),
      { type: 'toggleVariable', key: KEY.sex },
    );
    expect(after).toMatchObject({ outcomeKey: null, eventLevel: '' });
  });

  it('결과변수가 아닌 변수를 토글하면 사건 레벨은 그대로', () => {
    const after = recipeDraftReducer(
      draft({ analysisMode: 'regression', variableKeys: [KEY.sex, KEY.age], outcomeKey: KEY.sex, eventLevel: 'M' }),
      { type: 'toggleVariable', key: KEY.age },
    );
    expect(after).toMatchObject({ outcomeKey: KEY.sex, eventLevel: 'M' });
  });
});

describe('recipeDraftReducer — ③ grain 변경', () => {
  const full = () => draft({
    grain: 'case', variableKeys: [KEY.age], filterDraft: [{ key: KEY.age, operator: 'gte', value: 20 }],
    appliedFilters: [{ key: KEY.age, operator: 'gte', value: 20 }], analysisMode: 'regression', requestedMethod: 'ols_linear',
    outcomeKey: KEY.age, standardizePredictors: true, interactionTerms: [[KEY.age, KEY.sex]], splineKeys: [KEY.age],
    eventLevel: 'M', stratifyByKey: KEY.doctor, formulaPolicies: { spine_cumulative: 'recompute_current' }, analysisPurpose: 'formula_audit',
  });

  it('formulaPolicies·모드·목적은 건드리지 않고 나머지 선택을 비운다', () => {
    const after = recipeDraftReducer(full(), { type: 'changeGrain', grain: 'job' });
    expect(after).toEqual({
      ...full(), grain: 'job', variableKeys: [], filterDraft: [], appliedFilters: [], requestedMethod: null, outcomeKey: null,
      standardizePredictors: false, interactionTerms: [], splineKeys: [], eventLevel: '', stratifyByKey: null,
    });
  });

  it('같은 grain이면 state를 그대로 돌려준다, 예측 모드는 l2_logistic을 둔다', () => {
    const before = full();
    expect(recipeDraftReducer(before, { type: 'changeGrain', grain: 'case' })).toBe(before);
    expect(recipeDraftReducer(draft({ analysisMode: 'prediction', requestedMethod: 'l2_logistic' }), { type: 'changeGrain', grain: 'disease' }).requestedMethod)
      .toBe('l2_logistic');
  });
});

describe('recipeDraftReducer — ④ catalogByKey를 실어 보내는 액션', () => {
  it('결과변수 변경: 예측의 boolean 결과변수면 사건 레벨 true, 회귀면 비운다, 새 결과변수를 쓰던 interaction·spline 정리', () => {
    const pred = recipeDraftReducer(draft({ analysisMode: 'prediction', eventLevel: 'x' }), { type: 'changeOutcomeKey', outcomeKey: KEY.outcome, catalogByKey });
    expect(pred).toMatchObject({ outcomeKey: KEY.outcome, eventLevel: 'true' });
    const reg = recipeDraftReducer(
      draft({ analysisMode: 'regression', eventLevel: 'M', interactionTerms: [[KEY.age, KEY.sex]], splineKeys: [KEY.age, KEY.vibration] }),
      { type: 'changeOutcomeKey', outcomeKey: KEY.age, catalogByKey },
    );
    expect(reg).toMatchObject({ outcomeKey: KEY.age, eventLevel: '', interactionTerms: [], splineKeys: [KEY.vibration] });
  });

  it('모드·목적 전환은 planModePurposeTransition의 patch와 같다', () => {
    const before = draft({ variableKeys: [KEY.relatedness, KEY.job], requestedMethod: 'welch_t', filterDraft: [{ key: KEY.grade, operator: 'in', value: ['a'] }] });
    const after = recipeDraftReducer(before, { type: 'transition', nextMode: 'prediction', nextPurpose: 'prediction', catalogByKey });
    expect(after).toEqual({ ...before, ...planModePurposeTransition(before, 'prediction', 'prediction', catalogByKey).patch });
    expect(after.variableKeys).toEqual([KEY.relatedness]);
    expect(after.filterDraft).toEqual([]);
  });

  it('카탈로그 정리는 pruneStaleSelections의 patch를 적용하고, 지울 것이 없으면 state 그대로', () => {
    const before = draft({ variableKeys: [KEY.age, 'removed.variable'], requestedMethod: 'welch_t' });
    const after = recipeDraftReducer(before, { type: 'pruneCatalog', catalogByKey });
    expect(after).toEqual({ ...before, ...pruneStaleSelections(before, catalogByKey)?.patch });
    expect(after.variableKeys).toEqual([KEY.age]);
    const clean = draft({ variableKeys: [KEY.age] });
    expect(recipeDraftReducer(clean, { type: 'pruneCatalog', catalogByKey })).toBe(clean);
  });
});

describe('recipeDraftReducer — set(옛 useState setter)', () => {
  it('값과 갱신 함수를 둘 다 받고, 같은 값이면 state 그대로', () => {
    const before = draft({ formulaPolicies: { a: 'x' } });
    const byValue = recipeDraftReducer(before, { type: 'set', field: 'eventLevel', value: 'M' });
    expect(byValue.eventLevel).toBe('M');
    const byUpdater = recipeDraftReducer(before, { type: 'set', field: 'formulaPolicies', value: (prev) => ({ ...prev, b: 'y' }) });
    expect(byUpdater.formulaPolicies).toEqual({ a: 'x', b: 'y' });
    expect(recipeDraftReducer(before, { type: 'set', field: 'eventLevel', value: '' })).toBe(before);
  });
});

describe('recipeDraftReducer — 순수성(StrictMode에서 두 번 불린다)', () => {
  it('같은 입력을 두 번 주면 같은 결과이고, 입력을 바꾸지 않는다', () => {
    const actions: RecipeDraftAction[] = [
      { type: 'toggleVariable', key: KEY.vibration },
      { type: 'changeGrain', grain: 'job' },
      { type: 'changeOutcomeKey', outcomeKey: KEY.outcome, catalogByKey },
      { type: 'transition', nextMode: 'correlation_matrix', nextPurpose: 'association', catalogByKey },
      { type: 'pruneCatalog', catalogByKey },
      { type: 'set', field: 'interactionTerms', value: (prev) => [...prev, [KEY.age, KEY.vibration]] },
    ];
    for (const action of actions) {
      const before = deepFreeze(draft({
        analysisMode: 'bivariate', variableKeys: [KEY.relatedness, 'stale.key'], requestedMethod: 'welch_t',
        interactionTerms: [[KEY.age, KEY.sex]], splineKeys: [KEY.age], outcomeKey: KEY.age, eventLevel: 'M',
      }));
      const snapshot = JSON.stringify(before);
      const a = recipeDraftReducer(before, action);
      const b = recipeDraftReducer(before, action);
      expect(a, action.type).toEqual(b);
      expect(JSON.stringify(before), action.type).toBe(snapshot);
    }
  });
});

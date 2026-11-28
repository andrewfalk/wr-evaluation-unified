// @vitest-environment jsdom
// 레시피 초안 훅(P2-77b) — 패널에 그대로 내려가는 setter가 옛 useState setter처럼 렌더마다 같은 참조이고 값·갱신 함수를 둘 다 받는지(계획 K8b ⑥).
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRecipeDraft } from '../useRecipeDraft';

describe('useRecipeDraft', () => {
  it('setter는 렌더가 바뀌어도 같은 참조이고, 값과 갱신 함수를 둘 다 받는다', () => {
    const { result, rerender } = renderHook(() => useRecipeDraft());
    const first = result.current;
    act(() => { first.setEventLevel('M'); });
    act(() => { first.setInteractionTerms((prev) => [...prev, ['a', 'b']]); });
    act(() => { first.setFormulaPolicies((prev) => ({ ...prev, f: 'recompute_current' })); });
    rerender();
    const now = result.current;
    expect(now.draft.eventLevel).toBe('M');
    expect(now.draft.interactionTerms).toEqual([['a', 'b']]);
    expect(now.draft.formulaPolicies).toEqual({ f: 'recompute_current' });
    for (const name of [
      'setRequestedMethod', 'setStandardizePredictors', 'setInteractionTerms', 'setSplineKeys', 'setEventLevel',
      'setStratifyByKey', 'setFilterDraft', 'setAppliedFilters', 'setFormulaPolicies',
    ] as const) {
      expect(now[name], name).toBe(first[name]);
    }
    expect(now.dispatchDraft).toBe(first.dispatchDraft);
  });
});

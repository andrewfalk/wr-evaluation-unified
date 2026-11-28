// 작업대의 레시피 초안 상태 훅(P2-77b) — 옛 useState 14개를 workbenchTransitions.ts의 순수 reducer 하나로 둔다.
// 패널(RecipePanel)에 그대로 내려가는 setter는 옛 useState setter처럼 값·갱신 함수를 둘 다 받고 참조가 렌더마다 같다(⑥).
import { useMemo, useReducer } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createInitialRecipeDraft, recipeDraftReducer } from './workbenchTransitions';
import type { RecipeDraftAction, RecipeDraftField, RecipeDraftState } from './workbenchTransitions';

type FieldSetter<K extends RecipeDraftField> = Dispatch<SetStateAction<RecipeDraftState[K]>>;

export interface RecipeDraftSetters {
  setRequestedMethod: FieldSetter<'requestedMethod'>;
  setStandardizePredictors: FieldSetter<'standardizePredictors'>;
  setInteractionTerms: FieldSetter<'interactionTerms'>;
  setSplineKeys: FieldSetter<'splineKeys'>;
  setEventLevel: FieldSetter<'eventLevel'>;
  setStratifyByKey: FieldSetter<'stratifyByKey'>;
  setFilterDraft: FieldSetter<'filterDraft'>;
  setAppliedFilters: FieldSetter<'appliedFilters'>;
  setFormulaPolicies: FieldSetter<'formulaPolicies'>;
}

export interface RecipeDraftApi extends RecipeDraftSetters {
  draft: RecipeDraftState;
  dispatchDraft: Dispatch<RecipeDraftAction>;
}

export function useRecipeDraft(): RecipeDraftApi {
  const [draft, dispatchDraft] = useReducer(recipeDraftReducer, undefined, createInitialRecipeDraft);
  // dispatch는 참조가 바뀌지 않으므로 setter도 마운트 동안 한 번만 만든다.
  const setters = useMemo<RecipeDraftSetters>(() => {
    function fieldSetter<K extends RecipeDraftField>(field: K): FieldSetter<K> {
      return (value) => dispatchDraft({ type: 'set', field, value } as RecipeDraftAction);
    }
    return {
      setRequestedMethod: fieldSetter('requestedMethod'),
      setStandardizePredictors: fieldSetter('standardizePredictors'),
      setInteractionTerms: fieldSetter('interactionTerms'),
      setSplineKeys: fieldSetter('splineKeys'),
      setEventLevel: fieldSetter('eventLevel'),
      setStratifyByKey: fieldSetter('stratifyByKey'),
      setFilterDraft: fieldSetter('filterDraft'),
      setAppliedFilters: fieldSetter('appliedFilters'),
      setFormulaPolicies: fieldSetter('formulaPolicies'),
    };
  }, []);
  return { draft, dispatchDraft, ...setters };
}

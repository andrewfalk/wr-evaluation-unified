import { isPurposeCompatible } from '@wr/analytics-core/common';
import type { CatalogVariable, StatsFilter } from '@wr/contracts/stats';

type CatalogByKey = Map<string, CatalogVariable>;

/** 작업대의 레시피 초안 — 모드·목적 전환과 카탈로그 정리가 읽고 다음 값을 돌려주는 필드. */
export interface RecipeDraft {
  analysisMode: string;
  analysisPurpose: string;
  variableKeys: string[];
  outcomeKey: string | null;
  eventLevel: string;
  standardizePredictors: boolean;
  interactionTerms: Array<[string, string]>;
  splineKeys: string[];
  stratifyByKey: string | null;
  requestedMethod: string | null;
  filterDraft: StatsFilter[];
  appliedFilters: StatsFilter[];
}

/** 전환으로 정리된 내역(사용자 안내용). */
export interface TransitionNotice {
  removedVariables: string[];
  removedFilters: StatsFilter[];
}

export interface TransitionPlan {
  patch: RecipeDraft;
  notice: TransitionNotice | null;
}

export interface PrunePlan {
  patch: Partial<RecipeDraft>;
  removed: string[];
}

// 예측 필터 화이트리스트의 등록일 키 — RecipePanel(필터 후보)과 이 파일(전환 시 정리)이 같이 쓴다.
export const PREDICTION_REGISTERED_AT_KEY = 'case.meta.registeredAt';

/** 예측 모드에서 허용되는 필터인가 — predictor 역할이거나 등록일만(서버 PREDICTION_FILTER_LEAKAGE). */
export function isPredictionFilterAllowed(filter: StatsFilter, catalogByKey: CatalogByKey): boolean {
  const v = catalogByKey.get(filter.key);
  return v?.predictionRole === 'predictor' || filter.key === PREDICTION_REGISTERED_AT_KEY;
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * 분석 모드·분석 목적이 바뀔 때의 초안 상태 정리(순수 계산 — 호출 직전의 state를 `prev`로 받고
 * 전환 후 모드/목적은 인자로 받는다. setAnalysisMode() 직후의 stale state를 읽지 않는다).
 *
 * - 새 목적에서 쓸 수 없는 분석 변수·결과변수·그룹 변수·interaction·spline을 제거한다.
 * - 모드가 바뀌면 결과변수·고급 옵션·그룹 변수를 초기화한다(기존 handleAnalysisModeChange 동작).
 * - requestedMethod: 예측은 항상 l2_logistic(선택 UI 없음), 그 외는 모드나 변수 구성이 바뀌면 null,
 *   둘 다 그대로면 유지.
 * - 예측 모드로 들어가면 허용되지 않는 필터(filterDraft·appliedFilters)를 제거한다.
 *   예측에서 나올 때 제거된 필터는 복원하지 않는다.
 *
 * 반환: { patch, notice } — patch는 각 state의 다음 값, notice는 사용자에게 알릴 제거 내역
 * ({ removedVariables:[label], removedFilters:[filter] }) 또는 null.
 */
export function planModePurposeTransition(prev: RecipeDraft, nextMode: string, nextPurpose: string, catalogByKey: CatalogByKey): TransitionPlan {
  const modeChanged = nextMode !== prev.analysisMode;
  const incompatible = (key: string) => {
    const v = catalogByKey.get(key);
    return !!v && !isPurposeCompatible(v, nextPurpose);
  };

  const variableKeys = prev.variableKeys.filter((k) => !incompatible(k));
  const removedKeys = prev.variableKeys.filter((k) => incompatible(k));
  const removedSet = new Set(removedKeys);
  const variablesChanged = !sameKeys(variableKeys, prev.variableKeys);

  let outcomeKey = prev.outcomeKey;
  let eventLevel = prev.eventLevel;
  let standardizePredictors = prev.standardizePredictors;
  let interactionTerms = prev.interactionTerms.filter(([a, b]) => !removedSet.has(a) && !removedSet.has(b));
  let splineKeys = prev.splineKeys.filter((k) => !removedSet.has(k));
  let stratifyByKey = prev.stratifyByKey;
  if (modeChanged) {
    outcomeKey = null;
    eventLevel = '';
    standardizePredictors = false;
    interactionTerms = [];
    splineKeys = [];
    stratifyByKey = null;
  } else {
    if (outcomeKey != null && removedSet.has(outcomeKey)) { outcomeKey = null; eventLevel = ''; }
    if (stratifyByKey != null && incompatible(stratifyByKey)) {
      removedKeys.push(stratifyByKey);
      stratifyByKey = null;
    }
  }

  let requestedMethod: string | null;
  if (nextMode === 'prediction') requestedMethod = 'l2_logistic';
  else if (modeChanged || variablesChanged) requestedMethod = null;
  else requestedMethod = prev.requestedMethod;

  let filterDraft = prev.filterDraft;
  let appliedFilters = prev.appliedFilters;
  const removedFilters: StatsFilter[] = [];
  if (nextMode === 'prediction') {
    const keep = (f: StatsFilter) => isPredictionFilterAllowed(f, catalogByKey);
    for (const f of prev.filterDraft) if (!keep(f)) removedFilters.push(f);
    // appliedFilters에만 있는 필터도 제거하되 안내는 중복 없이 한 번만.
    for (const f of prev.appliedFilters) {
      if (!keep(f) && !removedFilters.some((r) => JSON.stringify(r) === JSON.stringify(f))) removedFilters.push(f);
    }
    filterDraft = prev.filterDraft.filter(keep);
    appliedFilters = prev.appliedFilters.filter(keep);
  }

  const removedVariables = removedKeys.map((k) => catalogByKey.get(k)?.label || k);
  const notice = removedVariables.length > 0 || removedFilters.length > 0
    ? { removedVariables, removedFilters }
    : null;

  return {
    patch: {
      analysisMode: nextMode,
      analysisPurpose: nextPurpose,
      variableKeys,
      outcomeKey,
      eventLevel,
      standardizePredictors,
      interactionTerms,
      splineKeys,
      stratifyByKey,
      requestedMethod,
      filterDraft,
      appliedFilters,
    },
    notice,
  };
}

/**
 * 카탈로그 재조회가 성공한 뒤, 새 카탈로그에 없는 키를 초안에서 제거한다(순수 계산).
 * 호출부는 `status === 'ready'`일 때만 호출해야 한다 — 로딩·실패 중 catalogByKey는 빈 맵이라
 * 그대로 호출하면 정상 변수·필터가 전부 지워진다. 구 키를 새 키로 치환하지 않는다.
 * 반환: { patch, removed } — 바뀐 게 없으면 null.
 */
export function pruneStaleSelections(prev: RecipeDraft, catalogByKey: ReadonlyMap<string, unknown>): PrunePlan | null {
  const stale = (key: string) => !catalogByKey.has(key);
  const removedKeys: string[] = [];
  const note = (k: string) => { if (!removedKeys.includes(k)) removedKeys.push(k); };

  const variableKeys = prev.variableKeys.filter((k) => { if (stale(k)) { note(k); return false; } return true; });
  const interactionTerms = prev.interactionTerms.filter(([a, b]) => {
    if (stale(a) || stale(b) || !variableKeys.includes(a) || !variableKeys.includes(b)) return false;
    return true;
  });
  const splineKeys = prev.splineKeys.filter((k) => variableKeys.includes(k));
  let outcomeKey = prev.outcomeKey;
  let eventLevel = prev.eventLevel;
  if (outcomeKey != null && !variableKeys.includes(outcomeKey)) { outcomeKey = null; eventLevel = ''; }
  let stratifyByKey = prev.stratifyByKey;
  if (stratifyByKey != null && stale(stratifyByKey)) { note(stratifyByKey); stratifyByKey = null; }
  const filterDraft = prev.filterDraft.filter((f) => { if (stale(f.key)) { note(f.key); return false; } return true; });
  const appliedFilters = prev.appliedFilters.filter((f) => { if (stale(f.key)) { note(f.key); return false; } return true; });

  if (removedKeys.length === 0) return null;
  return {
    patch: {
      variableKeys, interactionTerms, splineKeys, outcomeKey, eventLevel, stratifyByKey, filterDraft, appliedFilters,
      // 변수 구성이 바뀌었으므로 이전 방법은 무효 — 예측은 l2_logistic 하나뿐이라 유지한다.
      ...(sameKeys(variableKeys, prev.variableKeys)
        ? {}
        : { requestedMethod: prev.analysisMode === 'prediction' ? 'l2_logistic' : null }),
    },
    removed: removedKeys,
  };
}

// ---- 레시피 초안 reducer(P2-77b) ----
// 작업대의 레시피 초안 14개 상태(옛 useState)를 한 reducer로 둔다. 순수 함수다(StrictMode에서 두 번 불려도 같은 결과).
// 옛 핸들러의 지금 동작을 그대로 옮긴다:
//  ① toggleVariable — 변수 상한에 걸려 변수가 늘지 않아도 requestedMethod는 초기화한다(조건 키가 바뀌어 미리보기가 한 번 더 나간다).
//  ② toggleVariable의 eventLevel 판정은 그 액션 직전의 outcomeKey로 한다.
//  ③ changeGrain은 formulaPolicies와 (reducer 밖의) 안내 상태를 건드리지 않는다. 같은 grain이면 아무것도 바꾸지 않는다.
//  ④ catalogByKey가 필요한 액션(목적·모드 전환 · 결과변수 변경 · 카탈로그 정리)은 액션에 실어 받는다.
//  ⑤ 전환의 notice와 정리의 removed는 이 reducer가 다루지 않는다 — 호출부가 같은 순수 함수로 계산해 알림 상태를 정한다.
//  'set'은 옛 useState setter처럼 값이나 갱신 함수를 받고, 결과가 지금 값과 같으면(Object.is) state를 그대로 돌려준다.

/** 레시피 초안 전체(전환 함수가 다루는 12필드 + grain · formulaPolicies). */
export interface RecipeDraftState extends RecipeDraft {
  grain: string;
  formulaPolicies: Record<string, string>;
}

export type RecipeDraftField = keyof RecipeDraftState;

export type RecipeDraftAction =
  | { [K in RecipeDraftField]: { type: 'set'; field: K; value: RecipeDraftState[K] | ((prev: RecipeDraftState[K]) => RecipeDraftState[K]) } }[RecipeDraftField]
  | { type: 'changeGrain'; grain: string }
  | { type: 'toggleVariable'; key: string }
  | { type: 'changeOutcomeKey'; outcomeKey: string | null; catalogByKey: CatalogByKey }
  | { type: 'transition'; nextMode: string; nextPurpose: string; catalogByKey: CatalogByKey }
  | { type: 'pruneCatalog'; catalogByKey: ReadonlyMap<string, unknown> };

/** 옛 useState 초기값과 같다(마운트마다 새 배열·객체). */
export function createInitialRecipeDraft(): RecipeDraftState {
  return {
    grain: 'case',
    variableKeys: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    filterDraft: [],
    appliedFilters: [],
    analysisMode: 'descriptive',
    requestedMethod: null,
    outcomeKey: null,
    standardizePredictors: false,
    interactionTerms: [],
    splineKeys: [],
    eventLevel: '',
    stratifyByKey: null,
  };
}

export function recipeDraftReducer(state: RecipeDraftState, action: RecipeDraftAction): RecipeDraftState {
  switch (action.type) {
    case 'set': {
      const prev = state[action.field];
      const next = typeof action.value === 'function'
        ? (action.value as (p: typeof prev) => typeof prev)(prev)
        : action.value;
      if (Object.is(next, prev)) return state;
      return { ...state, [action.field]: next };
    }
    case 'changeGrain': {
      // 옛 handleGrainChange — 같은 grain이면 아무것도 하지 않는다. formulaPolicies는 그대로(③).
      if (action.grain === state.grain) return state;
      return {
        ...state,
        grain: action.grain,
        variableKeys: [],
        filterDraft: [],
        appliedFilters: [],
        // 예측은 l2_logistic 하나뿐이라(선택 UI 없음) 현재 모드가 prediction이면 그대로 둔다.
        requestedMethod: state.analysisMode === 'prediction' ? 'l2_logistic' : null,
        outcomeKey: null,
        standardizePredictors: false,
        interactionTerms: [],
        splineKeys: [],
        eventLevel: '',
        stratifyByKey: null,
      };
    }
    case 'toggleVariable': {
      // 옛 toggleVariable — 변수 목록이 그대로여도(상한) 나머지는 아래대로 다시 정한다(①).
      const { key } = action;
      let variableKeys: string[];
      if (state.variableKeys.includes(key)) variableKeys = state.variableKeys.filter((k) => k !== key);
      else {
        const cap = state.analysisMode === 'bivariate' ? 2 : 20; // 서버 상한(§ recipe 계약) — 조용히 무시
        variableKeys = state.variableKeys.length >= cap ? state.variableKeys : [...state.variableKeys, key];
      }
      return {
        ...state,
        variableKeys,
        requestedMethod: state.analysisMode === 'prediction' ? 'l2_logistic' : null,
        outcomeKey: state.outcomeKey === key ? null : state.outcomeKey,
        interactionTerms: state.interactionTerms.filter(([a, b]) => a !== key && b !== key),
        splineKeys: state.splineKeys.filter((k) => k !== key),
        // ② 이 액션 직전의 outcomeKey로 판정한다.
        eventLevel: key === state.outcomeKey ? '' : state.eventLevel,
        stratifyByKey: state.stratifyByKey === key ? null : state.stratifyByKey,
      };
    }
    case 'changeOutcomeKey': {
      // 옛 handleOutcomeKeyChange — 새 결과변수를 참조하는 interaction·spline만 정리하고 eventLevel은 다시 정한다.
      const next = action.outcomeKey;
      const nextVariable = action.catalogByKey.get(next as string);
      return {
        ...state,
        outcomeKey: next,
        interactionTerms: state.interactionTerms.filter(([a, b]) => a !== next && b !== next),
        splineKeys: state.splineKeys.filter((k) => k !== next),
        eventLevel: state.analysisMode === 'prediction' && nextVariable?.type === 'boolean' ? 'true' : '',
      };
    }
    case 'transition': {
      // 옛 applyTransition — notice는 호출부가 정한다(⑤).
      const { patch } = planModePurposeTransition(state, action.nextMode, action.nextPurpose, action.catalogByKey);
      return { ...state, ...patch };
    }
    case 'pruneCatalog': {
      // 옛 카탈로그 정리 effect — removed 안내는 호출부가 정한다(⑤).
      const pruned = pruneStaleSelections(state, action.catalogByKey);
      return pruned ? { ...state, ...pruned.patch } : state;
    }
    default:
      return state;
  }
}

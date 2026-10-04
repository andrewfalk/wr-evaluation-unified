import { isPurposeCompatible } from '@analytics-core/common';

// 예측 필터 화이트리스트의 등록일 키 — RecipePanel(필터 후보)과 이 파일(전환 시 정리)이 같이 쓴다.
export const PREDICTION_REGISTERED_AT_KEY = 'case.meta.registeredAt';

/** 예측 모드에서 허용되는 필터인가 — predictor 역할이거나 등록일만(서버 PREDICTION_FILTER_LEAKAGE). */
export function isPredictionFilterAllowed(filter, catalogByKey) {
  const v = catalogByKey.get(filter.key);
  return v?.predictionRole === 'predictor' || filter.key === PREDICTION_REGISTERED_AT_KEY;
}

function sameKeys(a, b) {
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
export function planModePurposeTransition(prev, nextMode, nextPurpose, catalogByKey) {
  const modeChanged = nextMode !== prev.analysisMode;
  const incompatible = (key) => {
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

  let requestedMethod;
  if (nextMode === 'prediction') requestedMethod = 'l2_logistic';
  else if (modeChanged || variablesChanged) requestedMethod = null;
  else requestedMethod = prev.requestedMethod;

  let filterDraft = prev.filterDraft;
  let appliedFilters = prev.appliedFilters;
  const removedFilters = [];
  if (nextMode === 'prediction') {
    const keep = (f) => isPredictionFilterAllowed(f, catalogByKey);
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
export function pruneStaleSelections(prev, catalogByKey) {
  const stale = (key) => !catalogByKey.has(key);
  const removedKeys = [];
  const note = (k) => { if (!removedKeys.includes(k)) removedKeys.push(k); };

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

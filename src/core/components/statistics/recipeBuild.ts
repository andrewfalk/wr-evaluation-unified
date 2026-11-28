// 작업대의 레시피 순수 함수(조건 키 · 예측 변수 거르기 · 레시피 만들기 · 완성 판정) — P2-77a에서 StatisticsWorkbench.tsx의 선언을 본문 그대로 옮겼다.
import type { CatalogVariable, StatsFilter } from '@wr/contracts/stats';

type CatalogByKey = Map<string, CatalogVariable>;

/** 작업대가 미리보기·실행에 보내는 레시피(서버 계약의 입력 모양 — 기본값 필드는 보내지 않는다). */
export interface WorkbenchRecipe {
  grain: string;
  variableKeys: string[];
  filters: StatsFilter[];
  analysisPurpose: string;
  formulaPolicies: Record<string, string>;
  analysisMode: string;
  requestedMethod?: string;
  regression?: {
    outcomeKey: string;
    standardizePredictors: boolean;
    interactionTerms: Array<[string, string]>;
    splineKeys: string[];
    eventLevel?: string;
  };
  prediction?: { outcomeKey: string; eventLevel: string };
  descriptive?: { stratifyByKey: string };
}

// PR3-A — 이변량 모드는 정렬하지 않는다(계획서 §클라이언트배선): variableKeys 순서가
// x/y 역할을 정하므로 [a,b]와 [b,a]는 서로 다른 조건이어야 한다. requestedMethod도
// 조건 키에 포함 — method를 바꾸면 preview가 재실행돼야 새 availableMethods 판정을
// 받을 수 있다(단, requestedMethod가 아직 없어도(undefined) 유효한 조건 키를 만들어야
// 최초 preview가 발사된다 — 순환의존 방지, 계획서 §"이슈1 — 필수수정, 재발 방지").
// PR0-B3 Part A — grain을 조건 키에 추가한다. 안 하면 grain을 바꿔도(예: case →
// vibration_interval) 다른 필드가 전부 동일할 경우 조건 키가 안 바뀌어 preview가
// 재실행되지 않는다(계획 pr0-b3-shimmying-magpie.md "Grain 선택 UI" 절).
// PR4-A1 — 회귀도 이변량과 같은 이유로 정렬하지 않는다(계획서 §5): predictor
// 순서가 forest plot 행 순서다. outcomeKey도 조건 키에 넣는다 — 안 넣으면
// outcome만 바꿨을 때 preview가 재실행되지 않는다(§17-19행의 grain 버그와
// 동일한 함정, 계획서 §5 "필수 포함").
// PR4-A2 — standardizePredictors/interactionTerms/splineKeys/eventLevel도 조건
// 키에 포함한다. 빠뜨리면 이 옵션만 바꿨을 때 preview가 재실행되지 않는다(A1이
// outcomeKey/grain에서 겪은 것과 동일한 함정 — 계획서 §5 "buildConditionKey에
// 반드시 포함").
// PR4-B2 — 예측도 회귀와 같은 이유로 정렬하지 않는다(predictor 순서가 계수표
// 행 순서다) — outcomeKey·eventLevel도 조건 키에 포함한다(계획서 §6단계
// "buildConditionKey는 순서를 보존하고 outcome·eventLevel을 포함한다").
// Table1 — stratifyByKey도 조건 키에 포함한다. 빠뜨리면 그룹 변수만 바꿨을 때
// preview가 재실행되지 않는다(위 outcomeKey/grain이 겪은 것과 동일한 함정).
export function buildConditionKey(
  grain: string, analysisMode: string, variableKeys: string[], requestedMethod: string | null, analysisPurpose: string,
  formulaPolicies: Record<string, string>, appliedFilters: StatsFilter[],
  outcomeKey: string | null, standardizePredictors: boolean, interactionTerms: Array<[string, string]>, splineKeys: string[],
  eventLevel: string, stratifyByKey: string | null,
): string {
  return JSON.stringify({
    grain,
    analysisMode,
    variableKeys: analysisMode === 'bivariate' || analysisMode === 'regression' || analysisMode === 'prediction'
      ? variableKeys : [...variableKeys].sort(),
    requestedMethod: requestedMethod ?? null,
    analysisPurpose,
    formulaPolicies,
    appliedFilters,
    outcomeKey: analysisMode === 'regression' || analysisMode === 'prediction' ? (outcomeKey ?? null) : null,
    standardizePredictors: analysisMode === 'regression' ? standardizePredictors : false,
    interactionTerms: analysisMode === 'regression' ? interactionTerms : [],
    splineKeys: analysisMode === 'regression' ? splineKeys : [],
    eventLevel: analysisMode === 'regression' || analysisMode === 'prediction' ? (eventLevel || null) : null,
    stratifyByKey: analysisMode === 'descriptive' ? (stratifyByKey ?? null) : null,
  });
}

// PR4-B2 — 예측은 predictionRole로 outcome/predictor가 정해져 있다(회귀처럼 "선택한
// 나머지 전부가 predictor"가 아니다 — 서버가 PREDICTION_PREDICTOR_INVALID_ROLE로
// 거부한다). CatalogPanel은 역할과 무관하게 체크를 허용하므로(계획서 §6단계
// "역할별로 필터링한다"), 실제로 recipe에 담을 집합은 여기서 역할로 다시 걸러
// 잘못된 역할의 변수가 조용히 400을 유발하지 않게 한다.
export function predictionEffectiveVariableKeys(variableKeys: string[], outcomeKey: string | null, catalogByKey: CatalogByKey): string[] {
  const predictorKeys = variableKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole === 'predictor');
  if (!outcomeKey || catalogByKey.get(outcomeKey)?.predictionRole !== 'outcome') return predictorKeys;
  return [outcomeKey, ...predictorKeys];
}

export function buildRecipe(
  grain: string, analysisMode: string, variableKeys: string[], requestedMethod: string | null, analysisPurpose: string,
  formulaPolicies: Record<string, string>, appliedFilters: StatsFilter[],
  outcomeKey: string | null, standardizePredictors: boolean, interactionTerms: Array<[string, string]>, splineKeys: string[],
  eventLevel: string, catalogByKey: CatalogByKey, stratifyByKey: string | null,
): WorkbenchRecipe {
  return {
    grain,
    variableKeys: analysisMode === 'prediction' ? predictionEffectiveVariableKeys(variableKeys, outcomeKey, catalogByKey) : variableKeys,
    filters: appliedFilters,
    analysisPurpose,
    formulaPolicies,
    analysisMode,
    // PR3-B — 상관행렬도 requestedMethod(pearson/spearman)가 필요하다(계획서 §4/§7).
    // PR4-B2 — 예측은 l2_logistic 하나뿐이라 사용자 선택 UI 없이 모드 전환 시
    // 자동으로 채운다(handleAnalysisModeChange/handleGrainChange).
    ...((analysisMode === 'bivariate' || analysisMode === 'correlation_matrix' || analysisMode === 'regression' || analysisMode === 'prediction') && requestedMethod ? { requestedMethod } : {}),
    // PR4-A1 — outcomeKey가 아직 없으면(최초 선택 전) regression 필드 자체를
    // 만들지 않는다 — 서버 zod가 regression 모드에서 이 객체를 필수로 요구하므로
    // (없으면 REGRESSION_REQUIRES_REGRESSION_OBJECT), isRecipeComplete가 outcomeKey
    // 존재를 먼저 확인해 이 상태로는 애초에 실행/커밋을 안 하게 만든다.
    // PR4-A2 — 고급 옵션(표준화/interaction/spline/eventLevel)도 같은 regression
    // 서브객체에 싣는다(.strict() 스키마라 빈 배열/false도 명시적으로 보낸다).
    ...(analysisMode === 'regression' && outcomeKey ? {
      regression: {
        outcomeKey,
        standardizePredictors,
        interactionTerms,
        splineKeys,
        ...(eventLevel ? { eventLevel } : {}),
      },
    } : {}),
    // PR4-B2 — 예측은 회귀와 달리 eventLevel이 필수다(서버 zod가 min(1) — 자동
    // 선택 폴백이 없다, 계획서 §1단계). isRecipeComplete가 eventLevel 존재를
    // 먼저 확인해 이 상태로는 실행/커밋을 안 하게 만든다.
    ...(analysisMode === 'prediction' && outcomeKey && eventLevel ? {
      prediction: { outcomeKey, eventLevel },
    } : {}),
    // Table1 — stratifyByKey가 선택돼 있을 때만 descriptive 서브객체를 만든다(서버
    // zod가 다른 모드에 이 필드가 붙는 것을 거부하므로 analysisMode==='descriptive'
    // 로 한정).
    ...(analysisMode === 'descriptive' && stratifyByKey ? {
      descriptive: { stratifyByKey },
    } : {}),
  };
}

// PR3-A — 이변량이면 "변수 정확히 2개 + formula policy 완료"까지만 본다. method
// 선택 여부는 절대 여기서 보지 않는다 — 여기서 보면 method 미선택 상태에서 preview
// 자체가 안 나가 availableMethods를 받아올 수 없다(1차 초안의 순환의존 버그가
// 클라이언트에서 재발했던 지점, 계획서 §"이슈1"). method 실행 가능 여부는 오직
// canExecute(실행 버튼)에서만 본다.
export function isRecipeComplete(
  analysisMode: string, variableKeys: string[], formulaPolicies: Record<string, string>, catalogByKey: CatalogByKey,
  appliedFilters: StatsFilter[], outcomeKey: string | null, eventLevel: string, stratifyByKey: string | null,
): boolean {
  if (analysisMode === 'bivariate') {
    if (variableKeys.length !== 2 || variableKeys[0] === variableKeys[1]) return false;
  } else if (analysisMode === 'correlation_matrix') {
    // PR3-B §4 — 3개 이상 + 중복 없음(zod superRefine과 동일 조건, 클라이언트도
    // 미리 막아야 preview가 400 없이 매끄럽게 나간다).
    if (variableKeys.length < 3 || new Set(variableKeys).size !== variableKeys.length) return false;
  } else if (analysisMode === 'regression') {
    // PR4-A1 §5 — outcome 1개 + predictor 1개 이상(zod superRefine과 동일 조건).
    // requestedMethod는 여기서 보지 않는다 — 방법 선택 여부는 canExecute에서만
    // 본다(이변량과 같은 원칙, §5 "requiresMethodCheck").
    if (!outcomeKey || !variableKeys.includes(outcomeKey) || variableKeys.length < 2) return false;
  } else if (analysisMode === 'prediction') {
    // PR4-B2 — outcome이 실제로 predictionRole:'outcome'이어야 하고, predictor도
    // 역할이 'predictor'인 것만 센다(회귀와 달리 "나머지 전부"가 아니다). eventLevel은
    // 서버가 자동 선택하지 않으므로(계획서 §1단계 — min(1) 필수) 여기서도 확인한다.
    if (!outcomeKey || catalogByKey.get(outcomeKey)?.predictionRole !== 'outcome' || !eventLevel) return false;
    const validPredictorCount = variableKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole === 'predictor').length;
    if (validPredictorCount < 1) return false;
  } else if (variableKeys.length === 0) {
    return false;
  }
  const neededKeys = Array.from(new Set([
    ...variableKeys,
    ...appliedFilters.map((f) => f.key),
    // Table1 — stratifyByKey에 산식 선택이 필요하면(예: 여러 정책을 지원하는
    // 변수를 그룹 축으로 쓸 때) 이것도 골라야 실행 가능하다고 판정한다.
    ...(analysisMode === 'descriptive' && stratifyByKey ? [stratifyByKey] : []),
  ]));
  const seenFamilies = new Set();
  for (const key of neededKeys) {
    const v = catalogByKey.get(key);
    if (!v || seenFamilies.has(v.formulaFamily)) continue;
    seenFamilies.add(v.formulaFamily);
    if (v.supportedFormulaPolicies.length > 1 && !formulaPolicies[v.formulaFamily]) return false;
  }
  return true;
}

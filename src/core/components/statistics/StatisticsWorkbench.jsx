import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchStatsCatalog, previewStatsAnalysis, runStatsAnalysis, exportStatsAggregate } from '../../services/statsRepository';
import { useStatsRunPolling } from '../../hooks/useStatsRunPolling';
import { CatalogPanel } from './CatalogPanel';
import { RecipePanel } from './RecipePanel';
import { ResultPanel } from './ResultPanel';
import { InspectorReportPanel } from './InspectorReportPanel';
import { useViewportWidth } from './useViewportWidth';
import { describeStatsApiError } from './describeStatsError';
import './statistics-workbench.css';
import '../charts/charts.css';

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
function buildConditionKey(
  grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters,
  outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel,
) {
  return JSON.stringify({
    grain,
    analysisMode,
    variableKeys: analysisMode === 'bivariate' || analysisMode === 'regression' ? variableKeys : [...variableKeys].sort(),
    requestedMethod: requestedMethod ?? null,
    analysisPurpose,
    formulaPolicies,
    appliedFilters,
    outcomeKey: analysisMode === 'regression' ? (outcomeKey ?? null) : null,
    standardizePredictors: analysisMode === 'regression' ? standardizePredictors : false,
    interactionTerms: analysisMode === 'regression' ? interactionTerms : [],
    splineKeys: analysisMode === 'regression' ? splineKeys : [],
    eventLevel: analysisMode === 'regression' ? (eventLevel || null) : null,
  });
}

function buildRecipe(
  grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters,
  outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel,
) {
  return {
    grain,
    variableKeys,
    filters: appliedFilters,
    analysisPurpose,
    formulaPolicies,
    analysisMode,
    // PR3-B — 상관행렬도 requestedMethod(pearson/spearman)가 필요하다(계획서 §4/§7).
    ...((analysisMode === 'bivariate' || analysisMode === 'correlation_matrix' || analysisMode === 'regression') && requestedMethod ? { requestedMethod } : {}),
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
  };
}

// PR3-A — 이변량이면 "변수 정확히 2개 + formula policy 완료"까지만 본다. method
// 선택 여부는 절대 여기서 보지 않는다 — 여기서 보면 method 미선택 상태에서 preview
// 자체가 안 나가 availableMethods를 받아올 수 없다(1차 초안의 순환의존 버그가
// 클라이언트에서 재발했던 지점, 계획서 §"이슈1"). method 실행 가능 여부는 오직
// canExecute(실행 버튼)에서만 본다.
function isRecipeComplete(analysisMode, variableKeys, formulaPolicies, catalogByKey, appliedFilters, outcomeKey) {
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
  } else if (variableKeys.length === 0) {
    return false;
  }
  const neededKeys = Array.from(new Set([...variableKeys, ...appliedFilters.map((f) => f.key)]));
  const seenFamilies = new Set();
  for (const key of neededKeys) {
    const v = catalogByKey.get(key);
    if (!v || seenFamilies.has(v.formulaFamily)) continue;
    seenFamilies.add(v.formulaFamily);
    if (v.supportedFormulaPolicies.length > 1 && !formulaPolicies[v.formulaFamily]) return false;
  }
  return true;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function isFeatureUnavailableError(err) {
  return err?.status === 404 && err?.data?.code === 'NOT_FOUND';
}

// PR2 — 통계분석 워크벤치 화면. 계획서(pr2-dreamy-frog.md) §1~§10의 최종 설계를 그대로
// 구현한다: 4열 레이아웃, draft/appliedFilters/committed 3단 상태, 조건-key+요청세대
// 조합으로 판정하는 preview 유효성, 재조회와 초기적재의 분리(§4).
export function StatisticsWorkbench({
  session, serverConfig, statsAvailable, refetchConfig, configRefreshing, configRefreshError, onClose,
}) {
  const [catalogState, setCatalogState] = useState({ status: 'loading', data: null, error: null });
  const [featureUnavailableDetected, setFeatureUnavailableDetected] = useState(false);

  // 1차 리뷰가 잡은 결함 — statsAvailable "값"만 보고 배너를 내리면, config가 이미 true로
  // 저장된 상태에서(일시적 404 → 배너 표시 → 서버 복구 → 재조회도 true) true→true라
  // effect가 재실행되지 않아 배너가 안 내려가고, 카탈로그·preview도 마운트/조건 변경 시에만
  // 재요청되므로 최초 실패가 그대로 남는다. "재조회가 방금 끝났다"는 사건(configRefreshing의
  // true→false 하강 엣지) 자체를 감지해 recoveryToken을 올리고, 카탈로그·preview 둘 다 이
  // 토큰을 의존성에 포함시켜 값이 안 바뀌어도 재시도되게 한다.
  //
  // 2차 리뷰가 잡은 결함 — useServerConfig.js의 refetchConfig()는 실패 시 state.config를
  // 그대로 둔다(§4 설계 — 오래된 응답이 최신 상태를 덮지 않게). 즉 statsAvailable이 true인
  // 채로 재조회가 "실패"해도(configRefreshing: true→false는 성공·실패 모두에서 일어남)
  // statsAvailable 값만 보면 여전히 true라 그 실패까지 복구로 오인했다 — 재조회가 실제로
  // 성공했을 때(configRefreshError가 비어있을 때)만 복구로 인정한다.
  const [recoveryToken, setRecoveryToken] = useState(0);
  const wasRefreshingRef = useRef(configRefreshing);
  useEffect(() => {
    const wasRefreshing = wasRefreshingRef.current;
    wasRefreshingRef.current = configRefreshing;
    if (wasRefreshing && !configRefreshing && statsAvailable && !configRefreshError) {
      setFeatureUnavailableDetected(false);
      setRecoveryToken((t) => t + 1);
    }
  }, [configRefreshing, statsAvailable, configRefreshError]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setCatalogState({ status: 'loading', data: null, error: null });
    fetchStatsCatalog(session, { signal: controller.signal })
      .then((data) => { if (!cancelled) setCatalogState({ status: 'ready', data, error: null }); })
      .catch((err) => {
        if (cancelled) return;
        if (isFeatureUnavailableError(err)) setFeatureUnavailableDetected(true);
        setCatalogState({ status: 'error', data: null, error: err });
      });
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryToken]);

  const catalogByKey = useMemo(
    () => new Map((catalogState.data?.variables ?? []).map((v) => [v.key, v])),
    [catalogState.data],
  );

  // PR0-B3 Part A — GET /catalog가 실제로 지원한다고 응답한 grain만 선택지로 노출한다.
  // 아직 로딩 중이면 'case'만 있다고 가정(기존 동작과 동일하게 안전한 기본값).
  const supportedGrains = catalogState.data?.supportedGrains ?? ['case'];

  // ---- draft recipe state ----
  const [grain, setGrain] = useState('case');
  const [variableKeys, setVariableKeys] = useState([]);
  const [analysisPurpose, setAnalysisPurpose] = useState('association');
  const [formulaPolicies, setFormulaPolicies] = useState({});
  const [filterDraft, setFilterDraft] = useState([]);
  const [appliedFilters, setAppliedFilters] = useState([]);
  // PR3-A — 이변량 모드 draft state(계획서 §클라이언트배선).
  const [analysisMode, setAnalysisMode] = useState('descriptive');
  const [requestedMethod, setRequestedMethod] = useState(null);
  const [modeChangeBlockedNotice, setModeChangeBlockedNotice] = useState(false);
  // PR4-A1 §5 — 회귀 outcome 선택 상태. predictor는 selectedKeys(=variableKeys)에서
  // outcomeKey를 뺀 나머지로 파생한다(별도 배열을 두면 두 벌 진실원이 생긴다).
  const [outcomeKey, setOutcomeKey] = useState(null);
  // PR4-A2 — 회귀 고급 옵션. interactionTerms는 [predictorA, predictorB] 쌍의
  // 배열, splineKeys는 continuous predictor 키 배열. eventLevel은 categorical
  // outcome에서만 의미 있다(observed 레벨을 클라이언트가 알 방법이 없어 —
  // CatalogVariableSchema에 선언 레벨 필드 자체가 없다 — A1의 referenceLevels와
  // 같은 원칙으로 자유 입력을 받고, 비워두면 서버가 결정적으로 자동 선택한다).
  const [standardizePredictors, setStandardizePredictors] = useState(false);
  const [interactionTerms, setInteractionTerms] = useState([]);
  const [splineKeys, setSplineKeys] = useState([]);
  const [eventLevel, setEventLevel] = useState('');

  // PR0-B3 Part A — grain을 바꾸면 이전 grain에서 고른 변수·필터·method가 새 grain에는
  // 안 맞을 수 있어 전부 초기화한다(후보 목록을 grain으로 거르는 것과는 별개 — 후보를
  // 숨기는 것만으로는 이미 선택된 상태가 지워지지 않는다).
  function handleGrainChange(nextGrain) {
    if (nextGrain === grain) return;
    setGrain(nextGrain);
    setVariableKeys([]);
    setFilterDraft([]);
    setAppliedFilters([]);
    setRequestedMethod(null);
    setOutcomeKey(null);
    setStandardizePredictors(false);
    setInteractionTerms([]);
    setSplineKeys([]);
    setEventLevel('');
  }

  function toggleVariable(key) {
    setVariableKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      const cap = analysisMode === 'bivariate' ? 2 : 20; // 서버 상한(§ recipe 계약) — 조용히 무시
      if (prev.length >= cap) return prev;
      return [...prev, key];
    });
    // 변수 구성이 바뀌면 이전에 고른 method가 새 쌍에 더 이상 안 맞을 수 있어 초기화한다
    // (계획서 §클라이언트배선 "변수 변경 시 requestedMethod 초기화" — 조용히 유지하면
    // 사용자가 뭘 실행했는지 오해할 수 있음).
    setRequestedMethod(null);
    // PR4-A1 — 지금 outcome으로 지정된 변수를 해제하면 outcome도 함께 비운다(더 이상
    // 선택 목록에 없는 변수를 outcome으로 남겨두면 predictor 파생 로직이 깨진다).
    setOutcomeKey((prev) => (prev === key ? null : prev));
    // PR4-A2 — 해제된 변수가 interactionTerms/splineKeys에 남아 있으면 서버가
    // "predictor 집합에 없다"로 400을 낸다 — 선택 해제 시 함께 정리한다.
    setInteractionTerms((prev) => prev.filter(([a, b]) => a !== key && b !== key));
    setSplineKeys((prev) => prev.filter((k) => k !== key));
    // 해제된 변수가 categorical outcome이었다면 eventLevel도 그 변수의 레벨 값이므로
    // 함께 비운다(handleOutcomeKeyChange와 동일 원칙 — 리뷰 지적).
    setEventLevel((prev) => (key === outcomeKey ? '' : prev));
  }

  function handleAnalysisModeChange(nextMode) {
    if (nextMode === 'bivariate' && variableKeys.length > 2) {
      // 계획서 §클라이언트배선 — 3개 이상 선택된 채로 전환 시도하면 자동 축소하지
      // 않고 전환 자체를 막는다(암묵적 선택 손실 방지).
      setModeChangeBlockedNotice(true);
      return;
    }
    setModeChangeBlockedNotice(false);
    setRequestedMethod(null);
    // PR4-A1 §5 — 회귀는 넉넉한 상한(20)이라 이변량처럼 전환 자체를 막을 필요는
    // 없다. 모드를 나가거나 새로 들어올 때 outcome만 초기화해 이전 모드의 스테일
    // 상태가 새 모드로 새지 않게 한다.
    setOutcomeKey(null);
    // PR4-A2 — 고급 옵션도 모드 전환 시 함께 초기화한다(스테일 상태 방지, 위와 동일 원칙).
    setStandardizePredictors(false);
    setInteractionTerms([]);
    setSplineKeys([]);
    setEventLevel('');
    setAnalysisMode(nextMode);
  }

  // PR4-A2 — outcome을 바꾸면 새 outcome이 이전에 predictor로서 interactionTerms/
  // splineKeys에 들어가 있었을 수 있다(둘 다 predictor 키만 유효 — 서버가
  // INTERACTION_VARIABLE_MUST_BE_A_PREDICTOR/SPLINE_VARIABLE_MUST_BE_A_PREDICTOR로
  // 거부한다). 새 outcome 키를 참조하는 항목만 정리한다.
  // eventLevel은 이전 outcome(categorical)의 레벨 값이므로 outcome이 바뀌면(같은
  // categorical 변수로 바뀌어도 레벨 집합이 다를 수 있음) 무조건 초기화한다 —
  // 안 그러면 continuous/boolean outcome으로 바뀐 뒤에도 값이 남아 서버가
  // EVENT_LEVEL_REQUIRES_CATEGORICAL_OUTCOME으로 거부한다(리뷰 지적).
  function handleOutcomeKeyChange(nextOutcomeKey) {
    setOutcomeKey(nextOutcomeKey);
    setInteractionTerms((prev) => prev.filter(([a, b]) => a !== nextOutcomeKey && b !== nextOutcomeKey));
    setSplineKeys((prev) => prev.filter((k) => k !== nextOutcomeKey));
    setEventLevel('');
  }

  // ---- preview: 조건-key(무엇을 위한 결과인가) + 요청세대(그 요청 인스턴스가 최신인가) ----
  const currentConditionKey = buildConditionKey(
    grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters,
    outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel,
  );
  const [previewState, setPreviewState] = useState({ key: null, status: 'idle', result: null, error: null });
  const previewGenRef = useRef(0);

  useEffect(() => {
    const key = currentConditionKey;
    const gen = ++previewGenRef.current;
    if (!isRecipeComplete(analysisMode, variableKeys, formulaPolicies, catalogByKey, appliedFilters, outcomeKey)) {
      setPreviewState({ key, status: 'idle', result: null, error: null });
      return undefined;
    }
    setPreviewState({ key, status: 'loading', result: null, error: null });
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        // PR3-A — preview는 requestedMethod를 참고만 하고 유효성을 검사하지 않는다
        // (서버가 관대함, 계획서 §파이프라인 "preview는 관대하다") — method 미선택
        // 상태에서도 이 호출은 정상적으로 나가야 availableMethods를 받아올 수 있다.
        const recipe = buildRecipe(grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters, outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel);
        const res = await previewStatsAnalysis(recipe, session, { signal: controller.signal });
        if (gen !== previewGenRef.current) return;
        setPreviewState((prev) => (prev.key === key ? { key, status: 'ready', result: res, error: null } : prev));
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (isFeatureUnavailableError(err)) setFeatureUnavailableDetected(true);
        if (gen !== previewGenRef.current) return;
        setPreviewState((prev) => (prev.key === key ? { key, status: 'error', result: null, error: err } : prev));
      }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
    // recoveryToken도 의존성에 넣는다 — 조건은 그대로인데 이전 preview가 기능비가용으로
    // 실패했을 때, 재조회 성공 이후 재시도할 유일한 트리거가 이것이다(조건 자체는 안 바뀌므로
    // currentConditionKey만으로는 재실행되지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConditionKey, recoveryToken]);

  const isPreviewCurrent = previewState.key === currentConditionKey;

  // ---- analyze: committed snapshot(요청 전송 시점) ----
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);
  const [committedRecipe, setCommittedRecipe] = useState(null);
  const [committedResult, setCommittedResult] = useState(null);
  const analyzeInFlightRef = useRef(false);
  // 코드리뷰(2026-09-24) — 202로 전환된 요청의 recipe를 committedRecipe에 즉시
  // 반영하면, 이전 결과(committedResult)는 그대로인 채 화면에 새 recipe 라벨만
  // 붙는 불일치가 생긴다(그 요청이 실패/취소되면 계속 남는다). 진행 중인 recipe는
  // 여기 별도로 보관해두고, 폴링이 성공했을 때만 committedRecipe/committedResult를
  // 함께 교체한다 — 리렌더를 유발할 필요가 없으므로 상태가 아니라 ref로 둔다.
  const pendingRecipeRef = useRef(null);
  // 코드리뷰(2026-09-24) — POST가 202를 반환하기 전에 화면이 언마운트되면,
  // useStatsRunPolling의 unmount cleanup(stop())은 이미 실행된 뒤라 그 이후
  // 도착하는 runPolling.start() 호출을 정리할 방법이 없다(새 generation으로
  // 폴링이 다시 시작돼 언마운트 후에도 계속 서버를 두드림). 언마운트 이후에는
  // start()를 아예 호출하지 않도록 컴포넌트 생존 여부를 별도로 추적한다.
  // 코드리뷰 2차(2026-09-24) — cleanup에서만 false로 바꾸면 StrictMode 개발모드의
  // "setup→cleanup→재setup" 이중 호출(실제 컴포넌트는 계속 마운트된 채로 effect만
  // 한 번 더 도는 것 — main.jsx가 StrictMode를 실제로 쓴다) 이후 mountedRef가
  // false로 눌러앉아, 화면이 멀쩡히 열려 있는데도 이후 모든 POST 응답 처리(200
  // 결과 반영·202 폴링 시작·에러 처리)가 조용히 무시된다. setup에서도 true로
  // 복구해야 재setup이 상태를 되돌린다.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 2차 리뷰가 잡은 결함 — featureUnavailableDetected가 실행/내보내기 잠금 조건에 빠져 있어,
  // 배너가 떠 있는 동안에도 캐시된 statsAvailable=true·이전 preview=ready로 버튼이 활성화될
  // 수 있었다. 실행·내보내기 공통 잠금 조건을 하나로 묶는다. configRefreshError도 포함 —
  // 재조회가 실패해 가용성을 다시 확인 못 한 상태를 방어적으로 함께 잠근다(3차 리뷰).
  const actionsLocked = featureUnavailableDetected || configRefreshing || !!configRefreshError || !statsAvailable;

  // PR3-A — 이변량이면 requestedMethod가 존재하고 그 상태가 available/conditional인지
  // 추가로 확인한다. `selectedMethod?.status !== 'unsupported'`는 쓰지 않는다 —
  // requestedMethod가 목록에 아예 없을 때(존재 안 함) undefined !== 'unsupported'가
  // true로 새기 때문이다(계획서 §클라이언트배선 이슈1). 존재 여부를 명시적으로 확인한다.
  const selectedMethod = previewState.result?.availableMethods?.find((m) => m.id === requestedMethod);
  // PR3-B — 상관행렬도 이변량과 동일하게 requestedMethod가 available/conditional
  // 이어야 실행 가능하다(서버 handlePostAnalyze의 METHOD_NOT_AVAILABLE 판정과
  // 동일 기준 — statsAnalyzeHandler.ts).
  const requiresMethodCheck = analysisMode === 'bivariate' || analysisMode === 'correlation_matrix' || analysisMode === 'regression';
  const methodExecutable =
    !requiresMethodCheck ||
    (selectedMethod != null && (selectedMethod.status === 'available' || selectedMethod.status === 'conditional'));

  const canExecute =
    isPreviewCurrent &&
    previewState.status === 'ready' &&
    !previewState.result?.counts?.suppressed &&
    methodExecutable &&
    !isAnalyzing &&
    !actionsLocked;

  // PR4-B1 §프론트엔드 — POST /analyze가 syncBudgetMs 안에 못 끝나면 202(analysisRunId만,
  // runManifest/result 없음)를 돌려준다. 이 경우 폴링을 시작하고, 완료되면 아래 useEffect가
  // 기존 200 처리 경로(setCommittedResult)로 합류시킨다.
  const runPolling = useStatsRunPolling(session);

  async function handleRunAnalyze() {
    if (!canExecute || analyzeInFlightRef.current) return;
    analyzeInFlightRef.current = true;
    const recipeAtSubmit = buildRecipe(grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters, outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel);
    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await runStatsAnalysis(recipeAtSubmit, session);
      // 언마운트 후 도착한 응답은 처리하지 않는다 — 특히 202 분기의 runPolling.start()는
      // useStatsRunPolling의 unmount cleanup이 이미 실행된 뒤라 정리할 방법이 없는
      // 새 폴링 루프를 만들어버린다(코드리뷰 2026-09-24).
      if (!mountedRef.current) return;
      if (res.runManifest) {
        // 200 — syncBudgetMs 안에 끝남. 기존 경로 그대로.
        setCommittedRecipe(recipeAtSubmit);
        setCommittedResult(res);
        analyzeInFlightRef.current = false;
        setIsAnalyzing(false);
        return;
      }
      // 202 — 아직 큐/실행 중. 폴링 시작(analyzeInFlightRef/isAnalyzing은 폴링이
      // 끝날 때까지 유지 — 아래 useEffect가 종결 시 정리한다). committedRecipe는
      // 아직 교체하지 않는다 — 폴링이 성공했을 때 committedResult와 함께 교체해야
      // "새 recipe 라벨 + 이전 result"라는 불일치가 생기지 않는다(코드리뷰 2026-09-24).
      pendingRecipeRef.current = recipeAtSubmit;
      runPolling.start(res.analysisRunId);
    } catch (err) {
      if (!mountedRef.current) return;
      if (isFeatureUnavailableError(err)) setFeatureUnavailableDetected(true);
      setAnalyzeError(err);
      analyzeInFlightRef.current = false;
      setIsAnalyzing(false);
    }
  }

  // 폴링 종결 처리 — succeeded는 기존 200 처리 경로(committedResult)로 합류하되,
  // committedRecipe도 이 시점에 pendingRecipeRef와 함께 교체한다(단독으로 미리
  // 바꾸면 "새 recipe 라벨 + 이전 result" 불일치가 생긴다). failed/cancelled는
  // analyzeError로 — 이 경우 committedRecipe/committedResult는 그대로 둔다(마지막
  // 성공한 실행을 계속 표시). queued/running/idle은 아무 것도 안 함.
  useEffect(() => {
    if (runPolling.status === 'succeeded') {
      setCommittedRecipe(pendingRecipeRef.current);
      setCommittedResult({ runManifest: runPolling.data.runManifest, result: runPolling.data.result });
      analyzeInFlightRef.current = false;
      setIsAnalyzing(false);
    } else if (runPolling.status === 'failed' || runPolling.status === 'cancelled' || runPolling.status === 'error') {
      setAnalyzeError(runPolling.error ?? new Error(
        runPolling.status === 'cancelled' ? '분석이 취소되었습니다.' : `분석 실행 실패(${runPolling.data?.errorCode ?? runPolling.status})`,
      ));
      analyzeInFlightRef.current = false;
      setIsAnalyzing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPolling.status]);

  const recipeChanged = committedRecipe
    ? JSON.stringify(buildRecipe(grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters, outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel)) !== JSON.stringify(committedRecipe)
    : false;

  // ---- export ----
  const [exportState, setExportState] = useState({ status: 'idle', error: null });
  // PR3-A §"결과 계약 불변조건" — 내보내기 잠금은 activeScreen이나 현재 활성 탭이
  // 아니라 저장된 실행의 analysisMode 기준(committedRecipe)으로 판정한다. 탭을
  // 바꿔도 내보내기 가능 여부는 바뀌면 안 된다. 서버도 manifest.analysisMode 기준으로
  // 같은 판정을 하므로(statsExportHandler.ts) 여기서도 동일 기준으로 미리 막는다.
  // PR4-A2 — 회귀는 CSV export 지원(집계 섹션만, pointDiagnostics는 서버가
  // 애초에 CSV에 넣지 않는다). bivariate/correlation_matrix는 여전히 PR5 범위.
  const exportUnsupported = committedRecipe?.analysisMode === 'bivariate' || committedRecipe?.analysisMode === 'correlation_matrix';
  async function handleExport() {
    if (!committedResult || actionsLocked || exportUnsupported) return; // 버튼 disabled와 별개로 핸들러 자체도 잠금을 지킨다
    setExportState({ status: 'exporting', error: null });
    try {
      const blob = await exportStatsAggregate(committedResult.runManifest.analysisRunId, session);
      downloadBlob(blob, `stats-export-${committedResult.runManifest.analysisRunId}.csv`);
      setExportState({ status: 'idle', error: null });
    } catch (err) {
      if (isFeatureUnavailableError(err)) setFeatureUnavailableDetected(true);
      setExportState({ status: 'error', error: err });
    }
  }

  // ---- 반응형 접힘(§10) ----
  const viewportWidth = useViewportWidth();
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [recipeCollapsed, setRecipeCollapsed] = useState(false);
  const userOverrodeCatalog = useRef(false);
  const userOverrodeRight = useRef(false);

  useEffect(() => {
    if (!userOverrodeCatalog.current) setCatalogCollapsed(viewportWidth < 1280);
    if (!userOverrodeRight.current) setRightCollapsed(viewportWidth < 1536);
  }, [viewportWidth]);

  return (
    <div className="swb-root">
      <header className="swb-header">
        <h1>통계분석 워크벤치</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {committedResult && <span className="swb-header-status">run {committedResult.runManifest.analysisRunId.slice(0, 8)}</span>}
          <button type="button" className="swb-btn swb-btn--sm" onClick={onClose}>닫기</button>
        </div>
      </header>

      {(featureUnavailableDetected || configRefreshError) && (
        <div className="swb-banner">
          <span>{featureUnavailableDetected ? '기능을 사용할 수 없게 되었습니다.' : `새로고침 실패: ${configRefreshError}`}</span>
          <button type="button" className="swb-btn swb-btn--sm" onClick={refetchConfig} disabled={configRefreshing}>
            {configRefreshing ? '확인 중…' : '새로고침'}
          </button>
        </div>
      )}

      {catalogState.status === 'loading' && <div className="swb-empty">카탈로그를 불러오는 중…</div>}
      {catalogState.status === 'error' && !featureUnavailableDetected && (
        <div className="swb-banner" style={{ whiteSpace: 'pre-wrap' }}>카탈로그를 불러오지 못했습니다: {describeStatsApiError(catalogState.error)}</div>
      )}

      {catalogState.status === 'ready' && (
        <div className="swb-row">
          <CatalogPanel
            catalog={catalogState.data}
            grain={grain}
            selectedKeys={variableKeys}
            onToggleVariable={toggleVariable}
            collapsed={catalogCollapsed}
            onToggleCollapse={() => { userOverrodeCatalog.current = true; setCatalogCollapsed((v) => !v); }}
          />
          <RecipePanel
            catalog={catalogState.data}
            grain={grain}
            supportedGrains={supportedGrains}
            unsupportedGrains={catalogState.data?.unsupportedGrains ?? []}
            onGrainChange={handleGrainChange}
            selectedKeys={variableKeys}
            onRemoveVariable={toggleVariable}
            analysisMode={analysisMode}
            onAnalysisModeChange={handleAnalysisModeChange}
            modeChangeBlockedNotice={modeChangeBlockedNotice}
            requestedMethod={requestedMethod}
            onRequestedMethodChange={setRequestedMethod}
            outcomeKey={outcomeKey}
            onOutcomeKeyChange={handleOutcomeKeyChange}
            standardizePredictors={standardizePredictors}
            onStandardizePredictorsChange={setStandardizePredictors}
            interactionTerms={interactionTerms}
            onInteractionTermsChange={setInteractionTerms}
            splineKeys={splineKeys}
            onSplineKeysChange={setSplineKeys}
            eventLevel={eventLevel}
            onEventLevelChange={setEventLevel}
            analysisPurpose={analysisPurpose}
            onAnalysisPurposeChange={setAnalysisPurpose}
            formulaPolicies={formulaPolicies}
            onFormulaPolicyChange={(family, policy) => setFormulaPolicies((prev) => ({ ...prev, [family]: policy }))}
            filterDraft={filterDraft}
            onFilterDraftChange={setFilterDraft}
            appliedFilters={appliedFilters}
            onApplyFilters={() => setAppliedFilters(filterDraft)}
            previewState={previewState}
            isPreviewCurrent={isPreviewCurrent}
            canExecute={canExecute}
            isAnalyzing={isAnalyzing}
            onRunAnalyze={handleRunAnalyze}
            collapsed={recipeCollapsed}
            onToggleCollapse={() => setRecipeCollapsed((v) => !v)}
          />
          <ResultPanel
            catalog={catalogState.data}
            committedRecipe={committedRecipe}
            committedResult={committedResult}
            recipeChanged={recipeChanged}
            onExport={handleExport}
            exportState={exportState}
            actionsLocked={actionsLocked}
            exportUnsupported={exportUnsupported}
          />
          <InspectorReportPanel
            catalog={catalogState.data}
            committedRecipe={committedRecipe}
            committedResult={committedResult}
            collapsed={rightCollapsed}
            onToggleCollapse={() => { userOverrodeRight.current = true; setRightCollapsed((v) => !v); }}
          />
        </div>
      )}

      {(runPolling.status === 'polling') && (
        <div className="swb-banner">
          분석 실행 중… (queued/running 상태를 확인하는 중입니다)
          <button type="button" onClick={runPolling.cancel} style={{ marginLeft: '0.75rem' }}>취소</button>
        </div>
      )}

      {analyzeError && (
        <div className="swb-banner" style={{ whiteSpace: 'pre-wrap' }}>분석 실행 실패: {describeStatsApiError(analyzeError)}</div>
      )}
    </div>
  );
}

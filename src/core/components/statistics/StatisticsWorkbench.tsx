import { useEffect, useRef, useState } from 'react';
import { runStatsAnalysis } from '../../services/statsRepository';
import { useStatsRunPolling } from '../../hooks/useStatsRunPolling';
import { CatalogPanel } from './CatalogPanel';
import { RecipePanel } from './RecipePanel';
import { ResultPanel } from './ResultPanel';
import { InspectorReportPanel } from './InspectorReportPanel';
import { useViewportWidth } from './useViewportWidth';
import { describeStatsApiError, getUnknownVariableKeys, REMOVED_VARIABLES, UNKNOWN_VARIABLE_FALLBACK } from './describeStatsError';
import { planModePurposeTransition, pruneStaleSelections } from './workbenchTransitions';
import type { RecipeDraft } from './workbenchTransitions';
import { useRecipeDraft } from './useRecipeDraft';
import { useStatsCatalog } from './useStatsCatalog';
import { useStatsPreview } from './useStatsPreview';
import { useStatsExport } from './useStatsExport';
import { isFeatureUnavailableError } from './workbenchIo';
import type { RecipeTransitionNotice } from './RecipePanel';
import type { AnalyzeResponse } from '@wr/contracts/stats';
import { buildConditionKey, buildRecipe, isRecipeComplete } from './recipeBuild';
import type { WorkbenchRecipe } from './recipeBuild';
import './statistics-workbench.css';
import '../charts/charts.css';

// 작업대 레시피 타입 — P2-77a에서 recipeBuild.ts로 옮겼다.
export type { WorkbenchRecipe } from './recipeBuild';

export interface StatisticsWorkbenchProps {
  session: unknown;
  serverConfig: unknown;
  statsAvailable: boolean;
  refetchConfig: () => void;
  configRefreshing: boolean;
  /** 설정 재조회 실패 문구(없으면 비어 있다) — 화면은 글자로만 쓴다. */
  configRefreshError: unknown;
  onClose: () => void;
}


// PR2 — 통계분석 워크벤치 화면. 계획서(pr2-dreamy-frog.md) §1~§10의 최종 설계를 그대로
// 구현한다: 4열 레이아웃, draft/appliedFilters/committed 3단 상태, 조건-key+요청세대
// 조합으로 판정하는 preview 유효성, 재조회와 초기적재의 분리(§4).
export function StatisticsWorkbench({
  session, serverConfig, statsAvailable, refetchConfig, configRefreshing, configRefreshError, onClose,
}: StatisticsWorkbenchProps) {
  // P2-77c — 카탈로그 불러오기(설정 재조회 하강 엣지 → recoveryToken → 다시 불러오기)는 useStatsCatalog로(effect 순서 그대로).
  const {
    catalogState, catalogByKey, featureUnavailableDetected, setFeatureUnavailableDetected, recoveryToken, setRecoveryToken,
  } = useStatsCatalog({ session, statsAvailable, configRefreshing, configRefreshError });

  // PR0-B3 Part A — GET /catalog가 실제로 지원한다고 응답한 grain만 선택지로 노출한다.
  // 아직 로딩 중이면 'case'만 있다고 가정(기존 동작과 동일하게 안전한 기본값).
  const supportedGrains = catalogState.data?.supportedGrains ?? ['case'];

  // ---- draft recipe state ----
  // P2-77b — 레시피 초안 14개 상태는 useRecipeDraft의 reducer 하나로 둔다(workbenchTransitions.ts의 recipeDraftReducer).
  // 패널에 그대로 내려가는 setter는 옛 useState setter처럼 값·갱신 함수를 받고 참조가 같다.
  const {
    draft, dispatchDraft,
    setRequestedMethod, setStandardizePredictors, setInteractionTerms, setSplineKeys, setEventLevel, setStratifyByKey,
    setFilterDraft, setAppliedFilters, setFormulaPolicies,
  } = useRecipeDraft();
  const {
    grain, variableKeys, analysisPurpose, formulaPolicies, filterDraft, appliedFilters, analysisMode, requestedMethod,
    outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel, stratifyByKey,
  } = draft;
  const [modeChangeBlockedNotice, setModeChangeBlockedNotice] = useState(false);
  // 모드·목적 전환으로 자동 정리된 변수·필터 안내(RecipePanel 상단에 표시, 닫기 가능).
  const [transitionNotice, setTransitionNotice] = useState<RecipeTransitionNotice | null>(null);
  // 카탈로그 재조회 후 사라진 키를 초안에서 정리했다는 안내.
  const [catalogPruneNotice, setCatalogPruneNotice] = useState<string[] | null>(null);
  // 서버가 UNKNOWN_VARIABLE로 거부한 키 — 카탈로그 재조회가 **성공할 때까지** 유지한다(재조회가 실패해도
  // 복구 버튼이 사라지지 않게 오류 상태에서 파생하지 않고 별도 state로 둔다).
  const [recoveryKeys, setRecoveryKeys] = useState<string[]>([]);

  function currentDraft(): RecipeDraft {
    return {
      analysisMode, analysisPurpose, variableKeys, outcomeKey, eventLevel, standardizePredictors,
      interactionTerms, splineKeys, stratifyByKey, requestedMethod, filterDraft, appliedFilters,
    };
  }

  // 카탈로그 재조회가 성공한 직후에만 새 카탈로그에 없는 키를 초안에서 정리한다. 로딩·실패 중
  // catalogByKey는 빈 맵이라 그때 정리하면 정상 변수·필터가 전부 지워진다 — status==='ready'
  // 가드가 그것을 막는다(지연된 이전 요청의 응답은 위 fetch effect의 cancelled 가드가 무시).
  // 구 키를 새 키로 자동 치환하지 않는다(값의 의미가 달라졌을 수 있어 사용자가 다시 고른다).
  useEffect(() => {
    if (catalogState.status !== 'ready') return;
    setRecoveryKeys([]); // 재조회 성공 — 복구 필요 상태 해제(실패·로딩 중에는 유지)
    const pruned = pruneStaleSelections(currentDraft(), catalogByKey);
    if (!pruned) return;
    dispatchDraft({ type: 'pruneCatalog', catalogByKey });
    setCatalogPruneNotice(pruned.removed.map((k) => (REMOVED_VARIABLES as Record<string, string>)[k] ? `${k} — ${(REMOVED_VARIABLES as Record<string, string>)[k]}` : k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogState]);

  // PR0-B3 Part A — grain을 바꾸면 이전 grain에서 고른 변수·필터·method가 새 grain에는
  // 안 맞을 수 있어 전부 초기화한다(후보 목록을 grain으로 거르는 것과는 별개 — 후보를
  // 숨기는 것만으로는 이미 선택된 상태가 지워지지 않는다).
  function handleGrainChange(nextGrain: string) {
    // 같은 grain이면 아무것도 바꾸지 않는다. 예측은 l2_logistic 하나뿐이라(다시 고를 UI가 없어) 모드가
    // prediction이면 requestedMethod를 그대로 둔다 — 둘 다 reducer(changeGrain)가 지킨다.
    dispatchDraft({ type: 'changeGrain', grain: nextGrain });
  }

  function toggleVariable(key: string) {
    // 변수 구성이 바뀌면(상한에 걸려 그대로여도) 방법 선택을 초기화하고, 해제된 변수가 결과변수·interaction·
    // spline·그룹 변수였다면 함께 정리한다 — reducer(toggleVariable)의 주석 ①② 참고.
    dispatchDraft({ type: 'toggleVariable', key });
  }

  function handleAnalysisModeChange(nextMode: string) {
    if (nextMode === 'bivariate' && variableKeys.length > 2) {
      // 계획서 §클라이언트배선 — 3개 이상 선택된 채로 전환 시도하면 자동 축소하지
      // 않고 전환 자체를 막는다(암묵적 선택 손실 방지).
      setModeChangeBlockedNotice(true);
      return;
    }
    setModeChangeBlockedNotice(false);
    // PR4-B2 — 계획서 §6단계 "purpose 강제·복귀": analysisMode==='prediction' ⇔
    // analysisPurpose==='prediction'(서버 PURPOSE_MODE_MISMATCH, shared/contracts/
    // stats.ts). 예측으로 들어가면 목적을 강제로 맞추고, 예측에서 나가면 목적을
    // 기본값으로 되돌린다(그대로 두면 나간 뒤에도 purpose:'prediction'이 남아
    // 다음 모드에서 곧바로 400을 낸다).
    const nextPurpose = nextMode === 'prediction'
      ? 'prediction'
      : (analysisPurpose === 'prediction' ? 'association' : analysisPurpose);
    applyTransition(nextMode, nextPurpose);
  }

  // 분석 목적 메뉴 — 모드 전환과 같은 정리 규칙(workbenchTransitions.js)을 쓴다.
  function handleAnalysisPurposeChange(nextPurpose: string) {
    if (nextPurpose === analysisPurpose) return;
    applyTransition(analysisMode, nextPurpose);
  }

  // 모드·목적 전환 공통 경로: 순수 계산(planModePurposeTransition)이 새 모드/목적을 인자로
  // 받아 requestedMethod·비호환 변수·예측 필터·고급 옵션을 한 번에 정리한다.
  function applyTransition(nextMode: string, nextPurpose: string) {
    // 안내(notice)는 reducer 밖 상태다 — 같은 순수 함수로 계산해 정하고, 초안 정리는 액션으로 보낸다.
    const { notice } = planModePurposeTransition(currentDraft(), nextMode, nextPurpose, catalogByKey);
    dispatchDraft({ type: 'transition', nextMode, nextPurpose, catalogByKey });
    setTransitionNotice(notice);
  }

  // PR4-A2 — outcome을 바꾸면 새 outcome이 이전에 predictor로서 interactionTerms/
  // splineKeys에 들어가 있었을 수 있다(둘 다 predictor 키만 유효 — 서버가
  // INTERACTION_VARIABLE_MUST_BE_A_PREDICTOR/SPLINE_VARIABLE_MUST_BE_A_PREDICTOR로
  // 거부한다). 새 outcome 키를 참조하는 항목만 정리한다.
  // eventLevel은 이전 outcome(categorical)의 레벨 값이므로 outcome이 바뀌면(같은
  // categorical 변수로 바뀌어도 레벨 집합이 다를 수 있음) 무조건 초기화한다 —
  // 안 그러면 continuous/boolean outcome으로 바뀐 뒤에도 값이 남아 서버가
  // EVENT_LEVEL_REQUIRES_CATEGORICAL_OUTCOME으로 거부한다(리뷰 지적).
  function handleOutcomeKeyChange(nextOutcomeKey: string | null) {
    // 새 결과변수를 참조하는 interaction·spline을 정리하고, eventLevel은 예측의 boolean 결과변수면 'true', 그 밖은 비운다.
    dispatchDraft({ type: 'changeOutcomeKey', outcomeKey: nextOutcomeKey, catalogByKey });
  }

  // ---- preview: 조건-key(무엇을 위한 결과인가) + 요청세대(그 요청 인스턴스가 최신인가) ----
  const currentConditionKey = buildConditionKey(
    grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters,
    outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel, stratifyByKey,
  );
  // P2-77c — 미리보기 요청(조건 키 + 요청 세대, 500ms 디바운스)은 useStatsPreview로(effect 자리·의존 배열 그대로).
  const { previewState } = useStatsPreview({
    currentConditionKey, recoveryToken, session, analysisPurpose,
    isComplete: () => isRecipeComplete(analysisMode, variableKeys, formulaPolicies, catalogByKey, appliedFilters, outcomeKey, eventLevel, stratifyByKey),
    buildRequest: () => buildRecipe(grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters, outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel, catalogByKey, stratifyByKey),
    onFeatureUnavailable: () => setFeatureUnavailableDetected(true),
  });

  const isPreviewCurrent = previewState.key === currentConditionKey;

  // ---- analyze: committed snapshot(요청 전송 시점) ----
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<unknown>(null);
  // 실패한 실행 요청의 분석 목적(오류 문구용) — 현재 화면의 목적과 다를 수 있다.
  const [analyzeErrorPurpose, setAnalyzeErrorPurpose] = useState<string | null>(null);
  const [committedRecipe, setCommittedRecipe] = useState<WorkbenchRecipe | null>(null);
  const [committedResult, setCommittedResult] = useState<AnalyzeResponse | null>(null);
  const analyzeInFlightRef = useRef(false);
  // 코드리뷰(2026-09-24) — 202로 전환된 요청의 recipe를 committedRecipe에 즉시
  // 반영하면, 이전 결과(committedResult)는 그대로인 채 화면에 새 recipe 라벨만
  // 붙는 불일치가 생긴다(그 요청이 실패/취소되면 계속 남는다). 진행 중인 recipe는
  // 여기 별도로 보관해두고, 폴링이 성공했을 때만 committedRecipe/committedResult를
  // 함께 교체한다 — 리렌더를 유발할 필요가 없으므로 상태가 아니라 ref로 둔다.
  const pendingRecipeRef = useRef<WorkbenchRecipe | null>(null);
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
  // 동일 기준 — server/src/stats/routes/analyzeHandler.ts).
  const requiresMethodCheck = analysisMode === 'bivariate' || analysisMode === 'correlation_matrix' || analysisMode === 'regression' || analysisMode === 'prediction';
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
    const recipeAtSubmit = buildRecipe(grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters, outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel, catalogByKey, stratifyByKey);
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
      setAnalyzeErrorPurpose(recipeAtSubmit.analysisPurpose);
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
      setCommittedResult({ runManifest: (runPolling.data as unknown as AnalyzeResponse).runManifest, result: (runPolling.data as unknown as AnalyzeResponse).result });
      analyzeInFlightRef.current = false;
      setIsAnalyzing(false);
    } else if (runPolling.status === 'failed' || runPolling.status === 'cancelled' || runPolling.status === 'error') {
      setAnalyzeError(runPolling.error ?? new Error(
        runPolling.status === 'cancelled' ? '분석이 취소되었습니다.' : `분석 실행 실패(${(runPolling.data as { errorCode?: string } | null)?.errorCode ?? runPolling.status})`,
      ));
      analyzeInFlightRef.current = false;
      setIsAnalyzing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPolling.status]);

  // 서버가 UNKNOWN_VARIABLE로 거부한 오류(구 번들·오래 열린 탭의 삭제된 변수)에서 키를 뽑아 복구 안내를 띄운다.
  const detectedUnknownKeys = Array.from(new Set([
    ...getUnknownVariableKeys(analyzeError),
    ...(isPreviewCurrent && previewState.status === 'error' ? getUnknownVariableKeys(previewState.error) : []),
  ]));
  const detectedUnknownSignature = detectedUnknownKeys.join('|');
  useEffect(() => {
    if (detectedUnknownKeys.length === 0) return;
    setRecoveryKeys((prev) => Array.from(new Set([...prev, ...detectedUnknownKeys])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedUnknownSignature]);

  // 카탈로그 재조회. 복구 필요 상태(recoveryKeys)는 건드리지 않는다 — 성공했을 때만 해제된다.
  function retryCatalog() {
    setCatalogPruneNotice(null);
    setRecoveryToken((t) => t + 1);
  }
  function handleReloadCatalog() {
    setAnalyzeError(null);
    setAnalyzeErrorPurpose(null);
    retryCatalog();
  }

  const recipeChanged = committedRecipe
    ? JSON.stringify(buildRecipe(grain, analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters, outcomeKey, standardizePredictors, interactionTerms, splineKeys, eventLevel, catalogByKey, stratifyByKey)) !== JSON.stringify(committedRecipe)
    : false;

  // ---- export ----
  // PR3-A §"결과 계약 불변조건" — 내보내기 잠금은 activeScreen이나 현재 활성 탭이
  // 아니라 저장된 실행의 analysisMode 기준(committedRecipe)으로 판정한다. 탭을
  // 바꿔도 내보내기 가능 여부는 바뀌면 안 된다. 서버도 manifest.analysisMode 기준으로
  // 같은 판정을 하므로(server/src/stats/export/exportHandler.ts) 여기서도 동일 기준으로 미리 막는다.
  // PR4-A2 — 회귀는 CSV export 지원(집계 섹션만, pointDiagnostics는 서버가
  // 애초에 CSV에 넣지 않는다). bivariate/correlation_matrix는 여전히 PR5 범위.
  const exportUnsupported = committedRecipe?.analysisMode === 'bivariate' || committedRecipe?.analysisMode === 'correlation_matrix';
  const { exportState, handleExport } = useStatsExport({
    committedResult, actionsLocked, exportUnsupported, session, mountedRef,
    onFeatureUnavailable: () => setFeatureUnavailableDetected(true),
  });

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

      {(featureUnavailableDetected || (configRefreshError as string | null | undefined)) && (
        <div className="swb-banner">
          <span>{featureUnavailableDetected ? '기능을 사용할 수 없게 되었습니다.' : `새로고침 실패: ${configRefreshError}`}</span>
          <button type="button" className="swb-btn swb-btn--sm" onClick={refetchConfig} disabled={configRefreshing}>
            {configRefreshing ? '확인 중…' : '새로고침'}
          </button>
        </div>
      )}

      {catalogState.status === 'loading' && <div className="swb-empty">카탈로그를 불러오는 중…</div>}
      {catalogState.status === 'error' && !featureUnavailableDetected && (
        <div className="swb-banner" style={{ whiteSpace: 'pre-wrap' }}>카탈로그를 불러오지 못했습니다: {describeStatsApiError(catalogState.error)}{' '}
          <button type="button" className="swb-btn swb-btn--sm" onClick={retryCatalog}>다시 시도</button>
        </div>
      )}

      {catalogState.status === 'ready' && (
        <div className="swb-row">
          <CatalogPanel
            catalog={catalogState.data}
            grain={grain}
            analysisPurpose={analysisPurpose}
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
            stratifyByKey={stratifyByKey}
            onStratifyByKeyChange={setStratifyByKey}
            analysisPurpose={analysisPurpose}
            onAnalysisPurposeChange={handleAnalysisPurposeChange}
            transitionNotice={transitionNotice}
            onDismissTransitionNotice={() => setTransitionNotice(null)}
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
          <button type="button" className="swb-btn swb-btn--sm" onClick={runPolling.cancel} style={{ marginLeft: '0.75rem' }}>취소</button>
        </div>
      )}

      {(analyzeError as Error | null) && (
        <div className="swb-banner" style={{ whiteSpace: 'pre-wrap' }}>분석 실행 실패: {describeStatsApiError(analyzeError, { catalogByKey, analysisPurpose: analyzeErrorPurpose })}</div>
      )}

      {recoveryKeys.length > 0 && (
        <div className="swb-banner" role="alert">
          <span>
            삭제되었거나 이름이 바뀐 변수가 선택되어 있습니다. 카탈로그를 새로 불러오면 목록에 없는 변수를 선택에서 제거합니다(새 변수로 자동 교체하지 않으므로 다시 선택해 주세요).
          </span>
          <button type="button" className="swb-btn swb-btn--sm" onClick={handleReloadCatalog}>카탈로그 새로 불러오기</button>
        </div>
      )}

      {catalogPruneNotice && (
        <div className="swb-banner" role="status">
          <span style={{ whiteSpace: 'pre-wrap' }}>
            카탈로그에 없는 변수 {catalogPruneNotice.length}개를 선택에서 제거했습니다:{' '}{catalogPruneNotice.join(' / ')}
          </span>
          <button type="button" className="swb-btn swb-btn--sm" onClick={() => setCatalogPruneNotice(null)}>닫기</button>
        </div>
      )}
    </div>
  );
}

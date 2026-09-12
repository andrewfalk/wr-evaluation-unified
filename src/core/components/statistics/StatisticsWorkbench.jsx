import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchStatsCatalog, previewStatsAnalysis, runStatsAnalysis, exportStatsAggregate } from '../../services/statsRepository';
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
function buildConditionKey(analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters) {
  return JSON.stringify({
    analysisMode,
    variableKeys: analysisMode === 'bivariate' ? variableKeys : [...variableKeys].sort(),
    requestedMethod: requestedMethod ?? null,
    analysisPurpose,
    formulaPolicies,
    appliedFilters,
  });
}

function buildRecipe(analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters) {
  return {
    grain: 'case',
    variableKeys,
    filters: appliedFilters,
    analysisPurpose,
    formulaPolicies,
    analysisMode,
    // PR3-B — 상관행렬도 requestedMethod(pearson/spearman)가 필요하다(계획서 §4/§7).
    ...((analysisMode === 'bivariate' || analysisMode === 'correlation_matrix') && requestedMethod ? { requestedMethod } : {}),
  };
}

// PR3-A — 이변량이면 "변수 정확히 2개 + formula policy 완료"까지만 본다. method
// 선택 여부는 절대 여기서 보지 않는다 — 여기서 보면 method 미선택 상태에서 preview
// 자체가 안 나가 availableMethods를 받아올 수 없다(1차 초안의 순환의존 버그가
// 클라이언트에서 재발했던 지점, 계획서 §"이슈1"). method 실행 가능 여부는 오직
// canExecute(실행 버튼)에서만 본다.
function isRecipeComplete(analysisMode, variableKeys, formulaPolicies, catalogByKey, appliedFilters) {
  if (analysisMode === 'bivariate') {
    if (variableKeys.length !== 2 || variableKeys[0] === variableKeys[1]) return false;
  } else if (analysisMode === 'correlation_matrix') {
    // PR3-B §4 — 3개 이상 + 중복 없음(zod superRefine과 동일 조건, 클라이언트도
    // 미리 막아야 preview가 400 없이 매끄럽게 나간다).
    if (variableKeys.length < 3 || new Set(variableKeys).size !== variableKeys.length) return false;
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

  // ---- draft recipe state ----
  const [variableKeys, setVariableKeys] = useState([]);
  const [analysisPurpose, setAnalysisPurpose] = useState('association');
  const [formulaPolicies, setFormulaPolicies] = useState({});
  const [filterDraft, setFilterDraft] = useState([]);
  const [appliedFilters, setAppliedFilters] = useState([]);
  // PR3-A — 이변량 모드 draft state(계획서 §클라이언트배선).
  const [analysisMode, setAnalysisMode] = useState('descriptive');
  const [requestedMethod, setRequestedMethod] = useState(null);
  const [modeChangeBlockedNotice, setModeChangeBlockedNotice] = useState(false);

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
    setAnalysisMode(nextMode);
  }

  // ---- preview: 조건-key(무엇을 위한 결과인가) + 요청세대(그 요청 인스턴스가 최신인가) ----
  const currentConditionKey = buildConditionKey(analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters);
  const [previewState, setPreviewState] = useState({ key: null, status: 'idle', result: null, error: null });
  const previewGenRef = useRef(0);

  useEffect(() => {
    const key = currentConditionKey;
    const gen = ++previewGenRef.current;
    if (!isRecipeComplete(analysisMode, variableKeys, formulaPolicies, catalogByKey, appliedFilters)) {
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
        const recipe = buildRecipe(analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters);
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
  const requiresMethodCheck = analysisMode === 'bivariate' || analysisMode === 'correlation_matrix';
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

  async function handleRunAnalyze() {
    if (!canExecute || analyzeInFlightRef.current) return;
    analyzeInFlightRef.current = true;
    const recipeAtSubmit = buildRecipe(analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters);
    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await runStatsAnalysis(recipeAtSubmit, session);
      setCommittedRecipe(recipeAtSubmit);
      setCommittedResult(res);
    } catch (err) {
      if (isFeatureUnavailableError(err)) setFeatureUnavailableDetected(true);
      setAnalyzeError(err);
    } finally {
      analyzeInFlightRef.current = false;
      setIsAnalyzing(false);
    }
  }

  const recipeChanged = committedRecipe
    ? JSON.stringify(buildRecipe(analysisMode, variableKeys, requestedMethod, analysisPurpose, formulaPolicies, appliedFilters)) !== JSON.stringify(committedRecipe)
    : false;

  // ---- export ----
  const [exportState, setExportState] = useState({ status: 'idle', error: null });
  // PR3-A §"결과 계약 불변조건" — 내보내기 잠금은 activeScreen이나 현재 활성 탭이
  // 아니라 저장된 실행의 analysisMode 기준(committedRecipe)으로 판정한다. 탭을
  // 바꿔도 내보내기 가능 여부는 바뀌면 안 된다. 서버도 manifest.analysisMode 기준으로
  // 같은 판정을 하므로(statsExportHandler.ts) 여기서도 동일 기준으로 미리 막는다.
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
            selectedKeys={variableKeys}
            onToggleVariable={toggleVariable}
            collapsed={catalogCollapsed}
            onToggleCollapse={() => { userOverrodeCatalog.current = true; setCatalogCollapsed((v) => !v); }}
          />
          <RecipePanel
            catalog={catalogState.data}
            selectedKeys={variableKeys}
            onRemoveVariable={toggleVariable}
            analysisMode={analysisMode}
            onAnalysisModeChange={handleAnalysisModeChange}
            modeChangeBlockedNotice={modeChangeBlockedNotice}
            requestedMethod={requestedMethod}
            onRequestedMethodChange={setRequestedMethod}
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

      {analyzeError && (
        <div className="swb-banner" style={{ whiteSpace: 'pre-wrap' }}>분석 실행 실패: {describeStatsApiError(analyzeError)}</div>
      )}
    </div>
  );
}

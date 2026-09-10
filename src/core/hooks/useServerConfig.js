import { useState, useEffect, useRef } from 'react';
import { requestJson } from '../services/httpClient';

const FAIL_CLOSED_CONFIG = {
  mode: 'intranet',
  aiEnabled: false,
  localFallbackAllowed: false,
  videoAnalysisEnabled: false,
  videoAnalysisFixtureMode: false,
  // 6.0-12: config fetch 실패 시에도 폴링이 조기 포기하지 않도록 안전 기본값(서버 기본과 동일 600s).
  videoAnalysisJobDeadlineMs: 600000,
  videoAnalysisQueueWaitMs: 600000,
  serverTime: null,
  // PR2 §4 — 통계 워크벤치도 fail-closed 기본값을 명시적으로 둔다(둘 다 false로 메뉴 숨김 유지).
  statsWorkbenchEnabled: false,
  statsWorkbenchAvailable: false,
};

export function useServerConfig({ session, settings }) {
  const isIntranet =
    session?.mode === 'intranet' || settings?.integrationMode === 'intranet';
  const baseUrl = session?.apiBaseUrl || settings?.apiBaseUrl || '';

  // fetchedBaseUrl in state (not ref) so render can safely read it for
  // effectiveLoading without triggering the react-hooks/exhaustive-deps lint rule.
  const [state, setState] = useState(() => ({
    config: null,
    loading: isIntranet,
    error: null,
    fetchedBaseUrl: null,
  }));

  // Ref used only inside the effect to deduplicate fetches — safe per React rules.
  const lastFetchedUrlRef = useRef(null);

  useEffect(() => {
    if (!isIntranet) {
      setState({ config: null, loading: false, error: null, fetchedBaseUrl: null });
      lastFetchedUrlRef.current = null;
      return;
    }

    if (lastFetchedUrlRef.current === baseUrl) return;
    lastFetchedUrlRef.current = baseUrl;

    let cancelled = false;
    // Manual AbortController for 8s timeout — more compatible than AbortSignal.timeout().
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    // Set fetchedBaseUrl immediately so render-time effectiveLoading sees it.
    setState(prev => ({ ...prev, loading: true, error: null, fetchedBaseUrl: baseUrl }));

    requestJson('/api/config/public', { baseUrl, signal: controller.signal })
      .then(data => {
        if (cancelled) return;
        clearTimeout(timeoutId);
        setState({ config: data, loading: false, error: null, fetchedBaseUrl: baseUrl });
      })
      .catch(err => {
        if (cancelled) return;
        clearTimeout(timeoutId);
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        setState({
          config: FAIL_CLOSED_CONFIG,
          loading: false,
          error: isTimeout ? '서버 응답 시간 초과 (8초). 서버가 실행 중인지 확인하세요.' : (err.message || '서버 연결 실패'),
          fetchedBaseUrl: baseUrl,
        });
      });

    // Reset the dedup ref on cleanup so StrictMode's second effect invocation
    // (and any genuine remount) always fires a fresh fetch.
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      lastFetchedUrlRef.current = null;
    };
  }, [isIntranet, baseUrl]);

  // Computed synchronously in render using state (not ref) so it's lint-safe.
  // True whenever intranet is active but we haven't completed a fetch for
  // the current baseUrl yet — closes the gap when async settings load changes
  // integrationMode after the useState initializer already ran.
  const effectiveLoading =
    state.loading || (isIntranet && state.fetchedBaseUrl !== baseUrl && !state.error);

  // ---------------------------------------------------------------------------
  // PR2 §4 — 이미 화면을 띄운 채로 서버 가용성을 다시 확인하는 재조회(refetchConfig).
  // 위 초기적재 effect가 쓰는 state.loading/state.error와 완전히 분리된 별도 상태만
  // 건드린다 — App.jsx의 전역 부팅 게이트(configLoading/configError)가 재조회 때문에
  // 다시 켜져 통계 화면 같은 이미 열린 화면을 통째로 언마운트시키는 사고를 막기 위함.
  // ---------------------------------------------------------------------------
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const connectionGenRef = useRef(0);
  const refetchControllerRef = useRef(null);

  // 주소든 모드든(intranet↔local) 뭐가 바뀌든 — 값이 이전과 같아지는 왕복이라도 매 변경마다
  // 세대를 올린다. 세대만 올리는 걸로 끝나면 "이전 연결에서 진행 중이던 재조회"가 자기
  // finally에서 세대 불일치로 setRefreshing(false)를 건너뛰어 refreshing=true가 새 연결로
  // 그대로 넘어가 버린다 — 그래서 여기서 그 재조회를 직접 취소하고 관련 상태도 함께 정리한다.
  useEffect(() => {
    connectionGenRef.current += 1;
    refetchControllerRef.current?.abort();
    setRefreshing(false);
    setRefreshError(null);
  }, [isIntranet, baseUrl]);
  useEffect(() => () => { refetchControllerRef.current?.abort(); }, []); // 언마운트 시 정리

  async function refetchConfig() {
    if (!isIntranet) return;
    refetchControllerRef.current?.abort(); // 이전 재조회가 아직 진행 중이면 취소(중복 클릭 방어)
    connectionGenRef.current += 1; // 이 재조회 호출 자체도 새 세대 — 이전에 걸려있던 어떤 재조회도 무효화
    const gen = connectionGenRef.current;
    const requestedBaseUrl = baseUrl;
    const controller = new AbortController();
    refetchControllerRef.current = controller;
    let timedOut = false;
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
    setRefreshing(true);
    try {
      const data = await requestJson('/api/config/public', { baseUrl: requestedBaseUrl, signal: controller.signal });
      if (gen !== connectionGenRef.current) return; // 그 사이 주소·모드가 바뀌었거나 다른 재조회가 시작됨 — 무효
      setState(prev => ({ ...prev, config: data }));
      setRefreshError(null);
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (timedOut && gen === connectionGenRef.current) {
          setRefreshError('서버 응답 시간 초과 (8초). 다시 시도해 주세요.'); // 타임아웃은 취소와 달리 실패로 알린다
        }
        return; // 그 외 abort(연결 교체·언마운트)는 조용히 무시 — 더 최신 요청이 이미 진행 중이거나 화면을 떠남
      }
      if (gen !== connectionGenRef.current) return;
      setRefreshError(err.message || '새로고침 실패'); // 전역 configError와 별개 — 부팅 게이트가 안 읽음
    } finally {
      clearTimeout(timeoutId);
      if (gen === connectionGenRef.current) setRefreshing(false);
    }
  }

  return {
    serverConfig: state.config,
    configLoading: effectiveLoading,
    configError: state.error,
    refetchConfig,
    refreshing,
    refreshError,
  };
}

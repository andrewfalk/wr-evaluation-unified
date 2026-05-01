import { useState, useEffect, useRef } from 'react';
import { requestJson } from '../services/httpClient';

const FAIL_CLOSED_CONFIG = {
  mode: 'intranet',
  aiEnabled: false,
  localFallbackAllowed: false,
  serverTime: null,
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
    // Set fetchedBaseUrl immediately so render-time effectiveLoading sees it.
    setState(prev => ({ ...prev, loading: true, error: null, fetchedBaseUrl: baseUrl }));

    requestJson('/api/config/public', { baseUrl, signal: AbortSignal.timeout(8000) })
      .then(data => {
        if (cancelled) return;
        setState({ config: data, loading: false, error: null, fetchedBaseUrl: baseUrl });
      })
      .catch(err => {
        if (cancelled) return;
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        setState({
          config: FAIL_CLOSED_CONFIG,
          loading: false,
          error: isTimeout ? '서버 응답 시간 초과 (8초). 서버가 실행 중인지 확인하세요.' : (err.message || '서버 연결 실패'),
          fetchedBaseUrl: baseUrl,
        });
      });

    return () => { cancelled = true; };
  }, [isIntranet, baseUrl]);

  // Computed synchronously in render using state (not ref) so it's lint-safe.
  // True whenever intranet is active but we haven't completed a fetch for
  // the current baseUrl yet — closes the gap when async settings load changes
  // integrationMode after the useState initializer already ran.
  const effectiveLoading =
    state.loading || (isIntranet && state.fetchedBaseUrl !== baseUrl && !state.error);

  return {
    serverConfig: state.config,
    configLoading: effectiveLoading,
    configError: state.error,
  };
}

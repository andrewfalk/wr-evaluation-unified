import { useState, useEffect, useRef } from 'react';
import { requestJson } from '../services/httpClient';

const FAIL_CLOSED_CONFIG = {
  mode: 'intranet',
  aiEnabled: false,
  localFallbackAllowed: false,
  serverTime: null,
};

// Accepts both session and settings so detection is correct before the
// settings→session sync effect fires on the first render.
export function useServerConfig({ session, settings }) {
  // isIntranet does NOT require a non-empty baseUrl — same-origin intranet
  // (Caddy serving app + API at https://wr.hospital.local) has no apiBaseUrl.
  const isIntranet =
    session?.mode === 'intranet' || settings?.integrationMode === 'intranet';
  const baseUrl = session?.apiBaseUrl || settings?.apiBaseUrl || '';

  const [state, setState] = useState(() => ({
    config: null,
    loading: isIntranet,
    error: null,
  }));

  // Track which URL was last successfully initiated so a change triggers re-fetch.
  const lastFetchedUrlRef = useRef(null);

  useEffect(() => {
    if (!isIntranet) {
      setState({ config: null, loading: false, error: null });
      lastFetchedUrlRef.current = null;
      return;
    }

    if (lastFetchedUrlRef.current === baseUrl) return;
    lastFetchedUrlRef.current = baseUrl;

    let cancelled = false;
    setState(prev => ({ ...prev, loading: true, error: null }));

    requestJson('/api/config/public', { baseUrl })
      .then(data => {
        if (cancelled) return;
        setState({ config: data, loading: false, error: null });
      })
      .catch(err => {
        if (cancelled) return;
        setState({ config: FAIL_CLOSED_CONFIG, loading: false, error: err.message || '서버 연결 실패' });
      });

    return () => { cancelled = true; };
  }, [isIntranet, baseUrl]);

  // effectiveLoading is computed synchronously: true whenever isIntranet but
  // we have not yet completed a fetch for the current baseUrl. This closes the
  // one-render gap that occurs when async settings load changes integrationMode
  // after the useState initializer has already run with loading:false.
  const effectiveLoading =
    state.loading || (isIntranet && lastFetchedUrlRef.current !== baseUrl && !state.error);

  return {
    serverConfig: state.config,
    configLoading: effectiveLoading,
    configError: state.error,
  };
}

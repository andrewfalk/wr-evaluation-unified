import { useState, useEffect, useRef } from 'react';
import { requestJson } from '../services/httpClient';

const FAIL_CLOSED_CONFIG = {
  mode: 'intranet',
  aiEnabled: false,
  localFallbackAllowed: false,
  serverTime: null,
};

// Accepts both session and settings so the hook works correctly on the very
// first render before the settings→session sync effect has fired.
export function useServerConfig({ session, settings }) {
  const baseUrl = session?.apiBaseUrl || settings?.apiBaseUrl || '';
  const isIntranet =
    (session?.mode === 'intranet' || settings?.integrationMode === 'intranet') && !!baseUrl;

  // Start in loading state immediately when intranet is detected — prevents
  // the one-render gap where the gate hasn't engaged yet.
  const [state, setState] = useState(() => ({
    config: null,
    loading: isIntranet,
    error: null,
  }));

  // Track which URL was last fetched so changing apiBaseUrl triggers a re-fetch.
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

  return {
    serverConfig: state.config,
    configLoading: state.loading,
    configError: state.error,
  };
}

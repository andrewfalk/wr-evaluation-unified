import { useState, useEffect, useRef } from 'react';
import { requestJson } from '../services/httpClient';

const FAIL_CLOSED_CONFIG = {
  mode: 'intranet',
  aiEnabled: false,
  localFallbackAllowed: false,
  serverTime: null,
};

export function useServerConfig({ session }) {
  const [serverConfig, setServerConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState(null);
  const fetchedRef = useRef(false);

  const isIntranet = session?.mode === 'intranet' && !!session?.apiBaseUrl;

  useEffect(() => {
    if (!isIntranet) {
      setServerConfig(null);
      setConfigError(null);
      fetchedRef.current = false;
      return;
    }

    if (fetchedRef.current) return;
    fetchedRef.current = true;

    let cancelled = false;
    setConfigLoading(true);
    setConfigError(null);

    requestJson('/api/config/public', { baseUrl: session.apiBaseUrl })
      .then(data => {
        if (cancelled) return;
        setServerConfig(data);
        setConfigError(null);
      })
      .catch(err => {
        if (cancelled) return;
        setServerConfig(FAIL_CLOSED_CONFIG);
        setConfigError(err.message || '서버 연결 실패');
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });

    return () => { cancelled = true; };
  }, [isIntranet, session?.apiBaseUrl]);

  return { serverConfig, configLoading, configError };
}

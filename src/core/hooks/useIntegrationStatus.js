import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getIntegrationStatus,
  markLocalIntegrationStatus,
  probeIntegrationStatus,
  subscribeIntegrationStatus,
} from '../services/integrationStatus';

function isIntranetMode({ session, settings } = {}) {
  return settings?.integrationMode === 'intranet' || session?.mode === 'intranet';
}

export function useIntegrationStatus({ session, settings }) {
  const [status, setStatus] = useState(() => getIntegrationStatus());
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => subscribeIntegrationStatus(setStatus), []);

  const refresh = useCallback(async (overrides = {}) => {
    const nextContext = {
      session: overrides.session || session,
      settings: overrides.settings || settings,
    };

    setIsRefreshing(true);
    try {
      if (!isIntranetMode(nextContext)) {
        return markLocalIntegrationStatus({ ...nextContext, source: overrides.source || 'manual-refresh' });
      }

      return await probeIntegrationStatus({ ...nextContext, source: overrides.source || 'manual-refresh' });
    } finally {
      setIsRefreshing(false);
    }
  }, [session, settings]);

  // Held in a ref so the probe effect below is keyed ONLY on the identity fields
  // it enumerates. `refresh` closes over the whole session/settings objects, so
  // depending on it directly would re-probe on every object identity change even
  // when none of those fields moved — and since a failing probe can itself
  // replace the session object (401 → refresh fails → resetToLocalSession), that
  // made the effect self-triggering and produced an unbounded request loop.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  useEffect(() => {
    refreshRef.current({ source: 'mode-change' }).catch(() => {});
  }, [
    session?.mode,
    session?.apiBaseUrl,
    session?.user?.id,
    session?.user?.organizationId,
    settings?.integrationMode,
    settings?.apiBaseUrl,
  ]);

  return { status, refresh, isRefreshing };
}

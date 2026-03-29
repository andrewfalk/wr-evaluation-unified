import { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => {
    refresh({ source: 'mode-change' }).catch(() => {});
  }, [
    refresh,
    session?.mode,
    session?.apiBaseUrl,
    session?.user?.id,
    session?.user?.organizationId,
    settings?.integrationMode,
    settings?.apiBaseUrl,
  ]);

  return { status, refresh, isRefreshing };
}

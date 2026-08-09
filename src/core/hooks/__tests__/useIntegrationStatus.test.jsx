// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useIntegrationStatus } from '../useIntegrationStatus.js';

vi.mock('../../services/integrationStatus', () => ({
  getIntegrationStatus: vi.fn(() => ({ mode: 'local' })),
  markLocalIntegrationStatus: vi.fn(() => ({ mode: 'local' })),
  probeIntegrationStatus: vi.fn(async () => ({ mode: 'fallback' })),
  subscribeIntegrationStatus: vi.fn(() => () => {}),
}));

import { probeIntegrationStatus } from '../../services/integrationStatus';

const settings = {
  integrationMode: 'intranet',
  apiBaseUrl: 'https://srv',
};

function localSession(refreshedAt = '2026-08-09T00:00:00.000Z') {
  return {
    mode: 'local',
    apiBaseUrl: '',
    refreshedAt,
    user: {
      id: 'web-user',
      organizationId: 'local-web-workspace',
    },
  };
}

beforeEach(() => {
  cleanup();
  vi.mocked(probeIntegrationStatus).mockClear();
});

describe('useIntegrationStatus probe scheduling', () => {
  it('does not re-probe when only the session object identity/refreshedAt changes', async () => {
    const { rerender } = renderHook(
      ({ session }) => useIntegrationStatus({ session, settings }),
      { initialProps: { session: localSession() } }
    );

    await waitFor(() => expect(probeIntegrationStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender({ session: localSession('2026-08-09T00:00:01.000Z') });
      await Promise.resolve();
    });

    expect(probeIntegrationStatus).toHaveBeenCalledTimes(1);
  });

  it('re-probes when the authenticated session identity changes', async () => {
    const { rerender } = renderHook(
      ({ session }) => useIntegrationStatus({ session, settings }),
      { initialProps: { session: localSession() } }
    );

    await waitFor(() => expect(probeIntegrationStatus).toHaveBeenCalledTimes(1));

    rerender({
      session: {
        mode: 'intranet',
        apiBaseUrl: 'https://srv',
        user: { id: 'u1', organizationId: 'org1' },
      },
    });

    await waitFor(() => expect(probeIntegrationStatus).toHaveBeenCalledTimes(2));
  });
});

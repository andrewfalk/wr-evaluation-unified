import { requestJson } from './httpClient';

const listeners = new Set();
let probeSequence = 0;

function normalizeBaseUrl(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

function isIntranetMode({ session, settings } = {}) {
  return settings?.integrationMode === 'intranet' || session?.mode === 'intranet';
}

function buildSessionInfo(context = {}) {
  return {
    userId: context?.session?.user?.id || null,
    organizationId: context?.session?.user?.organizationId || null,
    authMode: context?.session?.mode || context?.settings?.integrationMode || 'local',
  };
}

function createBaseStatus() {
  return {
    mode: 'local',
    activeStore: 'local',
    connectivity: 'local',
    baseUrl: '',
    mock: false,
    source: 'system',
    message: 'Using local storage.',
    lastCheckedAt: null,
    lastError: null,
    sessionInfo: {
      userId: null,
      organizationId: null,
      authMode: 'local',
    },
    mockDetails: null,
    remoteDetails: null,
  };
}

let currentStatus = createBaseStatus();

function emit() {
  for (const listener of listeners) {
    listener(currentStatus);
  }
}

function commitStatus(nextStatus) {
  currentStatus = nextStatus;
  emit();
  return currentStatus;
}

function buildStatus(overrides = {}) {
  return {
    ...createBaseStatus(),
    ...currentStatus,
    ...overrides,
  };
}

function createLocalStatus(context = {}, overrides = {}) {
  const baseUrl = normalizeBaseUrl(context?.settings?.apiBaseUrl || context?.session?.apiBaseUrl || '');
  return buildStatus({
    mode: 'local',
    activeStore: 'local',
    connectivity: 'local',
    baseUrl,
    mock: false,
    source: context?.source || 'local',
    message: 'Using local storage.',
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
    sessionInfo: buildSessionInfo(context),
    mockDetails: null,
    remoteDetails: null,
    ...overrides,
  });
}

function createCheckingStatus(context = {}, overrides = {}) {
  const baseUrl = normalizeBaseUrl(context?.settings?.apiBaseUrl || context?.session?.apiBaseUrl || '');
  return buildStatus({
    mode: 'intranet',
    activeStore: 'checking',
    connectivity: 'checking',
    baseUrl,
    mock: false,
    source: context?.source || 'probe',
    message: baseUrl
      ? `Checking intranet endpoint at ${baseUrl}.`
      : 'Checking intranet endpoint at /api.',
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
    sessionInfo: buildSessionInfo(context),
    mockDetails: null,
    remoteDetails: null,
    ...overrides,
  });
}

function createRemoteStatus(context = {}, overrides = {}) {
  const baseUrl = normalizeBaseUrl(context?.settings?.apiBaseUrl || context?.session?.apiBaseUrl || '');
  const mock = overrides?.mock ?? context?.mock ?? (currentStatus.baseUrl === baseUrl ? currentStatus.mock : false);
  const hasMockDetails = Object.prototype.hasOwnProperty.call(overrides, 'mockDetails');
  const hasRemoteDetails = Object.prototype.hasOwnProperty.call(overrides, 'remoteDetails');
  const sameTarget = currentStatus.baseUrl === baseUrl && currentStatus.mock === mock;
  return buildStatus({
    mode: 'intranet',
    activeStore: 'remote',
    connectivity: 'connected',
    baseUrl,
    mock,
    source: context?.source || 'remote',
    message: mock
      ? `Connected to mock intranet${baseUrl ? ` at ${baseUrl}` : ''}.`
      : `Connected to intranet${baseUrl ? ` at ${baseUrl}` : ''}.`,
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
    sessionInfo: buildSessionInfo(context),
    mockDetails: hasMockDetails ? overrides.mockDetails : (sameTarget ? currentStatus.mockDetails : null),
    remoteDetails: hasRemoteDetails ? overrides.remoteDetails : (sameTarget ? currentStatus.remoteDetails : null),
    ...overrides,
  });
}

function createFallbackStatus(error, context = {}, overrides = {}) {
  const baseUrl = normalizeBaseUrl(context?.settings?.apiBaseUrl || context?.session?.apiBaseUrl || '');
  return buildStatus({
    mode: 'intranet',
    activeStore: 'fallback',
    connectivity: 'fallback',
    baseUrl,
    mock: false,
    source: context?.source || 'fallback',
    message: baseUrl
      ? `Remote storage unavailable at ${baseUrl}. Falling back to local storage.`
      : 'Remote storage unavailable. Falling back to local storage.',
    lastCheckedAt: new Date().toISOString(),
    lastError: error?.message || 'Remote storage unavailable.',
    sessionInfo: buildSessionInfo(context),
    mockDetails: null,
    remoteDetails: null,
    ...overrides,
  });
}

function extractMockDetails(data = {}) {
  return {
    scopeKey: data?.scope?.scopeKey || null,
    userId: data?.scope?.userId || null,
    organizationId: data?.scope?.organizationId || null,
    authMode: data?.scope?.authMode || null,
    workspaceCount: typeof data?.workspaceCount === 'number' ? data.workspaceCount : null,
    hasAutosave: typeof data?.hasAutosave === 'boolean' ? data.hasAutosave : null,
    storageFile: data?.storageFile || null,
    port: data?.port || null,
  };
}

function extractRemoteDetails(workspaces = []) {
  return {
    workspaceCount: Array.isArray(workspaces) ? workspaces.length : null,
  };
}

export function getIntegrationStatus() {
  return currentStatus;
}

export function subscribeIntegrationStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function markLocalIntegrationStatus(context = {}) {
  return commitStatus(createLocalStatus(context));
}

export function markCheckingIntegrationStatus(context = {}) {
  return commitStatus(createCheckingStatus(context));
}

export function markRemoteIntegrationStatus(context = {}) {
  return commitStatus(createRemoteStatus(context));
}

export function markFallbackIntegrationStatus(error, context = {}) {
  return commitStatus(createFallbackStatus(error, context));
}

export async function inspectIntegrationStatus(context = {}) {
  if (!isIntranetMode(context)) {
    return createLocalStatus({ ...context, source: context?.source || 'inspect' });
  }

  try {
    const mockStatus = await requestJson('/api/mock/status', {
      baseUrl: context?.settings?.apiBaseUrl || context?.session?.apiBaseUrl || '',
      session: context?.session,
    });

    return createRemoteStatus(
      { ...context, source: context?.source || 'inspect', mock: true },
      {
        mock: true,
        mockDetails: extractMockDetails(mockStatus),
        remoteDetails: null,
      }
    );
  } catch (error) {
    if (![404, 405].includes(error?.status)) {
      return createFallbackStatus(error, { ...context, source: context?.source || 'inspect' });
    }
  }

  try {
    const data = await requestJson('/api/workspaces', {
      baseUrl: context?.settings?.apiBaseUrl || context?.session?.apiBaseUrl || '',
      session: context?.session,
    });

    return createRemoteStatus(
      { ...context, source: context?.source || 'inspect', mock: false },
      {
        mock: false,
        mockDetails: null,
        remoteDetails: extractRemoteDetails(data?.items || []),
      }
    );
  } catch (error) {
    return createFallbackStatus(error, { ...context, source: context?.source || 'inspect' });
  }
}

export async function probeIntegrationStatus(context = {}) {
  if (!isIntranetMode(context)) {
    return markLocalIntegrationStatus({ ...context, source: 'mode-change' });
  }

  const currentProbe = ++probeSequence;
  markCheckingIntegrationStatus(context);

  const inspected = await inspectIntegrationStatus({ ...context, source: 'probe' });
  if (currentProbe !== probeSequence) {
    return currentStatus;
  }

  return commitStatus(inspected);
}

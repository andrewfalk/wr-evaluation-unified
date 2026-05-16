import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRemoteAutoSave,
  loadRemoteAutoSave,
  saveRemoteAutoSave,
  saveRemoteWorkspace,
} from '../intranetWorkspaceRepository.js';
import { requestJson } from '../httpClient.js';

vi.mock('../httpClient.js', () => ({
  requestJson: vi.fn(),
}));

vi.mock('../../utils/storage.js', () => ({
  getDeviceId: vi.fn(() => 'device abc/123'),
}));

vi.mock('@contracts/workspace', () => ({
  GetWorkspacesResponseSchema: { parse: value => value },
}));

vi.mock('@contracts/autosave', () => ({
  GetAutosaveResponseSchema: { parse: value => value },
  PutAutosaveResponseSchema: { parse: value => value },
  DeleteAutosaveResponseSchema: { parse: value => value },
}));

const SESSION = {
  apiBaseUrl: 'https://intranet.test',
  user: { id: 'user-1', organizationId: 'org-1' },
};

const PATIENT = {
  id: '00000000-0000-0000-0000-000000000001',
  createdAt: '2024-01-01T00:00:00.000Z',
  phase: 'intake',
  data: { shared: { name: 'Kim' }, modules: {}, activeModules: [] },
};

beforeEach(() => {
  requestJson.mockReset();
});

describe('saveRemoteWorkspace', () => {
  it('posts when creating a new workspace snapshot', async () => {
    requestJson.mockResolvedValue({ items: [] });

    await saveRemoteWorkspace({
      name: 'Snapshot',
      patients: [PATIENT],
      session: SESSION,
    });

    expect(requestJson).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({
      method: 'POST',
      body: { name: 'Snapshot', patients: [PATIENT] },
    }));
  });

  it('uses the authenticated session base URL before stale settings', async () => {
    requestJson.mockResolvedValue({ items: [] });

    await saveRemoteWorkspace({
      name: 'Snapshot',
      patients: [PATIENT],
      session: SESSION,
      settings: { apiBaseUrl: 'https://stale-settings.test' },
    });

    expect(requestJson).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({
      baseUrl: 'https://intranet.test',
    }));
  });

  it('puts when overwriting an existing workspace snapshot', async () => {
    requestJson.mockResolvedValue({ items: [] });

    await saveRemoteWorkspace({
      id: 'workspace-1',
      name: 'Snapshot',
      patients: [PATIENT],
      session: SESSION,
    });

    expect(requestJson).toHaveBeenCalledWith('/api/workspaces/workspace-1', expect.objectContaining({
      method: 'PUT',
      body: { name: 'Snapshot', patients: [PATIENT] },
    }));
  });
});

describe('remote autosave', () => {
  it('loads autosave with a deviceId query parameter', async () => {
    requestJson.mockResolvedValue(null);

    await loadRemoteAutoSave({ session: SESSION });

    expect(requestJson).toHaveBeenCalledWith('/api/autosave?deviceId=device%20abc%2F123', expect.objectContaining({
      session: SESSION,
    }));
  });

  it('saves autosave with a deviceId query parameter', async () => {
    requestJson.mockResolvedValue({ ok: true, savedAt: '2024-01-01T00:00:00.000Z' });

    await saveRemoteAutoSave({ patients: [PATIENT], session: SESSION });

    expect(requestJson).toHaveBeenCalledWith('/api/autosave?deviceId=device%20abc%2F123', expect.objectContaining({
      method: 'PUT',
      body: { patients: [PATIENT] },
    }));
  });

  it('clears autosave with a deviceId query parameter', async () => {
    requestJson.mockResolvedValue({ ok: true });

    await clearRemoteAutoSave({ session: SESSION });

    expect(requestJson).toHaveBeenCalledWith('/api/autosave?deviceId=device%20abc%2F123', expect.objectContaining({
      method: 'DELETE',
      session: SESSION,
    }));
  });
});

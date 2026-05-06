import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveRemoteWorkspace,
} from '../intranetWorkspaceRepository.js';
import { requestJson } from '../httpClient.js';

vi.mock('../httpClient.js', () => ({
  requestJson: vi.fn(),
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

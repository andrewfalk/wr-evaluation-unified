import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRemoteAutoSave,
  loadRemoteAutoSave,
  saveRemoteAutoSave,
  saveRemoteWorkspace,
} from '../intranetWorkspaceRepository.js';
import { requestJson } from '../httpClient.js';
import { clearAllLockTokens, setLockToken } from '../lockTokenStore.js';

vi.mock('../httpClient.js', () => ({
  requestJson: vi.fn(),
}));

vi.mock('../../utils/storage.js', () => ({
  getDeviceId: vi.fn(() => 'device abc/123'),
}));

vi.mock('@contracts/workspace', () => ({
  GetWorkspacesResponseSchema: { parse: value => value },
  // 실제 스키마처럼 ack 필드 기본값([])을 채워 준다.
  SaveWorkspaceResponseSchema: {
    parse: value => ({ saved: [], skipped: [], conflicts: [], lockedByOther: [], ...value }),
  },
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

// PR0-A: saveRemoteWorkspace가 각 환자에 완료 보고 필드를 붙인다(activeModules가 비어
// 있으므로 isPatientComplete는 항상 false).
const PATIENT_WITH_COMPLETION = {
  ...PATIENT,
  modulesCompleteObserved: false,
  completionClientBuildVersion: expect.any(String),
  completionClientSchemaVersion: expect.any(Number),
};

beforeEach(() => {
  requestJson.mockReset();
  clearAllLockTokens();
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
      body: { name: 'Snapshot', patients: [PATIENT_WITH_COMPLETION] },
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

  it('HF1: returns { items, ack } with the per-patient server result', async () => {
    requestJson.mockResolvedValue({
      items: [],
      saved: [{ id: PATIENT.id, revision: 4 }],
      skipped: [{ id: 'p2', reason: 'not_assigned' }],
    });

    const result = await saveRemoteWorkspace({ name: 'Snapshot', patients: [PATIENT], session: SESSION });

    expect(result.items).toEqual([]);
    expect(result.ack).toEqual({
      saved: [{ id: PATIENT.id, revision: 4 }],
      skipped: [{ id: 'p2', reason: 'not_assigned' }],
      conflicts: [],
      lockedByOther: [],
    });
  });

  it('HF1: sends per-patient lease tokens as a top-level lockTokens map, never inside the patient snapshot', async () => {
    requestJson.mockResolvedValue({ items: [] });
    setLockToken(PATIENT.id, 'lease-abc');

    await saveRemoteWorkspace({ name: 'Snapshot', patients: [PATIENT], session: SESSION });

    const body = requestJson.mock.calls[0][1].body;
    expect(body.lockTokens).toEqual({ [PATIENT.id]: 'lease-abc' });
    expect(JSON.stringify(body.patients)).not.toContain('lease-abc');
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
      body: { name: 'Snapshot', patients: [PATIENT_WITH_COMPLETION] },
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

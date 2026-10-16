import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAutoSavedWorkspace,
  loadAutoSavedWorkspace,
  saveAutoSavedWorkspace,
  saveWorkspaceSnapshot,
} from '../workspaceRepository.js';
import {
  clearAutoSave,
  loadAutoSave,
  saveAutoSave,
  savePatientsData,
} from '../../utils/storage.js';
import {
  clearRemoteAutoSave,
  loadRemoteAutoSave,
  saveRemoteAutoSave,
  saveRemoteWorkspace,
} from '../intranetWorkspaceRepository.js';

vi.mock('../../utils/storage.js', () => ({
  clearAutoSave: vi.fn(),
  deleteSavedItem: vi.fn(),
  hasDuplicateName: vi.fn(),
  loadAutoSave: vi.fn(),
  loadSavedItems: vi.fn(),
  loadSettings: vi.fn(),
  loadSettingsAsync: vi.fn(),
  migrateToFileStorage: vi.fn(),
  saveAutoSave: vi.fn(),
  savePatientsData: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('../intranetWorkspaceRepository.js', () => ({
  clearRemoteAutoSave: vi.fn(),
  deleteRemoteWorkspace: vi.fn(),
  loadRemoteAutoSave: vi.fn(),
  loadRemoteWorkspaces: vi.fn(),
  saveRemoteAutoSave: vi.fn(),
  saveRemoteWorkspace: vi.fn(),
}));

vi.mock('../integrationStatus.js', () => ({
  markFallbackIntegrationStatus: vi.fn(),
  markLocalIntegrationStatus: vi.fn(),
  markRemoteIntegrationStatus: vi.fn(),
}));

vi.mock('../patientRecords.js', () => ({
  migratePatientRecords: vi.fn(patients => patients),
}));

const PATIENT = {
  id: 'patient-1',
  data: { shared: { name: 'Kim' }, modules: {}, activeModules: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saveWorkspaceSnapshot — { items, ack } 반환 계약 (HF1)', () => {
  it('원격 저장은 서버의 환자별 ack를 그대로 돌려준다', async () => {
    const remote = { items: [{ id: 'w1' }], ack: { saved: [{ id: 'patient-1', revision: 2 }], skipped: [], conflicts: [], lockedByOther: [] } };
    saveRemoteWorkspace.mockResolvedValue(remote);

    const result = await saveWorkspaceSnapshot({
      name: 'ws', patients: [PATIENT], savedItems: [],
      session: { mode: 'intranet', user: { id: 'user-1' } }, settings: {},
    });

    expect(result).toBe(remote);
  });

  it('로컬 저장은 환자별 서버 결과가 없으므로 ack가 null이다', async () => {
    savePatientsData.mockResolvedValue([{ id: 'local-1' }]);

    const result = await saveWorkspaceSnapshot({
      name: 'ws', patients: [PATIENT], savedItems: [],
      session: { mode: 'local', user: { id: 'user-1' } }, settings: { integrationMode: 'local' },
    });

    expect(result).toEqual({ items: [{ id: 'local-1' }], ack: null });
    expect(saveRemoteWorkspace).not.toHaveBeenCalled();
  });
});

describe('workspace autosave repository policy', () => {
  it('does not load remote or local autosave in intranet session mode', async () => {
    const result = await loadAutoSavedWorkspace({
      session: { mode: 'intranet', user: { id: 'user-1' } },
      settings: { integrationMode: 'local' },
    });

    expect(result).toBeNull();
    expect(loadRemoteAutoSave).not.toHaveBeenCalled();
    expect(loadAutoSave).not.toHaveBeenCalled();
  });

  it('does not save remote or local autosave when intranet integration is selected', async () => {
    const result = await saveAutoSavedWorkspace({
      patients: [PATIENT],
      session: { mode: 'local', user: { id: 'user-1' } },
      settings: { integrationMode: 'intranet' },
    });

    expect(result).toBeNull();
    expect(saveRemoteAutoSave).not.toHaveBeenCalled();
    expect(saveAutoSave).not.toHaveBeenCalled();
  });

  it('keeps autosave clear active in intranet mode', async () => {
    clearRemoteAutoSave.mockResolvedValue({ ok: true });

    const result = await clearAutoSavedWorkspace({
      session: { mode: 'intranet', user: { id: 'user-1' } },
      settings: { integrationMode: 'intranet' },
    });

    expect(result).toEqual({ ok: true });
    expect(clearRemoteAutoSave).toHaveBeenCalledTimes(1);
    expect(clearAutoSave).not.toHaveBeenCalled();
  });
});

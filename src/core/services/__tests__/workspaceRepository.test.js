import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAutoSavedWorkspace,
  loadAutoSavedWorkspace,
  saveAutoSavedWorkspace,
} from '../workspaceRepository.js';
import {
  clearAutoSave,
  loadAutoSave,
  saveAutoSave,
} from '../../utils/storage.js';
import {
  clearRemoteAutoSave,
  loadRemoteAutoSave,
  saveRemoteAutoSave,
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

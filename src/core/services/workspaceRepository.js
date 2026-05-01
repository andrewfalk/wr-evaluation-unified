import {
  clearAutoSave,
  deleteSavedItem,
  hasDuplicateName,
  loadAutoSave,
  loadSavedItems,
  loadSettings,
  loadSettingsAsync,
  migrateToFileStorage,
  saveAutoSave,
  savePatientsData,
  saveSettings,
} from '../utils/storage';
import {
  clearRemoteAutoSave,
  deleteRemoteWorkspace,
  loadRemoteAutoSave,
  loadRemoteWorkspaces,
  saveRemoteAutoSave,
  saveRemoteWorkspace,
} from './intranetWorkspaceRepository';
import {
  markFallbackIntegrationStatus,
  markLocalIntegrationStatus,
  markRemoteIntegrationStatus,
} from './integrationStatus';
import { migratePatientRecords } from './patientRecords';

// This repository keeps the current local/Electron implementation,
// while giving us a single seam to replace with intranet APIs later.
function shouldUseRemoteRepository({ session, settings } = {}) {
  return settings?.integrationMode === 'intranet' || session?.mode === 'intranet';
}

// Errors that indicate "endpoint not implemented yet" — safe to fall back to local.
// Auth failures (401/403), server errors (500/502), and contract violations are
// intentionally excluded so they surface to the user rather than silently degrading.
function isFallbackEligibleError(error) {
  return !error?.status || error.status === 404 || error.status === 405 || error.status === 501;
}

function shouldFallbackToLocal(error, options = {}) {
  // In remote mode: require both explicit server permission AND an eligible error type.
  // localFallbackAllowed=true with a 401/500 still surfaces the error — preventing
  // auth failures and contract violations from being silently hidden in local storage.
  if (shouldUseRemoteRepository(options)) {
    return options?.serverConfig?.localFallbackAllowed === true
      && isFallbackEligibleError(error);
  }
  return isFallbackEligibleError(error);
}

export async function loadSavedWorkspaces(options = {}) {
  if (shouldUseRemoteRepository(options)) {
    try {
      const items = await loadRemoteWorkspaces(options);
      markRemoteIntegrationStatus({ ...options, source: 'workspace-load' });
      return items;
    } catch (error) {
      markFallbackIntegrationStatus(error, { ...options, source: 'workspace-load' });
      if (!shouldFallbackToLocal(error, options)) throw error;
      console.warn('[workspaceRepository] Falling back to local workspace storage:', error.message);
    }
  } else {
    markLocalIntegrationStatus({ ...options, source: 'workspace-load' });
  }

  const items = await loadSavedItems();
  return items.map(item => ({
    ...item,
    patients: migratePatientRecords(item.patients || [], options),
  }));
}

export async function saveWorkspaceSnapshot({ name, patients, savedItems, ...options }) {
  if (shouldUseRemoteRepository(options)) {
    try {
      const items = await saveRemoteWorkspace({ name, patients, ...options });
      markRemoteIntegrationStatus({ ...options, source: 'workspace-save' });
      return items;
    } catch (error) {
      markFallbackIntegrationStatus(error, { ...options, source: 'workspace-save' });
      if (!shouldFallbackToLocal(error, options)) throw error;
      console.warn('[workspaceRepository] Falling back to local workspace save:', error.message);
    }
  } else {
    markLocalIntegrationStatus({ ...options, source: 'workspace-save' });
  }

  return savePatientsData(name, patients, savedItems);
}

export async function deleteWorkspaceSnapshot({ id, savedItems, ...options }) {
  if (shouldUseRemoteRepository(options)) {
    try {
      const items = await deleteRemoteWorkspace({ id, ...options });
      markRemoteIntegrationStatus({ ...options, source: 'workspace-delete' });
      return items;
    } catch (error) {
      markFallbackIntegrationStatus(error, { ...options, source: 'workspace-delete' });
      if (!shouldFallbackToLocal(error, options)) throw error;
      console.warn('[workspaceRepository] Falling back to local workspace delete:', error.message);
    }
  } else {
    markLocalIntegrationStatus({ ...options, source: 'workspace-delete' });
  }

  return deleteSavedItem(id, savedItems);
}

export function hasDuplicateWorkspaceName(name, savedItems) {
  return hasDuplicateName(name, savedItems);
}

export async function loadAutoSavedWorkspace(options = {}) {
  if (shouldUseRemoteRepository(options)) {
    try {
      const saved = await loadRemoteAutoSave(options);
      markRemoteIntegrationStatus({ ...options, source: 'autosave-load' });
      return saved;
    } catch (error) {
      markFallbackIntegrationStatus(error, { ...options, source: 'autosave-load' });
      if (!shouldFallbackToLocal(error, options)) throw error;
      console.warn('[workspaceRepository] Falling back to local autosave load:', error.message);
    }
  } else {
    markLocalIntegrationStatus({ ...options, source: 'autosave-load' });
  }

  const saved = await loadAutoSave();
  if (!saved?.patients) return saved;
  return {
    ...saved,
    patients: migratePatientRecords(saved.patients, options),
  };
}

export async function saveAutoSavedWorkspace({ patients, ...options }) {
  if (shouldUseRemoteRepository(options)) {
    try {
      const result = await saveRemoteAutoSave({ patients, ...options });
      markRemoteIntegrationStatus({ ...options, source: 'autosave-save' });
      return result;
    } catch (error) {
      markFallbackIntegrationStatus(error, { ...options, source: 'autosave-save' });
      if (!shouldFallbackToLocal(error, options)) throw error;
      console.warn('[workspaceRepository] Falling back to local autosave save:', error.message);
    }
  } else {
    markLocalIntegrationStatus({ ...options, source: 'autosave-save' });
  }

  return saveAutoSave(patients);
}

export async function clearAutoSavedWorkspace(options = {}) {
  if (shouldUseRemoteRepository(options)) {
    try {
      const result = await clearRemoteAutoSave(options);
      markRemoteIntegrationStatus({ ...options, source: 'autosave-clear' });
      return result;
    } catch (error) {
      markFallbackIntegrationStatus(error, { ...options, source: 'autosave-clear' });
      if (!shouldFallbackToLocal(error, options)) throw error;
      console.warn('[workspaceRepository] Falling back to local autosave clear:', error.message);
    }
  } else {
    markLocalIntegrationStatus({ ...options, source: 'autosave-clear' });
  }

  return clearAutoSave();
}

export function loadAppSettings(defaults) {
  return loadSettings(defaults);
}

export async function loadAppSettingsAsync(defaults) {
  return loadSettingsAsync(defaults);
}

export async function saveAppSettings(settings) {
  return saveSettings(settings);
}

export async function migrateWorkspaceStorage() {
  return migrateToFileStorage();
}

import { requestJson } from './httpClient';
import { migratePatientRecords } from './patientRecords';

function normalizeSavedItems(items = [], context = {}) {
  return items.map(item => ({
    ...item,
    patients: migratePatientRecords(item.patients || [], context),
  }));
}

export async function loadRemoteWorkspaces({ session, settings }) {
  const data = await requestJson('/api/workspaces', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    session,
  });
  return normalizeSavedItems(Array.isArray(data?.items) ? data.items : [], { session });
}

export async function saveRemoteWorkspace({ name, patients, session, settings }) {
  const data = await requestJson('/api/workspaces', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method: 'POST',
    session,
    body: { name, patients },
  });
  return normalizeSavedItems(Array.isArray(data?.items) ? data.items : [], { session });
}

export async function deleteRemoteWorkspace({ id, session, settings }) {
  const data = await requestJson(`/api/workspaces/${id}`, {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method: 'DELETE',
    session,
  });
  return normalizeSavedItems(Array.isArray(data?.items) ? data.items : [], { session });
}

export async function loadRemoteAutoSave({ session, settings }) {
  const data = await requestJson('/api/autosave', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    session,
  });

  if (!data?.patients) return data || null;
  return {
    ...data,
    patients: migratePatientRecords(data.patients, { session }),
  };
}

export async function saveRemoteAutoSave({ patients, session, settings }) {
  return requestJson('/api/autosave', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method: 'PUT',
    session,
    body: { patients },
  });
}

export async function clearRemoteAutoSave({ session, settings }) {
  return requestJson('/api/autosave', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method: 'DELETE',
    session,
  });
}

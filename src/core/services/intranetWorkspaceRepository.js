import { requestJson } from './httpClient';
import { migratePatientRecords } from './patientRecords';
import {
  GetWorkspacesResponseSchema,
} from '@contracts/workspace';
import {
  GetAutosaveResponseSchema,
  PutAutosaveResponseSchema,
  DeleteAutosaveResponseSchema,
} from '@contracts/autosave';

// Wraps schema.parse() so ZodErrors get status=502 + code='CONTRACT_VIOLATION'.
// Without this, shouldFallbackToLocal() in workspaceRepository treats ZodErrors
// as network errors (no .status) and silently falls back to local storage.
function parseResponse(schema, raw, endpoint) {
  try {
    return schema.parse(raw);
  } catch (e) {
    if (e?.name === 'ZodError') {
      const wrapped = new Error(
        `[intranet] Contract violation at ${endpoint}: ${e.issues[0]?.message ?? 'invalid response'}`
      );
      wrapped.status = 502;
      wrapped.code = 'CONTRACT_VIOLATION';
      wrapped.cause = e;
      throw wrapped;
    }
    throw e;
  }
}

function normalizeSavedItems(items = [], context = {}) {
  return items.map(item => ({
    ...item,
    patients: migratePatientRecords(item.patients || [], context),
  }));
}

export async function loadRemoteWorkspaces({ session, settings }) {
  const raw = await requestJson('/api/workspaces', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    session,
  });
  const data = parseResponse(GetWorkspacesResponseSchema, raw, 'GET /api/workspaces');
  return normalizeSavedItems(data.items, { session });
}

export async function saveRemoteWorkspace({ id, name, patients, session, settings }) {
  const path = id ? `/api/workspaces/${id}` : '/api/workspaces';
  const method = id ? 'PUT' : 'POST';
  const raw = await requestJson(path, {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method,
    session,
    body: { name, patients },
  });
  const data = parseResponse(GetWorkspacesResponseSchema, raw, `${method} ${path}`);
  return normalizeSavedItems(data.items, { session });
}

export async function deleteRemoteWorkspace({ id, session, settings }) {
  const raw = await requestJson(`/api/workspaces/${id}`, {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method: 'DELETE',
    session,
  });
  const data = parseResponse(GetWorkspacesResponseSchema, raw, `DELETE /api/workspaces/${id}`);
  return normalizeSavedItems(data.items, { session });
}

export async function loadRemoteAutoSave({ session, settings }) {
  const raw = await requestJson('/api/autosave', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    session,
  });
  const data = parseResponse(GetAutosaveResponseSchema, raw, 'GET /api/autosave');
  if (!data?.patients) return data || null;
  return {
    ...data,
    patients: migratePatientRecords(data.patients, { session }),
  };
}

export async function saveRemoteAutoSave({ patients, session, settings }) {
  const raw = await requestJson('/api/autosave', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method: 'PUT',
    session,
    body: { patients },
  });
  return parseResponse(PutAutosaveResponseSchema, raw, 'PUT /api/autosave');
}

export async function clearRemoteAutoSave({ session, settings }) {
  const raw = await requestJson('/api/autosave', {
    baseUrl: settings?.apiBaseUrl || session?.apiBaseUrl || '',
    method: 'DELETE',
    session,
  });
  return parseResponse(DeleteAutosaveResponseSchema, raw, 'DELETE /api/autosave');
}

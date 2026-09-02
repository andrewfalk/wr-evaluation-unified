import { requestJson } from './httpClient';
import { migratePatientRecords } from './patientRecords';
import { getDeviceId } from '../utils/storage';
import { completionReportFields } from '../utils/patientCompletion';
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

function autosavePath() {
  return `/api/autosave?deviceId=${encodeURIComponent(getDeviceId())}`;
}

function getBaseUrl(session, settings) {
  return session?.apiBaseUrl || settings?.apiBaseUrl || '';
}

export async function loadRemoteWorkspaces({ session, settings }) {
  const raw = await requestJson('/api/workspaces', {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  const data = parseResponse(GetWorkspacesResponseSchema, raw, 'GET /api/workspaces');
  return normalizeSavedItems(data.items, { session });
}

// PR0-A: workspace 저장도 patient_records를 직접 갱신하는 경로라(server/src/routes/workspaces.ts
// upsertPatientRecordInTx) PATCH/POST와 동일하게 완료 보고를 실어보내야 한다 — 안 그러면 이
// 경로로만 저장된, 실제로는 완료된 환자가 completion_status='draft'로 영구히 남는다. 필드는
// 각 환자 객체 최상위(payload 밖)에 붙인다 — 서버의 extractPatientMeta가 거기서 읽는다.
function withCompletionReport(patient) {
  return { ...patient, ...completionReportFields(patient) };
}

export async function saveRemoteWorkspace({ id, name, patients, session, settings }) {
  const path = id ? `/api/workspaces/${id}` : '/api/workspaces';
  const method = id ? 'PUT' : 'POST';
  const raw = await requestJson(path, {
    baseUrl: getBaseUrl(session, settings),
    method,
    session,
    body: { name, patients: patients.map(withCompletionReport) },
  });
  const data = parseResponse(GetWorkspacesResponseSchema, raw, `${method} ${path}`);
  return normalizeSavedItems(data.items, { session });
}

export async function deleteRemoteWorkspace({ id, session, settings }) {
  const raw = await requestJson(`/api/workspaces/${id}`, {
    baseUrl: getBaseUrl(session, settings),
    method: 'DELETE',
    session,
  });
  const data = parseResponse(GetWorkspacesResponseSchema, raw, `DELETE /api/workspaces/${id}`);
  return normalizeSavedItems(data.items, { session });
}

export async function loadRemoteAutoSave({ session, settings }) {
  const path = autosavePath();
  const raw = await requestJson(path, {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  const data = parseResponse(GetAutosaveResponseSchema, raw, `GET ${path}`);
  if (!data?.patients) return data || null;
  return {
    ...data,
    patients: migratePatientRecords(data.patients, { session }),
  };
}

export async function saveRemoteAutoSave({ patients, session, settings }) {
  const path = autosavePath();
  const raw = await requestJson(path, {
    baseUrl: getBaseUrl(session, settings),
    method: 'PUT',
    session,
    body: { patients },
  });
  return parseResponse(PutAutosaveResponseSchema, raw, `PUT ${path}`);
}

export async function clearRemoteAutoSave({ session, settings }) {
  const path = autosavePath();
  const raw = await requestJson(path, {
    baseUrl: getBaseUrl(session, settings),
    method: 'DELETE',
    session,
  });
  return parseResponse(DeleteAutosaveResponseSchema, raw, `DELETE ${path}`);
}

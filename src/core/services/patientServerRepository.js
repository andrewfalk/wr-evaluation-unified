import { requestJson } from './httpClient';
import { isRedactedPatientRecord } from './patientRecords';

function getBaseUrl(session, settings) {
  return settings?.apiBaseUrl || session?.apiBaseUrl || '';
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

// The server's toResponse() spreads the stored payload and overlays id + sync.
// When we POST a new patient, we send our local UUID as the body id so the server
// stores it as its own id — meaning serverPatient.id === localPatient.id after a push.
// On pull (records created on another device), localId may differ; callers pass null.
function applyServerSync(serverPatient, localId = null, localMeta = undefined) {
  const mapped = {
    ...serverPatient,
    id: localId ?? serverPatient.id,
  };
  if (mapped.meta === undefined && localMeta !== undefined) {
    mapped.meta = localMeta;
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Pull — GET /api/patients
// Returns { items: Patient[], total: number }
// Accepted params: q, diagnosesCode, jobName, module, limit, offset
// ---------------------------------------------------------------------------
export async function pullPatients({ session, settings, params = {} } = {}) {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  );
  const path = `/api/patients${qs.toString() ? `?${qs}` : ''}`;
  const data = await requestJson(path, {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  return {
    items: (data.items ?? []).map(p => applyServerSync(p)),
    total: data.total ?? data.items?.length ?? 0,
  };
}

export async function fetchPatient(serverId, { session, settings } = {}) {
  const data = await requestJson(`/api/patients/${serverId}`, {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  return applyServerSync(data);
}

// ---------------------------------------------------------------------------
// Push — POST /api/patients (local-only) or PATCH /api/patients/:id (dirty)
// Returns the updated patient with server sync fields applied.
// Throws with error.status === 409 on revision conflict or identity conflict.
// ---------------------------------------------------------------------------
export async function pushPatient(patient, { session, settings } = {}) {
  if (isRedactedPatientRecord(patient)) {
    throw new Error('Cannot push a redacted patient snapshot stub.');
  }
  const base = getBaseUrl(session, settings);
  const serverId = patient.sync?.serverId ?? null;
  const revision = patient.sync?.revision;

  if (!serverId) {
    if (!patient.id) {
      const err = new Error('POST /api/patients requires patient.id for Idempotency-Key.');
      err.status = 400;
      throw err;
    }
    const data = await requestJson('/api/patients', {
      baseUrl: base,
      method:  'POST',
      session,
      headers: { 'Idempotency-Key': patient.id },
      body: {
        id:        patient.id,
        phase:     patient.phase,
        createdAt: patient.createdAt,
        data:      patient.data,
      },
    });
    return applyServerSync(data, patient.id, patient.meta);
  }

  if (!Number.isInteger(revision) || revision < 1) {
    const err = new Error(`PATCH /api/patients/:id requires a positive integer revision for If-Match (got ${revision}).`);
    err.status = 400;
    throw err;
  }
  const data = await requestJson(`/api/patients/${serverId}`, {
    baseUrl: base,
    method:  'PATCH',
    session,
    headers: { 'If-Match': String(revision) },
    body: {
      phase: patient.phase,
      data:  patient.data,
    },
  });
  return applyServerSync(data, patient.id, patient.meta);
}

// ---------------------------------------------------------------------------
// Delete — DELETE /api/patients/:id?revision=N (soft-delete on server)
// Only call this when the patient has a serverId. For local-only patients,
// just remove from local state without calling the server.
// Throws with status 409 on revision mismatch.
// ---------------------------------------------------------------------------
export async function deletePatientOnServer(serverId, revision, { session, settings } = {}) {
  if (!serverId) {
    const err = new Error('DELETE /api/patients requires a serverId.');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(revision) || revision < 1) {
    const err = new Error(`DELETE /api/patients/:id requires a positive integer revision (?revision=N, got ${revision}).`);
    err.status = 400;
    throw err;
  }
  await requestJson(`/api/patients/${serverId}?revision=${revision}`, {
    baseUrl: getBaseUrl(session, settings),
    method:  'DELETE',
    session,
  });
}

// ---------------------------------------------------------------------------
// Batch push — send all 'local-only' and 'dirty' patients to the server.
// 'conflict' patients are skipped — they must be resolved via ConflictResolveModal first.
// 'synced' patients are skipped — no changes to push.
// Returns { synced: Patient[], failed: { patient, error }[] }
// ---------------------------------------------------------------------------
export async function pushPendingPatients(patients, { session, settings } = {}) {
  const pending = patients.filter(p => {
    if (isRedactedPatientRecord(p)) return false;
    const s = p.sync?.syncStatus;
    return s === 'local-only' || s === 'dirty';
  });

  const results = await Promise.allSettled(
    pending.map(p => pushPatient(p, { session, settings }))
  );

  const synced = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      synced.push(r.value);
    } else {
      failed.push({
        patient: pending[i],
        error:   r.reason,
        kind:    isConflictError(r.reason) ? 'conflict' : 'error',
      });
    }
  });

  return { synced, failed };
}

export function isConflictError(error) {
  return error?.status === 409;
}

// ---------------------------------------------------------------------------
// Merge helpers — apply a server patient back into the local array.
//
// Match priority:
//   1. patient.id === serverPatient.id  (typical after push — same UUID)
//   2. patient.sync.serverId === serverPatient.sync.serverId  (pull path)
// If no match is found the server patient is appended (created on another device).
// The local patient's own id is always preserved on match.
// ---------------------------------------------------------------------------
export function mergeServerPatient(localPatients, serverPatient) {
  const serverId = serverPatient.sync?.serverId ?? serverPatient.id;
  const idx = localPatients.findIndex(
    p => p.id === serverPatient.id || (p.sync?.serverId && p.sync.serverId === serverId)
  );

  if (idx === -1) {
    return [...localPatients, serverPatient];
  }

  const local = localPatients[idx];
  const localStatus = local.sync?.syncStatus;
  const localRevision = local.sync?.revision ?? 0;
  const serverRevision = serverPatient.sync?.revision ?? 0;

  if (localStatus === 'dirty') {
    const merged = serverRevision > localRevision
      ? markPullConflict(local, serverPatient)
      : local;
    return localPatients.map((p, i) => (i === idx ? merged : p));
  }

  if (localStatus === 'conflict') {
    const merged = markPullConflict(local, serverPatient);
    return localPatients.map((p, i) => (i === idx ? merged : p));
  }

  const merged = applyServerSync(serverPatient, local.id, local.meta);
  return localPatients.map((p, i) => (i === idx ? merged : p));
}

function markPullConflict(localPatient, serverPatient) {
  const existingConflict = localPatient.sync?.conflict || {};
  return {
    ...localPatient,
    sync: {
      ...(localPatient.sync || {}),
      syncStatus: 'conflict',
      conflict: {
        ...existingConflict,
        kind: existingConflict.kind || 'pull',
        serverPatient,
        serverRevision: serverPatient.sync?.revision ?? null,
      },
    },
  };
}

export function mergePulledPatients(localPatients, pulledItems) {
  let result = localPatients;
  for (const serverPatient of pulledItems) {
    result = mergeServerPatient(result, serverPatient);
  }
  return result;
}

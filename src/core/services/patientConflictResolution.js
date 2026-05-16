import { createPatientSyncState } from './patientRecords';

function dropConflict(sync = {}) {
  const { conflict: _conflict, ...rest } = sync || {};
  return rest;
}

function getConflict(patient) {
  return patient?.sync?.conflict || {};
}

function getLatestRevision(patient, serverPatient) {
  const conflict = getConflict(patient);
  return (
    serverPatient?.sync?.revision
    ?? conflict.serverRevision
    ?? patient?.sync?.revision
    ?? 0
  );
}

function getServerId(patient, serverPatient) {
  return serverPatient?.sync?.serverId || patient?.sync?.serverId || serverPatient?.id || null;
}

function applyServerVersion(localPatient, serverPatient) {
  if (!serverPatient) return null;
  return {
    ...serverPatient,
    id: localPatient.id,
    meta: localPatient.meta ?? serverPatient.meta,
  };
}

function applyLocalVersion(localPatient, serverPatient, options = {}) {
  const conflictKind = getConflict(localPatient).kind;

  if (conflictKind === 'delete') {
    return null;
  }

  if (conflictKind === 'remote-delete') {
    return {
      ...localPatient,
      id: options.newId || localPatient.id,
      sync: createPatientSyncState(),
    };
  }

  return {
    ...localPatient,
    sync: {
      ...dropConflict(localPatient.sync),
      serverId: getServerId(localPatient, serverPatient),
      revision: getLatestRevision(localPatient, serverPatient),
      syncStatus: 'dirty',
      lastSyncedAt: localPatient.sync?.lastSyncedAt ?? null,
    },
  };
}

function applyMergedVersion(localPatient, serverPatient, mergedData, options = {}) {
  const conflictKind = getConflict(localPatient).kind;

  if (conflictKind === 'remote-delete') {
    return {
      ...localPatient,
      id: options.newId || localPatient.id,
      data: mergedData,
      sync: createPatientSyncState(),
    };
  }

  return {
    ...localPatient,
    data: mergedData,
    sync: {
      ...dropConflict(localPatient.sync),
      serverId: getServerId(localPatient, serverPatient),
      revision: getLatestRevision(localPatient, serverPatient),
      syncStatus: 'dirty',
      lastSyncedAt: localPatient.sync?.lastSyncedAt ?? null,
    },
  };
}

export function resolvePatientConflictInList(
  patients,
  patientId,
  resolution,
  { serverPatient = null, mergedData = null, newId = null } = {}
) {
  return patients.flatMap(patient => {
    if (patient.id !== patientId) return [patient];

    if (resolution === 'use-local') {
      const resolved = applyLocalVersion(patient, serverPatient, { newId });
      return resolved ? [resolved] : [];
    }

    if (resolution === 'use-server') {
      const resolved = applyServerVersion(patient, serverPatient);
      return resolved ? [resolved] : [];
    }

    if (resolution === 'merge') {
      const resolved = applyMergedVersion(patient, serverPatient, mergedData, { newId });
      return resolved ? [resolved] : [];
    }

    return [patient];
  });
}


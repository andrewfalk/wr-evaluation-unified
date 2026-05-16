import { createPatient as createBasePatient, migratePatient } from '../utils/data';

export const DEFAULT_PATIENT_SYNC = {
  serverId: null,
  revision: 0,
  syncStatus: 'local-only',
  lastSyncedAt: null,
};

const EDIT_RESOLVABLE_PUSH_CONFLICT_CODES = new Set([
  'PATIENT_IDENTITY_CONFLICT',
  'PATIENT_PERSON_CONFLICT',
]);

function resolveContextUser(context = {}) {
  if (context?.user) return context.user;
  if (context?.session?.user) return context.session.user;
  return null;
}

function getRuntimeSource(context = {}) {
  if (context?.source) return context.source;
  if (typeof window !== 'undefined' && window.electron) return 'electron';
  return 'web';
}

export function createPatientMeta(context = {}) {
  const user = resolveContextUser(context);
  return {
    organizationId: user?.organizationId || null,
    ownerUserId: user?.id || null,
    createdBy: user?.id || null,
    updatedBy: user?.id || null,
    authMode: context?.session?.mode || context?.mode || 'local',
    source: getRuntimeSource(context),
  };
}

export function createPatientSyncState(overrides = {}) {
  return {
    ...DEFAULT_PATIENT_SYNC,
    ...overrides,
  };
}

export function ensurePatientMetadata(patient, context = {}) {
  if (!patient || typeof patient !== 'object') return patient;
  if (isRedactedPatientRecord(patient)) return patient;
  return {
    ...patient,
    meta: {
      ...createPatientMeta(context),
      ...(patient.meta || {}),
    },
    sync: {
      ...createPatientSyncState(),
      ...(patient.sync || {}),
    },
  };
}

export function isRedactedPatientRecord(patient) {
  return Boolean(patient && typeof patient === 'object' && patient.redacted === true);
}

export function createManagedPatient(activeModules = [], modulesData = {}, context = {}) {
  return ensurePatientMetadata(createBasePatient(activeModules, modulesData), context);
}

export function migratePatientRecord(patient, context = {}) {
  if (isRedactedPatientRecord(patient)) return patient;
  return ensurePatientMetadata(migratePatient(patient), context);
}

export function migratePatientRecords(patients = [], context = {}) {
  return (patients || []).map(patient => migratePatientRecord(patient, context));
}

function shouldClearConflictOnEdit(sync = {}) {
  return (
    sync.syncStatus === 'conflict'
    && sync.conflict?.kind === 'push'
    && EDIT_RESOLVABLE_PUSH_CONFLICT_CODES.has(sync.conflict?.code)
  );
}

export function touchPatientRecord(patient, context = {}) {
  if (isRedactedPatientRecord(patient)) return patient;
  const user = resolveContextUser(context);
  const ensured = ensurePatientMetadata(patient, context);
  const clearConflict = shouldClearConflictOnEdit(ensured.sync);
  const { conflict: _conflict, ...syncWithoutConflict } = ensured.sync || {};
  const baseSync = clearConflict ? syncWithoutConflict : ensured.sync;
  const nextSyncStatus = ensured.sync.serverId
    ? (ensured.sync.syncStatus === 'conflict' && !clearConflict ? 'conflict' : 'dirty')
    : (clearConflict ? 'local-only' : (ensured.sync.syncStatus || 'local-only'));

  return {
    ...ensured,
    meta: {
      ...ensured.meta,
      organizationId: ensured.meta.organizationId || user?.organizationId || null,
      ownerUserId: ensured.meta.ownerUserId || user?.id || null,
      updatedBy: user?.id || ensured.meta.updatedBy || ensured.meta.createdBy || null,
    },
    sync: {
      ...baseSync,
      syncStatus: nextSyncStatus,
    },
  };
}

export function clonePatientRecordForImport(patient, context = {}) {
  if (isRedactedPatientRecord(patient)) return null;
  const cloned = JSON.parse(JSON.stringify(migratePatientRecord(patient, context)));
  const user = resolveContextUser(context);

  return {
    ...cloned,
    id: crypto.randomUUID(),
    meta: {
      ...cloned.meta,
      organizationId: user?.organizationId || cloned.meta.organizationId || null,
      ownerUserId: user?.id || cloned.meta.ownerUserId || null,
      createdBy: user?.id || cloned.meta.createdBy || null,
      updatedBy: user?.id || cloned.meta.updatedBy || cloned.meta.createdBy || null,
    },
    sync: createPatientSyncState(),
  };
}

import { loadAutoSave, loadSavedItems } from '../utils/storage';
import { isRedactedPatientRecord } from './patientRecords';
import { pushPatient } from './patientServerRepository';

// ---------------------------------------------------------------------------
// Error types — the renderer/UI distinguishes user-canceled vs permission-denied
// vs read-failed so it can show appropriate messaging.
// ---------------------------------------------------------------------------
export class MigrationCanceledError extends Error {
  constructor(message = 'Migration canceled by user') {
    super(message);
    this.name = 'MigrationCanceledError';
  }
}

export class MigrationDeniedError extends Error {
  constructor(reason) {
    super(`Migration denied: ${reason}`);
    this.name = 'MigrationDeniedError';
    this.reason = reason;
  }
}

export class MigrationReadError extends Error {
  constructor(detail) {
    super(`Failed to read local migration data: ${detail}`);
    this.name = 'MigrationReadError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Merge helpers
// Priority (later overrides earlier): savedItems → indexedPatients → autoSave
// "Closer to the current local working state wins."
// ---------------------------------------------------------------------------
function pushIntoMap(byId, list) {
  for (const p of list ?? []) {
    if (p && !isRedactedPatientRecord(p) && p.id) {
      byId.set(p.id, p);
    }
  }
}

export function mergePatientsFromSnapshot(snapshot) {
  const byId = new Map();
  // savedItems: workspace snapshots — lowest priority
  for (const item of snapshot?.savedItems ?? []) {
    pushIntoMap(byId, item?.patients ?? []);
  }
  // indexedPatients: per-patient files listed in index.json — middle priority
  pushIntoMap(byId, snapshot?.indexedPatients);
  // autoSave: current session — highest priority, overrides earlier sources
  pushIntoMap(byId, snapshot?.autoSave?.patients ?? []);
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// Collection — gather all unique local patients.
// Intranet build: when window.electron.loadLocalMigrationData exists, use it
// exclusively. No silent fallback — denied/error must surface.
// Standalone / legacy: fall back to storage utilities (which themselves prefer
// fs-* IPCs and otherwise read localStorage).
// ---------------------------------------------------------------------------
export async function collectLocalPatients() {
  const ipc = typeof window !== 'undefined'
    ? window.electron?.loadLocalMigrationData
    : undefined;

  if (typeof ipc === 'function') {
    const snapshot = await ipc();
    if (snapshot?.denied) {
      if (snapshot.reason === 'user_canceled') throw new MigrationCanceledError();
      throw new MigrationDeniedError(snapshot.reason || 'denied');
    }
    if (snapshot?.error) {
      throw new MigrationReadError(snapshot.error);
    }
    return mergePatientsFromSnapshot(snapshot ?? {});
  }

  const byId = new Map();
  const savedItems = await loadSavedItems();
  for (const item of savedItems) {
    pushIntoMap(byId, item?.patients ?? []);
  }
  const autoSave = await loadAutoSave();
  pushIntoMap(byId, autoSave?.patients ?? []);
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// Push — send local-only patients to the server via POST + Idempotency-Key.
// Patients that already have a serverId were previously synced and are
// returned in `alreadySynced` without re-posting.
// Returns { migrated, failed, alreadySynced }
// ---------------------------------------------------------------------------
export async function migrateToServer(patients, { session, settings } = {}) {
  const toMigrate   = [];
  const alreadySynced = [];

  for (const p of patients) {
    if (p.sync?.serverId) {
      alreadySynced.push(p);
    } else {
      toMigrate.push(p);
    }
  }

  const results = await Promise.allSettled(
    toMigrate.map(p => pushPatient(p, { session, settings }))
  );

  const migrated = [];
  const failed   = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      migrated.push(r.value);
    } else {
      failed.push({ patient: toMigrate[i], error: r.reason });
    }
  });

  return { migrated, failed, alreadySynced };
}

// ---------------------------------------------------------------------------
// Main entry — collect from local sources then push to server.
// Safe to call multiple times: Idempotency-Key prevents duplicate records,
// and already-synced patients are skipped.
// May throw MigrationCanceledError / MigrationDeniedError / MigrationReadError
// during the collect phase — caller decides how to surface each.
// ---------------------------------------------------------------------------
export async function runMigration({ session, settings } = {}) {
  const patients = await collectLocalPatients();
  return migrateToServer(patients, { session, settings });
}

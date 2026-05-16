import { loadAutoSave, loadSavedItems } from '../utils/storage';
import { isRedactedPatientRecord } from './patientRecords';
import { pushPatient } from './patientServerRepository';
import {
  fetchServerPresets,
  createServerPreset,
  normalizePresetRecord,
  buildPresetIdentity,
} from './presetRepository';

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
// Collection — gather all unique local patients and presets.
// Intranet build: when window.electron.loadLocalMigrationData exists, use it
// exclusively. No silent fallback — denied/error must surface.
// Standalone / legacy: fall back to storage utilities (which themselves prefer
// fs-* IPCs and otherwise read localStorage).
// ---------------------------------------------------------------------------

// PRIVATE — only runMigration() should call this directly.
// Calling collectLocalPatients() and collectLocalPresets() separately would
// invoke the IPC (and show the native confirm dialog) twice.
async function collectLocalSnapshot() {
  const ipc = typeof window !== 'undefined'
    ? window.electron?.loadLocalMigrationData
    : undefined;

  if (typeof ipc !== 'function') return null; // standalone: no IPC

  const snapshot = await ipc();
  if (snapshot?.denied) {
    if (snapshot.reason === 'user_canceled') throw new MigrationCanceledError();
    throw new MigrationDeniedError(snapshot.reason || 'denied');
  }
  if (snapshot?.error) throw new MigrationReadError(snapshot.error);
  return snapshot ?? {};
}

export async function collectLocalPatients() {
  const snapshot = await collectLocalSnapshot();
  if (snapshot === null) {
    // standalone fallback
    const byId = new Map();
    const savedItems = await loadSavedItems();
    for (const item of savedItems) {
      pushIntoMap(byId, item?.patients ?? []);
    }
    const autoSave = await loadAutoSave();
    pushIntoMap(byId, autoSave?.patients ?? []);
    return Array.from(byId.values());
  }
  return mergePatientsFromSnapshot(snapshot);
}

// ---------------------------------------------------------------------------
// Push — send local-only patients to the server via POST + Idempotency-Key.
// Patients that already have a serverId were previously synced and are
// returned in `alreadySynced` without re-posting.
// Returns { migrated, failed, alreadySynced }
// ---------------------------------------------------------------------------
// Stamp the current session user's name into data.shared.doctorName so the
// server's resolveAssignedDoctor can match the patient to the logged-in doctor.
// Standalone patients carry whatever name was typed locally; if that name doesn't
// exactly match any server account the server leaves assigned_doctor_user_id null,
// which makes the patient invisible under scope=mine.
function stampDoctorName(patient, session) {
  const doctorName = session?.user?.name;
  if (!doctorName) return patient;
  return {
    ...patient,
    data: {
      ...patient.data,
      shared: {
        ...(patient.data?.shared ?? {}),
        doctorName,
      },
    },
  };
}

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
    toMigrate.map(p => pushPatient(stampDoctorName(p, session), { session, settings }))
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
// Preset migration — send local custom presets to the server.
// fetchServerPresets failure is absorbed into the result (does not propagate)
// so a preset-fetch error never hides patient migration results.
// ---------------------------------------------------------------------------
export async function migratePresetsToServer(presets, { session } = {}) {
  if (!presets || presets.length === 0) {
    return { migrated: 0, skipped: 0, failed: [] };
  }

  let existing;
  try {
    existing = await fetchServerPresets(session);
  } catch (err) {
    return {
      migrated: 0,
      skipped: 0,
      failed: presets.map(p => ({ preset: p, error: err })),
    };
  }

  const seenIdentities = new Set(existing.map(buildPresetIdentity));

  // Deduplicate within the local batch before uploading.
  const toUpload = [];
  for (const raw of presets) {
    const normalized = normalizePresetRecord(raw);
    const identity = buildPresetIdentity(normalized);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    toUpload.push(normalized);
  }

  const skipped = presets.length - toUpload.length;

  const results = await Promise.allSettled(
    toUpload.map(p => createServerPreset(p, session))
  );

  let migrated = 0;
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') migrated++;
    else failed.push({ preset: toUpload[i], error: r.reason });
  });

  return { migrated, skipped, failed };
}

// ---------------------------------------------------------------------------
// Main entry — collect from local sources then push to server.
// Uses collectLocalSnapshot() once so the native confirm dialog appears only
// once even though patients and presets are both migrated.
// May throw MigrationCanceledError / MigrationDeniedError / MigrationReadError
// during the collect phase — caller decides how to surface each.
// ---------------------------------------------------------------------------
export async function runMigration({ session, settings } = {}) {
  const snapshot = await collectLocalSnapshot();

  let patients, presets;
  if (snapshot === null) {
    // standalone: collect patients via storage fallback, no presets to migrate
    patients = await collectLocalPatients();
    presets = [];
  } else {
    patients = mergePatientsFromSnapshot(snapshot);
    presets = Array.isArray(snapshot.customPresets) ? snapshot.customPresets : [];
  }

  const [patientResult, presetResult] = await Promise.all([
    migrateToServer(patients, { session, settings }),
    migratePresetsToServer(presets, { session }),
  ]);

  return { ...patientResult, presetResult };
}

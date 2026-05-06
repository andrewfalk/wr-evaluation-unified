import { loadAutoSave, loadSavedItems } from '../utils/storage';
import { isRedactedPatientRecord } from './patientRecords';
import { pushPatient } from './patientServerRepository';

// ---------------------------------------------------------------------------
// Collection — gather all unique local patients from every storage location.
// Autosave (most recent session) takes priority over saved-item snapshots
// when the same patient.id appears in both. Redacted stubs are skipped.
// ---------------------------------------------------------------------------
export async function collectLocalPatients() {
  const byId = new Map();

  // Saved items (workspace snapshots) — older data, lower priority.
  const savedItems = await loadSavedItems();
  for (const item of savedItems) {
    for (const p of (item.patients ?? [])) {
      if (!isRedactedPatientRecord(p) && p.id) {
        byId.set(p.id, p);
      }
    }
  }

  // Autosave (current session) — most recent, overwrites saved-item version.
  const autoSave = await loadAutoSave();
  for (const p of (autoSave?.patients ?? [])) {
    if (!isRedactedPatientRecord(p) && p.id) {
      byId.set(p.id, p);
    }
  }

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
// Main entry — collect from localStorage then push to server.
// Safe to call multiple times: Idempotency-Key prevents duplicate records,
// and already-synced patients are skipped.
// ---------------------------------------------------------------------------
export async function runMigration({ session, settings } = {}) {
  const patients = await collectLocalPatients();
  return migrateToServer(patients, { session, settings });
}

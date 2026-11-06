// Shared harness for the G8 legacy-parity characterization tests (REFACTORING_ROADMAP P0-9):
// the client's sync<Module>ModuleData (src/modules/<id>/utils/data.js, used by the UI) against
// analytics-core's normalize<Module>ModuleData (used by the server statistics extractors).
//
// Two zones:
// - equal zone: every golden patient with the module (well-formed data — no orphan tasks, every
//   task id present, no _pendingPreset, every array/object field of the right type) must give the
//   same moduleData from both (deep equality — key order is not compared, nothing reads it);
// - boundary zone: the inputs where the two may differ by design (orphans, missing ids,
//   _pendingPreset, corrupted fields, non-object elements). Some do differ, some do not —
//   `sameModuleData` records which, and a thrown error is recorded as data. Both results are frozen
//   in a golden, so a later change to only one side shows up as a golden diff.
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenPatients } from './goldenPatients';
import { useGoldenEnvironment } from './goldenEnv';

/** Arguments both functions take, in order: [moduleData, jobs, diagnoses, activeModules]. */
export function moduleArgs(patient, moduleId) {
  const { shared, modules, activeModules } = patient.data;
  return [modules[moduleId], shared.jobs, shared.diagnoses, activeModules];
}

/** Golden patients that have the module active. */
export function goldenPatientsWith(moduleId) {
  return loadGoldenPatients().filter((p) => p.data.activeModules.includes(moduleId));
}

/** Run fn on a deep copy of args; a thrown error is recorded as data instead of failing the test. */
export function outcome(fn, args) {
  try {
    return { result: fn(...structuredClone(args)) };
  } catch (error) {
    return { error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? String(error)}` };
  }
}

export function goldenJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Both zones for one module. argCount: how many of moduleArgs() the functions take (cervical: 2).
 * cases: { [name]: (basePatient) => args } — each builds a boundary-zone input from a copy of the
 * first golden patient with the module. goldenPath is relative to the calling test file.
 */
export function legacyParitySuite({ moduleId, sync, normalize, argCount, cases, goldenPath }) {
  describe(`G8 — ${moduleId}: sync${moduleId[0].toUpperCase()}${moduleId.slice(1)}ModuleData vs analytics-core normalize`, () => {
    beforeEach(() => { useGoldenEnvironment(); }); // sync creates missing task ids from Date.now()+Math.random()
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('equal zone: the same moduleData for every golden patient with the module', () => {
      const patients = goldenPatientsWith(moduleId);
      expect(patients.length, `golden patients must cover ${moduleId}`).toBeGreaterThan(0);
      for (const patient of patients) {
        const args = moduleArgs(patient, moduleId).slice(0, argCount);
        expect(normalize(...structuredClone(args)).moduleData, patient.id).toEqual(sync(...structuredClone(args)).moduleData);
      }
    });

    it('boundary zone: both results frozen for the inputs where they may differ by design', async () => {
      const out = {};
      for (const [name, build] of Object.entries(cases)) {
        const args = build(structuredClone(goldenPatientsWith(moduleId)[0])).slice(0, argCount);
        const synced = outcome(sync, args);
        const normalized = outcome(normalize, args);
        out[name] = {
          sameModuleData: !!(synced.result && normalized.result && isDeepStrictEqual(synced.result.moduleData, normalized.result.moduleData)),
          sync: synced.error ? { error: synced.error } : { changed: synced.result.changed, moduleData: synced.result.moduleData },
          normalize: normalized.error ? { error: normalized.error } : { moduleData: normalized.result.moduleData },
        };
      }
      await expect(goldenJson(out)).toMatchFileSnapshot(goldenPath);
    });
  });
}

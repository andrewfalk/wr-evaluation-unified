// Golden (characterization) tests — G1: every module's computeCalc and isComplete on the frozen
// golden patients; G1b: every module's batchImportConfig.applyRow, driven by the import modal's own function
// (runBatchImport, P2-56), on rows produced by generateBatchRows. REFACTORING_ROADMAP P0-9.
// Rules (update only for intended output changes, never in a refactor): src/core/fixtures/goldenEnv.js
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenBatchPatients, loadGoldenPatients } from '../../fixtures/goldenPatients';

const MODULE_IDS = ['knee', 'shoulder', 'elbow', 'wrist', 'spine', 'cervical'];

// Stable, readable JSON: keep NaN/±Infinity distinguishable (plain JSON would turn them into null).
function goldenJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? `__${v}__` : v), 2) + '\n';
}

let registry;
let batch;
let batchImport;

beforeEach(async () => {
  useGoldenEnvironment();
  for (const id of MODULE_IDS) await import(`../../../modules/${id}/index.js`);
  registry = await import('../../moduleRegistry');
  batch = await import('../exportService');
  batchImport = await import('../../services/batchImport');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('G1 — computeCalc and isComplete per module', () => {
  it.each(MODULE_IDS)('%s', async (moduleId) => {
    const mod = registry.getModule(moduleId);
    const result = {};
    for (const patient of loadGoldenPatients()) {
      const { shared, modules, activeModules } = patient.data;
      if (!activeModules.includes(moduleId)) continue;
      const ctx = { shared, module: modules[moduleId], activeModules };
      result[patient.id] = {
        name: shared.name,
        activeModules,
        isComplete: mod.isComplete(ctx),
        calc: mod.computeCalc(ctx),
      };
    }
    expect(Object.keys(result).length, `golden patients must cover ${moduleId}`).toBeGreaterThan(0);
    await expect(goldenJson(result)).toMatchFileSnapshot(`./__goldens__/calc-${moduleId}.json`);
  });
});

// G1b runs the same function the import modal uses (src/core/services/batchImport.ts, P2-56) on rows produced by
// generateBatchRows — new patients only (no existing patients, no date-error rows, no session).
function importRows(rows) {
  const { newPatients: patients, stats } = batchImport.runBatchImport({ rows, existingPatients: [], errorRowIndexes: new Set(), session: null });
  return { patients, stats };
}

describe('G1b — batch import applyRow (all modules)', () => {
  it('rows from generateBatchRows(golden patients) imported through every module applyRow', async () => {
    const rows = [batch.getBatchHeaders(), ...batch.generateBatchRows(loadGoldenPatients())];
    const { patients, stats } = importRows(rows);
    await expect(goldenJson({ stats, patients: patients.map((p) => ({ id: p.id, data: p.data })) }))
      .toMatchFileSnapshot('./__goldens__/batch-import-applyRow.json');
  });

  // P2-54a: the extra batch cases (src/core/fixtures/goldenPatientsBatch.json) exported and imported back the same way.
  it('extra cases: rows from generateBatchRows(extra patients) imported through every module applyRow', async () => {
    const rows = [batch.getBatchHeaders(), ...batch.generateBatchRows(loadGoldenBatchPatients())];
    const { patients, stats } = importRows(rows);
    await expect(goldenJson({ stats, patients: patients.map((p) => ({ id: p.id, data: p.data })) }))
      .toMatchFileSnapshot('./__goldens__/batch-import-applyRow.extra.json');
  });
});

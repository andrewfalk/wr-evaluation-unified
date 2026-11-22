// Golden (characterization) test — P2-48 (Phase 2 C5·C6): every module's presetConfig
// extractFromModule → applyToModule on the frozen golden patients. Until now no test ran the real
// modules' preset functions; P2-49/P2-50 rewrite the manifest around them, so freeze them first.
// Rules (update only for intended output changes, never in a refactor): src/core/fixtures/goldenEnv.js
//
// Per patient × active module × job:
//   extract      = extractFromModule(patient's module data, jobId)
//   applyFresh   = applyToModule(createModuleData(), jobId, extract)     — preset onto an empty module
//   applyInPlace = applyToModule(patient's module data, jobId, extract)  — preset back onto the same data
//   reExtract    = extractFromModule(applyInPlace, jobId)
// plus applyToOtherJob = applyToModule(patient's module data, <first other job>, extract) once per
// module (the preset applied to a different job of the same patient).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenPatients } from '../../fixtures/goldenPatients';

const MODULE_IDS = ['knee', 'shoulder', 'elbow', 'wrist', 'spine', 'cervical'];

function goldenJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? `__${v}__` : v), 2) + '\n';
}

let registry;

beforeEach(async () => {
  useGoldenEnvironment();
  for (const id of MODULE_IDS) await import(`../../../modules/${id}/index.js`);
  registry = await import('../../moduleRegistry');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P2-48 — presetConfig extract/apply round trip', () => {
  it('all modules on golden patients', async () => {
    const result = {};
    const covered = new Set();
    for (const patient of loadGoldenPatients()) {
      const { shared, modules, activeModules } = patient.data;
      const jobIds = (shared.jobs || []).map(job => job.id);
      const perModule = {};
      for (const moduleId of activeModules) {
        const config = registry.getModule(moduleId)?.presetConfig;
        if (!config) continue;
        const mod = registry.getModule(moduleId);
        const moduleData = modules[moduleId];
        const perJob = {};
        let firstExtract = null;
        for (const jobId of jobIds) {
          const extract = config.extractFromModule(moduleData, jobId);
          const entry = { extract };
          if (extract) {
            covered.add(moduleId);
            if (!firstExtract) firstExtract = { jobId, extract };
            entry.applyFresh = config.applyToModule(mod.createModuleData(), jobId, extract);
            const applyInPlace = config.applyToModule(moduleData, jobId, extract);
            entry.applyInPlace = applyInPlace;
            entry.reExtract = config.extractFromModule(applyInPlace, jobId);
          }
          perJob[jobId] = entry;
        }
        const otherJobId = firstExtract && jobIds.find(id => id !== firstExtract.jobId);
        perModule[moduleId] = {
          jobs: perJob,
          applyToOtherJob: otherJobId
            ? { from: firstExtract.jobId, to: otherJobId, result: config.applyToModule(moduleData, otherJobId, firstExtract.extract) }
            : null,
        };
      }
      result[patient.id] = { name: shared.name, activeModules, modules: perModule };
    }
    expect([...covered].sort(), 'golden patients must give every module a non-empty preset extract')
      .toEqual([...MODULE_IDS].sort());
    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/preset-roundtrip.json');
  });
});

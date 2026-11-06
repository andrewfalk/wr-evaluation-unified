// Golden (characterization) test G8 — wrist: the client's syncWristModuleData against analytics-core's
// normalizeWristModuleData. Harness and the two zones: src/core/fixtures/legacyParity.js.
// Update the golden only for an intended change, never in a refactor (src/core/fixtures/goldenEnv.js).
import { legacyParitySuite, moduleArgs } from '../../../../core/fixtures/legacyParity';
import { syncWristModuleData } from '../data';
import { normalizeWristModuleData } from '@analytics-core/modules/wrist/legacyNormalize';

const NEW_JOB = { id: 'golden-job-new', jobName: '신규 직종', startDate: '2020-01-01', endDate: '2021-01-01' };

function withEntry(patient, change) {
  change(patient.data.modules.wrist.jobEvaluations[0].diagnosisEntries[0]);
  return moduleArgs(patient, 'wrist');
}

legacyParitySuite({
  moduleId: 'wrist',
  sync: syncWristModuleData,
  normalize: normalizeWristModuleData,
  argCount: 4,
  goldenPath: './__goldens__/legacy-parity-wrist.json',
  cases: {
    // A preset chosen for a job that has no entry yet: only sync (the UI) applies _pendingPreset.
    pendingPresetOnNewJob: (p) => {
      p.data.shared.jobs.push(NEW_JOB);
      p.data.modules.wrist.jobEvaluations.push({
        sharedJobId: NEW_JOB.id,
        diagnosisEntries: [],
        _pendingPreset: { main_task_name: '프리셋 작업', daily_exposure_hours: '3', force_level: 'high' },
      });
      return moduleArgs(p, 'wrist');
    },
    // exposure_types: null — both turn it into [] without a corruption marker (frozen as the same).
    corruptedExposureTypes: (p) => withEntry(p, (entry) => { entry.exposure_types = null; }),
  // Corrupted scalar-array field (planned case): sync keeps null, normalize turns it into [] and
  // records it in _corruptedArrayFields.
  corruptedPressureSource: (p) => withEntry(p, (entry) => { entry.bk2106_pressure_source = null; }),
    // A non-object element in jobEvaluations (legacy / external input).
    nullJobEvaluation: (p) => { p.data.modules.wrist.jobEvaluations.unshift(null); return moduleArgs(p, 'wrist'); },
    // jobEvaluations that is not an array at all.
    jobEvaluationsNotArray: (p) => { p.data.modules.wrist.jobEvaluations = 'broken'; return moduleArgs(p, 'wrist'); },
    // An evaluation for a job that no longer exists.
    orphanJobEvaluation: (p) => {
      const [first] = p.data.modules.wrist.jobEvaluations;
      p.data.modules.wrist.jobEvaluations.push({ ...first, sharedJobId: 'golden-job-gone' });
      return moduleArgs(p, 'wrist');
    },
  },
});

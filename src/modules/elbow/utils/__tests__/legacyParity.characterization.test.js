// Golden (characterization) test G8 — elbow: the client's syncElbowModuleData against analytics-core's
// normalizeElbowModuleData. Harness and the two zones: src/core/fixtures/legacyParity.js.
// Update the golden only for an intended change, never in a refactor (src/core/fixtures/goldenEnv.js).
import { legacyParitySuite, moduleArgs } from '../../../../core/fixtures/legacyParity';
import { syncElbowModuleData } from '../data';
import { normalizeElbowModuleData } from '@wr/analytics-core/modules/elbow/legacyNormalize';

const NEW_JOB = { id: 'golden-job-new', jobName: '신규 직종', startDate: '2020-01-01', endDate: '2021-01-01' };

function withEntry(patient, change) {
  change(patient.data.modules.elbow.jobEvaluations[0].diagnosisEntries[0]);
  return moduleArgs(patient, 'elbow');
}

legacyParitySuite({
  moduleId: 'elbow',
  sync: syncElbowModuleData,
  normalize: normalizeElbowModuleData,
  argCount: 4,
  goldenPath: './__goldens__/legacy-parity-elbow.json',
  cases: {
    // A preset chosen for a job that has no entry yet: only sync (the UI) applies _pendingPreset.
    pendingPresetOnNewJob: (p) => {
      p.data.shared.jobs.push(NEW_JOB);
      p.data.modules.elbow.jobEvaluations.push({
        sharedJobId: NEW_JOB.id,
        diagnosisEntries: [],
        _pendingPreset: { main_task_name: '프리셋 작업', daily_exposure_hours: '3', force_level: 'high' },
      });
      return moduleArgs(p, 'elbow');
    },
    // exposure_types: null — both turn it into [] without a corruption marker (frozen as the same).
    corruptedExposureTypes: (p) => withEntry(p, (entry) => { entry.exposure_types = null; }),
    // A non-object element in jobEvaluations (legacy / external input).
    nullJobEvaluation: (p) => { p.data.modules.elbow.jobEvaluations.unshift(null); return moduleArgs(p, 'elbow'); },
    // jobEvaluations that is not an array at all.
    jobEvaluationsNotArray: (p) => { p.data.modules.elbow.jobEvaluations = 'broken'; return moduleArgs(p, 'elbow'); },
    // An evaluation for a job that no longer exists.
    orphanJobEvaluation: (p) => {
      const [first] = p.data.modules.elbow.jobEvaluations;
      p.data.modules.elbow.jobEvaluations.push({ ...first, sharedJobId: 'golden-job-gone' });
      return moduleArgs(p, 'elbow');
    },
  },
});

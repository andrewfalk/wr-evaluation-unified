// Golden (characterization) test G8 — cervical: the client's syncCervicalModuleData against
// analytics-core's normalizeCervicalModuleData. Harness and the two zones: src/core/fixtures/legacyParity.js.
// Known by design: sync drops tasks of jobs that no longer exist (when there are jobs) and gives a
// task without an id a new one; normalize does neither (no calculation reads task.id or needs the
// pruning — packages/analytics-core/modules/cervical/legacyNormalize.ts).
// Update the golden only for an intended change, never in a refactor (src/core/fixtures/goldenEnv.js).
import { legacyParitySuite, moduleArgs } from '../../../../core/fixtures/legacyParity';
import { syncCervicalModuleData } from '../data';
import { normalizeCervicalModuleData } from '@analytics-core/modules/cervical/legacyNormalize';

function withTasks(patient, change) {
  change(patient.data.modules.cervical.tasks);
  return moduleArgs(patient, 'cervical');
}

legacyParitySuite({
  moduleId: 'cervical',
  sync: syncCervicalModuleData,
  normalize: normalizeCervicalModuleData,
  argCount: 2,
  goldenPath: './__goldens__/legacy-parity-cervical.json',
  cases: {
    orphanTask: (p) => withTasks(p, (tasks) => { tasks.push({ ...tasks[0], id: 9001, sharedJobId: 'golden-job-gone' }); }),
    taskWithoutId: (p) => withTasks(p, (tasks) => { delete tasks[0].id; }),
    taskWithoutSharedJobId: (p) => withTasks(p, (tasks) => { tasks.push({ ...tasks[0], id: 9002, sharedJobId: '' }); }),
    nullTask: (p) => withTasks(p, (tasks) => { tasks.unshift(null); }),
    // With no jobs, sync does not prune and both fall back to an empty first job id.
    noJobs: (p) => { p.data.shared.jobs = []; return moduleArgs(p, 'cervical'); },
  },
});

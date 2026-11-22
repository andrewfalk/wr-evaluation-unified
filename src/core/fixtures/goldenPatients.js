// Frozen input patients for golden tests (REFACTORING_ROADMAP P0-9).
//
// goldenPatients.json was generated ONCE (2026-11-06) from createTestPatients() — 27 patients,
// knee/spine/shoulder/wrist/cervical — with crypto.randomUUID / Date.now / Math.random pinned and
// TZ=Asia/Seoul, plus one elbow patient (BK2101, both sides, one side "low" with a reason) and one
// knee+spine patient with an extra job excluded from analysis (excludeFromAnalysis: true).
// It is plain data and must NOT be regenerated: if createTestPatients() changes, these inputs stay
// the same, so the goldens keep testing the code, not the fixture builder. To cover a new case,
// append a patient to the JSON (then update the affected goldens in that PR, with the reason).
import goldenPatients from './goldenPatients.json';
import goldenPatientsBatch from './goldenPatientsBatch.json';

// A fresh deep copy each call — some functions under test (batch import applyRow) mutate input.
export function loadGoldenPatients() {
  return JSON.parse(JSON.stringify(goldenPatients));
}

// Extra batch-export/import cases (P2-54a, Phase 2 C6) — hand-built patients for branches of generateBatchRows and the
// batch import that goldenPatients.json does not reach (elbow+wrist on one row, legacy temporalRelation, entries whose
// diagnosis is gone, no jobs, unlinked tasks, MDDM not 'present', direct repetition values, zero values, an empty patient).
// Kept in a separate file on purpose: goldenPatients.json is also read by server goldens/integration tests and perf
// scripts, and appending to it would change their existing values. Same rule: plain data, never regenerated.
export function loadGoldenBatchPatients() {
  return JSON.parse(JSON.stringify(goldenPatientsBatch));
}

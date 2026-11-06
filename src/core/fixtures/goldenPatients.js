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

// A fresh deep copy each call — some functions under test (batch import applyRow) mutate input.
export function loadGoldenPatients() {
  return JSON.parse(JSON.stringify(goldenPatients));
}

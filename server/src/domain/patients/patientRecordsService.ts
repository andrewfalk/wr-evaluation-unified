// The patient write services (REFACTORING_ROADMAP S7). Each takes the pool first and returns a
// discriminated union of its outcomes; the route handler answers each outcome with the response body it
// used before S7 (responses are unchanged byte for byte). Errors other than expected outcomes are thrown.
export type { PatientWriteContext, PatientWriteActor } from './context';
export { upsertFromWorkspace, type UpsertOutcome, type SkipReason } from './upsertFromWorkspace';
export { applyVideoAnalysisInTx, type ApplyVideoAnalysisResult, type ApplyVideoAnalysisParams } from './applyVideoAnalysis';
export { createPatient, type CreatePatientResult, type CreatePatientParams } from './createPatient';
export { patchPatient, type PatchPatientResult, type PatchPatientParams } from './patchPatient';

// Stats engine — the Python subprocess wrapper, split by concern (S6 P1-34). This index re-exports
// exactly what the single stats/engine/index.ts exported before the split, so importers keep using
// '…/stats/engine'. Process-lifecycle invariants: see subprocess.ts.

export { ENGINE_PROTOCOL_VERSION } from './protocol';
export type { StatsEngineVariableKind, StatsEngineVariable, StatsEngineRequest, BivariateMethodId, BivariateGroupsRequest, BivariateTableRequest, BivariateCorrelationRequest, BivariateEngineRequest, CorrelationMatrixEngineVariable, CorrelationMatrixEngineRequest, RegressionCovarianceSpec, RegressionEngineRequest, RegressionDiagnosticsEngineRequest, PredictionEngineRequest } from './protocol';
export type { StatsEngineContinuousResult, StatsEngineDiscreteResult, StatsEngineRawResult, StatsEngineEffectSize, StatsEngineBivariateRawResult, StatsEngineCorrelationMatrixCell, StatsEngineCorrelationMatrixRawResult, StatsEngineRegressionTerm, StatsEngineRegressionFit, StatsEngineRegressionDiagnostics, StatsEngineRegressionSplinePartialEffect, StatsEngineRegressionRawResult, StatsEngineRegressionDiagnosticsRawResult, StatsEnginePredictionMetric, StatsEnginePredictionAucCi, StatsEnginePredictionRawResult } from './responseSchemas';
export { StatsEngineBusyError, StatsEngineTimeoutError, StatsEngineOutputTooLargeError, StatsEngineProcessError, StatsEngineResultInvalidError, StatsEngineDegradedError, StatsEngineInputTooLargeError, StatsEngineCancelledError } from './errors';
export { assertWithinLimits, assertBivariateWithinLimits, assertRegressionWithinLimits, assertPredictionWithinLimits } from './limits';
export { __resetStatsEngineForTests, isEngineSlotAvailable, isEngineDegraded, buildEngineTimingLog } from './subprocess';
export type { EngineTimingLog, EngineRunOpts } from './subprocess';
export { runStatsEngine } from './runners/descriptive';
export { runBivariateStatsEngine } from './runners/bivariate';
export { runCorrelationMatrixStatsEngine } from './runners/correlationMatrix';
export { runRegressionStatsEngine } from './runners/regression';
export { runRegressionDiagnosticsEngine } from './runners/regressionDiagnostics';
export { buildPredictionEngineRequest, runPredictionStatsEngine } from './runners/prediction';
export type { BuildPredictionEngineRequestInput } from './runners/prediction';

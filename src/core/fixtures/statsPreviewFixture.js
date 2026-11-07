// Default /api/stats/preview response for StatisticsWorkbench component tests.
//
// Why: those tests mock previewStatsAnalysis with vi.fn() and queue answers with
// mockResolvedValueOnce. A preview call the test did not queue an answer for (the 500ms debounce
// firing between slow clicks on a loaded machine) then resolved to undefined, which the real client
// can never return (statsRepository.js parses every response with PreviewResponseSchema), and
// PreviewSummary crashed on `previewState.result.counts` — the tests failed only under load.
// installDefaultPreview resets the mock (dropping any answers a previous test queued but did not
// use) and answers every unqueued call with a contract-valid, not-suppressed preview.
//
// Rule for the tests: queue a preview answer (mockResolvedValueOnce / mockRejectedValueOnce) BEFORE
// the action that completes the recipe, not after it — if that action takes longer than the 500ms
// debounce, the preview fires before a later-queued answer exists and gets this default instead.
import { PreviewResponseSchema } from '@contracts/stats';

export function defaultPreviewResponse() {
  return PreviewResponseSchema.parse({
    runManifest: {
      analysisRunId: '00000000-0000-4000-8000-00000000d0f1', snapshotAsOf: '2024-01-01T00:00:00.000Z',
      recipeDigest: 'r', sourceDigest: 's', resultDigest: 'd',
      catalogVersion: 'cv1', extractorVersion: 'cv1', migrationVersion: 'mv1',
      formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e1', serializerVersion: 'sv1',
    },
    counts: { personCount: 20, caseCount: 20, observationCount: 20, suppressed: false, minimumCohort: 10, reasonCode: null },
    estimability: {
      completeCaseN: 20, missingRatesByVariable: {}, distinctAssignedDoctorClusters: 2,
      candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'v1',
    },
    availableMethods: [],
    methodCatalogVersion: null,
    differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
  });
}

/** Call in beforeEach, after vi.clearAllMocks(); queued mockResolvedValueOnce answers still win. */
export function installDefaultPreview(previewMock) {
  previewMock.mockReset();
  previewMock.mockResolvedValue(defaultPreviewResponse());
}

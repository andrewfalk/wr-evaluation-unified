// Golden (characterization) test G6 — the request bodies the statistics workbench sends to the
// Python engine, for the five request builders (descriptive, stratified descriptive, bivariate,
// regression, prediction). REFACTORING_ROADMAP P0-9.
//
// Input: the frozen golden patients (src/core/fixtures/goldenPatients.json) as snapshot rows. Path:
// buildDataset → deriveAnalysisContext (the same pure context builder the worker and GET /runs use)
// → the builder each mode calls in statsAnalyzeHandler.assertInputWithinLimitsForMode. The context is
// built with disclosureMode 'lifted' (the limited-data permission path: only the small-cell gate is
// off, the statistical gates stay) because 29 patients are too few for the restricted small-cell
// gates in some modes; the request a builder produces does not depend on the disclosure mode.
// Digests and person keys are deterministic HMACs of the inputs and are kept as they are.
//
// Update the golden only for an intended change of what is sent to the engine, never in a refactor:
// `npx vitest run -u src/__tests__/golden.statsEngineRequests.test.ts` + reason in the PR.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { StatsAnalysisRecipe } from '@wr/contracts';
import { buildDataset } from '../statsDatasetBuilder';
import { deriveAnalysisContext, type AnalysisContext } from '../statsAnalysisContext';
import { getIntegratedCatalog } from '../statsCatalog';
import { canonicalDigest } from '../canonicalSerializer';
import { computePredictionCohortDigest } from '../statsPredictionCohort';
import { buildStatsEngineRequest } from '../statsDescriptiveSuppression';
import { buildStratifiedStatsEngineRequest } from '../statsDescriptiveStratifySuppression';
import { buildBivariateEngineRequest } from '../statsBivariateSuppression';
import { buildRegressionEngineRequest } from '../statsRegressionSuppression';
import { buildPredictionEngineRequestForState } from '../statsPredictionSuppression';
import type { SnapshotRow } from '../statsSnapshot';

const GOLDEN_PATIENTS = path.resolve(__dirname, '../../../src/core/fixtures/goldenPatients.json');
const CATALOG_BY_KEY = new Map(getIntegratedCatalog().map((v) => [v.key, v]));
const PREDICTION_COPIES = 5;
const VIEWER = { viewerUserId: 'golden-viewer', viewerOrgId: 'golden-org' };

// copies > 1 repeats the golden patients as distinct people (only the case and person ids differ).
// Only prediction uses it: it needs at least 50 people and 25 event / 25 non-event people
// (PREDICTION_POLICY), and appending that many patients to goldenPatients.json would change every
// other golden built from it.
function snapshotRows(copies = 1): SnapshotRow[] {
  const patients = JSON.parse(fs.readFileSync(GOLDEN_PATIENTS, 'utf8')) as Array<{ id: string; data: Record<string, unknown> }>;
  const rows: SnapshotRow[] = [];
  for (let copy = 0; copy < copies; copy += 1) {
    patients.forEach((p, i) => rows.push({
      id: copy === 0 ? p.id : `${p.id}-copy${copy}`,
      patientPersonId: `golden-person-${String(i + 1).padStart(2, '0')}${copy === 0 ? '' : `-copy${copy}`}`,
      assignedDoctorUserId: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      payload: { data: p.data },
    }));
  }
  return rows;
}

function context(recipe: StatsAnalysisRecipe, copies = 1): AnalysisContext {
  const recipeDigest = canonicalDigest(recipe);
  const dataset = buildDataset(
    snapshotRows(copies), recipe, recipeDigest, CATALOG_BY_KEY,
    recipe.analysisMode === 'prediction' ? { cohortDigest: computePredictionCohortDigest(recipe) } : undefined,
  );
  const built = deriveAnalysisContext(
    { recipe, dataset, recipeDigest, sourceDigest: 'golden-source', snapshotAsOf: '2026-01-01T00:00:00.000Z' },
    VIEWER,
    { disclosureMode: 'lifted' },
  );
  if (!built.ok) throw new Error(`deriveAnalysisContext failed: ${JSON.stringify(built.body)}`);
  return built.ctx;
}

const base = { filters: [] as StatsAnalysisRecipe['filters'], analysisPurpose: 'association' as const, formulaPolicies: {} };

// Same dispatch as statsAnalyzeHandler.assertInputWithinLimitsForMode.
function engineRequest(ctx: AnalysisContext): unknown {
  const { recipe } = ctx;
  if (recipe.analysisMode === 'descriptive') {
    return ctx.descriptiveStratifyPartition
      ? buildStratifiedStatsEngineRequest(ctx.descriptiveStratifyPartition.groups, recipe.variableKeys, ctx.catalogByKey)
      : buildStatsEngineRequest(ctx.dataset.rows, recipe.variableKeys, ctx.catalogByKey);
  }
  if (recipe.analysisMode === 'bivariate') {
    expect(ctx.pairDisclosed, 'bivariate pair disclosed').toBe(true);
    const [keyX, keyY] = recipe.variableKeys;
    return buildBivariateEngineRequest(recipe.requestedMethod!, ctx.paired!.pairs, ctx.catalogByKey, keyX, keyY);
  }
  if (recipe.analysisMode === 'regression') {
    expect(ctx.regressionDisclosed, 'regression disclosed').toBe(true);
    expect(ctx.regressionDesign?.ok, `regression design estimable: ${JSON.stringify(ctx.regressionDesign)}`).toBe(true);
    if (!ctx.regressionDesign?.ok) throw new Error('unreachable');
    return buildRegressionEngineRequest(ctx.regressionDesign.design).request;
  }
  if (recipe.analysisMode === 'prediction') {
    expect(ctx.predictionDisclosed, 'prediction disclosed').toBe(true);
    const state = ctx.predictionState!;
    expect(state.nonEstimableCheck.reason, 'prediction non-estimable reason').toBeNull();
    return buildPredictionEngineRequestForState(state, state.nonEstimableCheck.design!).request;
  }
  throw new Error(`no G6 builder for ${recipe.analysisMode}`);
}

const RECIPES: Record<string, StatsAnalysisRecipe> = {
  descriptive: {
    ...base, grain: 'case', analysisMode: 'descriptive',
    variableKeys: ['patient.identity.ageAtInjury', 'patient.identity.gender', 'diagnosis.rollup.hasKnee', 'knee.case.weightedDailyLoadKg'],
  },
  descriptiveStratified: {
    ...base, grain: 'case', analysisMode: 'descriptive',
    variableKeys: ['patient.identity.ageAtInjury', 'patient.identity.bmi', 'diagnosis.rollup.hasKnee'],
    descriptive: { stratifyByKey: 'patient.identity.gender' },
  },
  bivariatePearson: {
    ...base, grain: 'case', analysisMode: 'bivariate', requestedMethod: 'pearson_correlation',
    variableKeys: ['patient.identity.ageAtInjury', 'patient.identity.bmi'],
  },
  bivariateWelch: {
    ...base, grain: 'case', analysisMode: 'bivariate', requestedMethod: 'welch_t',
    variableKeys: ['patient.identity.gender', 'patient.identity.bmi'],
  },
  // Job grain: regression needs at least 30 complete rows (29 golden cases, 60 jobs) — and the
  // repeated observations per person exercise the cluster covariance groups.
  regressionOls: {
    ...base, grain: 'job', analysisMode: 'regression', requestedMethod: 'ols_linear',
    variableKeys: ['job.identity.tenureYears', 'patient.identity.ageAtInjury', 'patient.identity.gender', 'job.raw.workDaysPerYear'],
    regression: {
      outcomeKey: 'job.identity.tenureYears', referenceLevels: {}, standardizePredictors: false, interactionTerms: [], splineKeys: [],
    },
  },
  // eventLevel 'low': per copy of the golden patients 5 people have a 'low' assessment and 5 do not
  // (with 'high' it is 9 / 1), so PREDICTION_COPIES = 5 reaches the 50 / 25 / 25 person minimums.
  prediction: {
    ...base, grain: 'disease', analysisMode: 'prediction', analysisPurpose: 'prediction', requestedMethod: 'l2_logistic',
    variableKeys: ['diagnosis.assessment.status', 'patient.identity.ageAtInjury', 'patient.identity.bmi'],
    prediction: { outcomeKey: 'diagnosis.assessment.status', eventLevel: 'low' },
  },
};

describe('G6 — statistics engine request bodies', () => {
  it('descriptive, stratified, bivariate, regression and prediction requests', async () => {
    const out: Record<string, unknown> = {};
    for (const [name, recipe] of Object.entries(RECIPES)) {
      out[name] = { recipe, request: engineRequest(context(recipe, recipe.analysisMode === 'prediction' ? PREDICTION_COPIES : 1)) };
    }
    await expect(JSON.stringify(out, null, 2) + '\n').toMatchFileSnapshot('./__goldens__/stats-engine-requests.json');
  });
});

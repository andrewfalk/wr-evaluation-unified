// PR1 §4.1 — /preview와 /analyze가 공유하는 순수 추출. zod parse→validateRecipe→
// recipeDigest→differencing guard→readSnapshot→buildDataset→코호트 게이트까지만 하고
// 끝난다 — /analyze 전용 상태(가드A 카운터, in-flight map 등)는 절대 여기 넣지 않는다.
// handlePostPreview는 이 헬퍼로 리팩터되며 기존 동작·테스트는 그대로 유지한다(순수 추출).
//
// PR3-A — 이변량 쌍 추출 + availableMethods 계산까지 이 헬퍼가 담당한다(계획서
// §"파이프라인" — preview·analyze 둘 다 동일하게 계산, 단일 진실원). context
// 인자는 validateRecipe에만 영향을 준다('preview'는 관대함, 'analyze'는 엄격).
import type { Request } from 'express';
import type { Pool } from 'pg';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { StatsAnalysisRecipeSchema, type AvailableMethod, type StatsAnalysisRecipe } from '@wr/contracts';
import { canonicalDigest } from './canonicalSerializer';
import { MINIMUM_COHORT } from './statsPolicy';
import { validateRecipe } from './statsRecipeValidation';
import { readSnapshot, type Snapshot } from './statsSnapshot';
import { buildDataset, type DatasetResult } from './statsDatasetBuilder';
import { computeQueryFamilyDigest, checkAndRecordDifferencing, type DifferencingCheckResult } from './statsDifferencingGuard';
import { buildPairedDataset, type PairedDatasetResult } from './statsBivariateDataset';
import { evaluateBivariateDisclosure } from './statsBivariateDisclosureGate';
import { computeAvailableMethods } from './statsMethodCatalog';
import { METHOD_POLICY_VERSION } from './statsExecutionDigest';

export interface AnalysisContext {
  orgId: string;
  userId: string;
  recipe: StatsAnalysisRecipe;
  catalogByKey: Map<string, AnalyticsVariableMetadata>;
  recipeDigest: string;
  queryFamilyDigest: string;
  differencing: DifferencingCheckResult;
  snapshot: Snapshot;
  dataset: DatasetResult;
  requestSuppressed: boolean;
  reasonCode: 'MIN_COHORT_NOT_MET' | 'DIFFERENCING_RATE_LIMIT' | null;
  // PR3-A — analysisMode==='descriptive'면 전부 null/false/[]/null(이변량 무관).
  paired: PairedDatasetResult | null;
  pairDisclosed: boolean;
  availableMethods: AvailableMethod[];
  methodCatalogVersion: string | null;
}

export type BuildAnalysisContextResult =
  | { ok: true; ctx: AnalysisContext }
  | { ok: false; status: number; body: unknown };

export async function buildAnalysisContext(
  pool: Pool,
  req: Request,
  context: 'preview' | 'analyze',
): Promise<BuildAnalysisContextResult> {
  const session = req.sessionInfo!;
  const orgId = session.organizationId!;
  const userId = session.userId;

  const parsed = StatsAnalysisRecipeSchema.safeParse(req.body);
  if (!parsed.success) {
    return { ok: false, status: 400, body: { code: 'INVALID_RECIPE', errors: parsed.error.issues } };
  }
  const recipe = parsed.data;

  const validation = validateRecipe(recipe, context);
  if (!validation.valid) {
    return { ok: false, status: 400, body: { code: 'INVALID_RECIPE', errors: validation.errors } };
  }
  const { catalogByKey } = validation;

  const recipeDigest = canonicalDigest(recipe);
  const queryFamilyDigest = computeQueryFamilyDigest(recipe);

  // differencing 게이트 이후 계산은 결과와 무관하게 항상 실행한다(감사·digest 계산이
  // 억제 여부와 무관하게 항상 일어나야 한다는 기존 /preview 원칙을 그대로 유지).
  const differencing = checkAndRecordDifferencing(orgId, userId, recipe, queryFamilyDigest);

  const snapshot = await readSnapshot(pool, orgId);
  const dataset = buildDataset(snapshot.rows, recipe, recipeDigest, catalogByKey);

  const minCohortExceeded = dataset.personCount < MINIMUM_COHORT;
  const reasonCode: 'MIN_COHORT_NOT_MET' | 'DIFFERENCING_RATE_LIMIT' | null = minCohortExceeded
    ? 'MIN_COHORT_NOT_MET'
    : differencing.forceSuppress
      ? 'DIFFERENCING_RATE_LIMIT'
      : null;
  const requestSuppressed = reasonCode !== null;

  let paired: PairedDatasetResult | null = null;
  let pairDisclosed = false;
  let availableMethods: AvailableMethod[] = [];
  let methodCatalogVersion: string | null = null;

  if (recipe.analysisMode === 'bivariate') {
    const [keyX, keyY] = recipe.variableKeys;
    paired = buildPairedDataset(dataset.rows, keyX, keyY);
    // §"통합 공개통제 게이트" — 기존 request-level 억제(differencing/전체 MIN_COHORT)와
    // 새 쌍-level 억제(레이어1)를 OR로 합친다. 이 둘 중 하나라도 억제면 availableMethods
    // 계산 자체를 생략한다(세부 사유가 새는 걸 막기 위해 애초에 안 만듦).
    pairDisclosed = !requestSuppressed && evaluateBivariateDisclosure(paired).disclose;
    if (pairDisclosed) {
      availableMethods = computeAvailableMethods(keyX, keyY, catalogByKey, paired, METHOD_POLICY_VERSION);
      methodCatalogVersion = METHOD_POLICY_VERSION;
    }
  }

  return {
    ok: true,
    ctx: {
      orgId, userId, recipe, catalogByKey, recipeDigest, queryFamilyDigest,
      differencing, snapshot, dataset, requestSuppressed, reasonCode,
      paired, pairDisclosed, availableMethods, methodCatalogVersion,
    },
  };
}

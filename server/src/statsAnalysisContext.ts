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
import { computeAvailableMethods, computeCorrelationMatrixAvailableMethods } from './statsMethodCatalog';
import {
  buildCorrelationMatrixPairedDatasets,
  evaluateCorrelationMatrixInputLimits,
  type CorrelationMatrixPairSummary,
  type CorrelationMatrixVariable,
} from './statsCorrelationMatrixDataset';
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
  // PR3-B §4 — analysisMode==='correlation_matrix'일 때만 채워진다(그 외 null).
  // key는 statsCorrelationMatrixDataset.ts의 pairMapKey(xKey,yKey) — 항상
  // variableKeys의 i<j 순서로 생성돼 있다.
  correlationMatrixPairs: Map<string, CorrelationMatrixPairSummary> | null;
  // PR3-B §8(코드리뷰 2차 수정) — 값개수/바이트 상한 선검사(evaluateCorrelationMatrixInputLimits)를
  // 통과할 때 이미 만들어둔 변수별 값 배열. statsCorrelationMatrixSuppression.ts가
  // Python 요청 조립 시 그대로 재사용해 같은 O(k×rows) 추출을 두 번 하지 않는다.
  correlationMatrixVariables: CorrelationMatrixVariable[] | null;
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
  let correlationMatrixPairs: Map<string, CorrelationMatrixPairSummary> | null = null;
  let correlationMatrixVariables: CorrelationMatrixVariable[] | null = null;

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
  } else if (recipe.analysisMode === 'correlation_matrix') {
    // PR3-B §8(코드리뷰 2차 수정) — buildCorrelationMatrixPairedDatasets()는
    // O(k²×rows) 순회다. 세 상한(변수당 개수/총 개수/직렬화 바이트) 전부를 그
    // 순회 시작 *전에* 확인한다 — 이 함수는 preview·analyze 공유 경로라, 여기서
    // 막지 않으면 Python payload 조립 시점(assertCorrelationMatrixWithinLimits)
    // 까지 상한 초과 입력에도 순회가 전부 끝나 있다(1차 수정 때는 총 개수만 O(1)로
    // 확인해 "3변수×60,000행"처럼 총합은 상한 이내지만 행 수 자체가 변수당 상한을
    // 넘는 입력과 바이트 상한 초과 입력을 놓쳤음 — 3종 전부 여기서 막는다).
    // 코드리뷰 3차 수정 — requestedMethod를 그대로 넘긴다(preview에서 미선택이면
    // undefined, 이땐 더 긴 method 문자열을 가정해 보수적으로 측정).
    const inputLimitCheck = evaluateCorrelationMatrixInputLimits(
      dataset.rows,
      recipe.variableKeys,
      recipe.requestedMethod as 'pearson_correlation' | 'spearman_correlation' | undefined,
    );
    if (!inputLimitCheck.ok) {
      return { ok: false, status: 400, body: { code: 'INPUT_TOO_LARGE', message: '선택한 변수·행 조합이 상관행렬 처리 상한을 초과합니다.', reason: inputLimitCheck.violation } };
    }
    correlationMatrixVariables = inputLimitCheck.variables;
    // PR3-B §4 — 상관행렬은 pair마다 disclosure가 갈리므로(§6.1 게이트도 pair별)
    // 단일 pairDisclosed 플래그로 표현하지 않는다. availableMethods는 "선택
    // 가능/불가능"까지만(셀별 세부판정은 statsCorrelationMatrixSuppression.ts).
    correlationMatrixPairs = buildCorrelationMatrixPairedDatasets(dataset.rows, recipe.variableKeys);
    if (!requestSuppressed) {
      availableMethods = computeCorrelationMatrixAvailableMethods(dataset.personCount, recipe.variableKeys, catalogByKey, METHOD_POLICY_VERSION);
      methodCatalogVersion = METHOD_POLICY_VERSION;
    }
  }

  return {
    ok: true,
    ctx: {
      orgId, userId, recipe, catalogByKey, recipeDigest, queryFamilyDigest,
      differencing, snapshot, dataset, requestSuppressed, reasonCode,
      paired, pairDisclosed, availableMethods, methodCatalogVersion, correlationMatrixPairs,
      correlationMatrixVariables,
    },
  };
}

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
import { computeAvailableMethods, computeCorrelationMatrixAvailableMethods, computeRegressionAvailableMethods } from './statsMethodCatalog';
import {
  buildCorrelationMatrixPairedDatasets,
  evaluateCorrelationMatrixInputLimits,
  type CorrelationMatrixPairSummary,
  type CorrelationMatrixVariable,
} from './statsCorrelationMatrixDataset';
import { METHOD_POLICY_VERSION } from './statsExecutionDigest';
import {
  computeRegressionCompleteCase,
  computeRegressionLevelSummaries,
  computeRegressionEventSummary,
  computeRegressionInteractionLevelSummaries,
  evaluateRegressionInputLimits,
  type RegressionInteractionLevelSummary,
} from './statsRegressionDataset';
import { evaluateRegressionDisclosure } from './statsRegressionDisclosureGate';
import { buildRegressionDesignMatrix, type RegressionDesignResult } from './statsRegressionDesign';

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
  // PR4-A1 — analysisMode==='regression'일 때만 채워진다(그 외 null/false).
  // regressionDesign은 ③(공개통제)을 통과했을 때만 계산된다(계획서 §2 "③이
  // ④보다 먼저인 이유" — 통과 못 한 요청엔 설계행렬 관련 값이 하나도 나가면
  // 안 된다). ok:false면 Node 자체 판정으로 non_estimable(Python 미호출).
  regressionDisclosed: boolean;
  regressionDesign: RegressionDesignResult | null;
  regressionExcludedRowCount: number | null;
  // outcome 타입만으로 결정되는 method(§2 ④ — outcome이 continuous면 ols_linear,
  // boolean이면 binary_logistic, 그 외엔 null). requestedMethod와 무관하게
  // 항상 이 값으로 설계행렬을 만든다 — v1은 outcome 타입이 method를 확정한다.
  regressionMethod: 'ols_linear' | 'binary_logistic' | null;
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
  // 부작용(rate limit 카운터 기록)이 있는 호출이라 PR4-B1의 deriveAnalysisContext
  // (워커/GET 재구성 경로)에서는 절대 다시 부르지 않는다 — admission이 이미 통과시킨
  // 행은 이 판정이 항상 false였다는 뜻이므로 재실행할 이유도, 재실행해서 카운터를
  // 또 소비할 이유도 없다.
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

  return buildAnalysisContextTail({
    orgId, userId, recipe, catalogByKey, recipeDigest, queryFamilyDigest,
    differencing, snapshot, dataset, requestSuppressed, reasonCode,
  });
}

// PR4-B1 — enqueue 시점에 frozen_dataset(JSONB)으로 저장해두는 최소 입력. recipe는
// 이미 검증된 것, dataset은 buildDataset()의 출력 그대로. 이 이상으로 키우지 않는다
// (§저장 데이터 최소화 — buildAnalysisContext 꼬리가 실제로 소비하는 형태까지만).
export interface FrozenAnalysisInput {
  recipe: StatsAnalysisRecipe;
  dataset: DatasetResult;
  recipeDigest: string;
  sourceDigest: string;
  snapshotAsOf: string;
}

// PR4-B1 — 워커(attempt())와 GET /runs/:analysisRunId 둘 다 이 함수로 frozen_dataset을
// 재구성한다. viewerUserId/viewerOrgId는 frozen_dataset에 박힌 원 요청자와 별개로
// "지금 이 결과를 보는 사람"을 뜻한다 — capability 체크·감사 actor가 조회자 기준이어야
// 하기 때문(§H 뷰어 컨텍스트 분리). 워커 자신의 실행(attempt())은 아직 아무도
// "조회"하지 않으므로 viewer=원 요청자를 그대로 넘긴다.
//
// differencing 재실행 없음(위 buildAnalysisContext 주석 참고) — requestSuppressed는
// 항상 false로 고정한다. admission이 §0에서 이미 억제 요청을 걸러낸 뒤에만 행을
// 만들므로, 이 함수에 도달하는 recipe는 구조적으로 억제 대상이 아니었던 것이다.
export function deriveAnalysisContext(
  frozen: FrozenAnalysisInput,
  viewer: { viewerUserId: string; viewerOrgId: string },
): BuildAnalysisContextResult {
  const validation = validateRecipe(frozen.recipe, 'analyze');
  if (!validation.valid) {
    // admission 시점엔 통과했던 recipe가 재검증에 실패 — 카탈로그가 그 사이 바뀐
    // 경우뿐이어야 한다(claim 시점 실행 버전 재검증이 이미 이런 드리프트를 별도로
    // 잡지만, 방어적으로 한 번 더 막는다).
    return { ok: false, status: 400, body: { code: 'INVALID_RECIPE', errors: validation.errors } };
  }
  const { catalogByKey } = validation;

  return buildAnalysisContextTail({
    orgId: viewer.viewerOrgId,
    userId: viewer.viewerUserId,
    recipe: frozen.recipe,
    catalogByKey,
    recipeDigest: frozen.recipeDigest,
    queryFamilyDigest: '',
    differencing: { forceSuppress: false, remaining: 0 },
    snapshot: { rows: [], sourceDigest: frozen.sourceDigest, snapshotAsOf: frozen.snapshotAsOf },
    dataset: frozen.dataset,
    requestSuppressed: false,
    reasonCode: null,
  });
}

interface BuildAnalysisContextTailInput {
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
}

// buildAnalysisContext(HTTP, snapshot을 막 읽은 직후)와 deriveAnalysisContext(워커/GET,
// frozen_dataset에서 재구성)가 공유하는 순수 꼬리 — analysisMode별 paired/correlationMatrix/
// regressionDesign 계산은 (recipe, catalogByKey, dataset)만의 순수 함수라 두 경로에서
// 완전히 동일하게 재사용된다.
function buildAnalysisContextTail(input: BuildAnalysisContextTailInput): BuildAnalysisContextResult {
  const {
    orgId, userId, recipe, catalogByKey, recipeDigest, queryFamilyDigest,
    differencing, snapshot, dataset, requestSuppressed, reasonCode,
  } = input;

  let paired: PairedDatasetResult | null = null;
  let pairDisclosed = false;
  let availableMethods: AvailableMethod[] = [];
  let methodCatalogVersion: string | null = null;
  let correlationMatrixPairs: Map<string, CorrelationMatrixPairSummary> | null = null;
  let correlationMatrixVariables: CorrelationMatrixVariable[] | null = null;
  let regressionDisclosed = false;
  let regressionDesign: RegressionDesignResult | null = null;
  let regressionExcludedRowCount: number | null = null;
  let regressionMethod: 'ols_linear' | 'binary_logistic' | null = null;

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
  } else if (recipe.analysisMode === 'regression' && recipe.regression) {
    // PR4-A1 §2 실행 순서 ①~④. zod+statsRecipeValidation.ts가 이미
    // variableKeys.length>=2 · outcomeKey∈variableKeys를 보장했으므로
    // predictorKeys는 항상 1개 이상이다.
    const {
      outcomeKey, referenceLevels, eventLevel, standardizePredictors, interactionTerms, splineKeys,
    } = recipe.regression;
    const predictorKeys = recipe.variableKeys.filter((k) => k !== outcomeKey);
    const outcomeVar = catalogByKey.get(outcomeKey);
    // PR4-A2 — categorical outcome도 잠정 binary_logistic으로 시도한다. "관측
    // 레벨이 정확히 2개인지"는 ③ 통과 후 ④(설계행렬)에서만 최종 판정한다(§2
    // "categorical 2레벨 outcome" — 순서가 핵심).
    regressionMethod =
      outcomeVar?.type === 'continuous' ? 'ols_linear'
      : (outcomeVar?.type === 'boolean' || outcomeVar?.type === 'categorical') ? 'binary_logistic'
      : null;

    // ① 입력상한 선검사 — 더미 확장 전 원본 변수 개수(outcome+predictor)로
    // 보수적으로 측정한다(statsRegressionDataset.ts 주석 — 더미 확장은 열만
    // 늘리므로 실제 초과는 ④ TOO_MANY_PARAMETERS가 별도로 잡는다).
    const inputLimitCheck = evaluateRegressionInputLimits(dataset.rows.length, recipe.variableKeys.length);
    if (!inputLimitCheck.ok) {
      return { ok: false, status: 400, body: { code: 'INPUT_TOO_LARGE', message: '선택한 변수·행 조합이 회귀 처리 상한을 초과합니다.', reason: inputLimitCheck.violation } };
    }

    // ② 완전사례 + 레벨·event 요약(person 단위, 전부 ③ 공개통제 입력용).
    const completeCase = computeRegressionCompleteCase(dataset.rows, outcomeKey, predictorKeys);
    regressionExcludedRowCount = completeCase.excludedRowCount;
    const predictorLevelSummaries = computeRegressionLevelSummaries(completeCase.completeRows, predictorKeys, catalogByKey);
    // PR4-A2 — outcome이 categorical이면 레벨별 person 요약을 predictor와 별도로
    // 더해 넣는다(computeRegressionLevelSummaries는 predictor/outcome을 구분하지
    // 않는 범용 함수). "레벨이 몇 개인지"는 ③ 통과 전엔 전혀 드러나지 않는다.
    // boolean outcome은 기존 eventSummary 경로로 충분해 이중 게이트를 만들지 않는다.
    const outcomeLevelSummaries = outcomeVar?.type === 'categorical'
      ? computeRegressionLevelSummaries(completeCase.completeRows, [outcomeKey], catalogByKey)
      : [];
    const levelSummaries = [...predictorLevelSummaries, ...outcomeLevelSummaries];
    const eventSummary = computeRegressionEventSummary(completeCase.completeRows, outcomeKey, outcomeVar?.type);

    // PR4-A2 — interaction 쌍이 둘 다 categorical/ordinal/boolean이면 교차표
    // 소수셀 검사(연속형이 섞인 쌍은 computeRegressionInteractionLevelSummaries가
    // 빈 배열을 반환 — 그 값 분산은 기존 ZERO_VARIANCE_PREDICTOR가 이미 커버).
    const interactionLevelSummaries: RegressionInteractionLevelSummary[] = interactionTerms.flatMap(
      (pair) => computeRegressionInteractionLevelSummaries(completeCase.completeRows, pair, catalogByKey),
    );

    // ③ 공개통제 — request-level 억제(differencing/전체 MIN_COHORT)와 OR로
    // 합친다(bivariate와 동일 원칙). 실패하면 ④를 절대 실행하지 않는다 —
    // 레벨 수·파라미터 수·rank 등은 전부 데이터 특성을 드러낸다.
    const disclosure = evaluateRegressionDisclosure({
      includedPersonCount: completeCase.includedPersonCount,
      excludedPersonCount: completeCase.excludedPersonCount,
      levelSummaries,
      eventSummary,
      interactionLevelSummaries,
    });
    regressionDisclosed = !requestSuppressed && disclosure.disclose;

    if (regressionDisclosed) {
      if (regressionMethod) {
        // ④ 설계행렬 + 추정가능성(Node 판정). 실패해도 non_estimable로
        // 응답할 정보이지 억제가 아니므로 여기서 계속 진행한다.
        regressionDesign = buildRegressionDesignMatrix({
          completeRows: completeCase.completeRows,
          outcomeKey,
          predictorKeys,
          catalogByKey,
          method: regressionMethod,
          referenceLevels,
          eventSummary,
          eventLevel,
          standardizePredictors,
          interactionTerms,
          splineKeys,
        });
      }
      // availableMethods는 ③을 통과했을 때만 계산한다(리뷰 원칙 — 통과 전엔
      // 사유 코드조차 노출하지 않는다). A-1 수준 판정(0건·outcome 타입
      // 불일치)만 담당 — 완전사례/레벨/EPV 등 데이터 의존 세부 사유는 여기
      // 없다(그건 ④의 nonEstimableReason으로만 노출).
      availableMethods = computeRegressionAvailableMethods(completeCase.includedPersonCount, outcomeKey, catalogByKey, METHOD_POLICY_VERSION);
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
      regressionDisclosed, regressionDesign, regressionExcludedRowCount, regressionMethod,
    },
  };
}

// PR0-C — GET /catalog + POST /preview. PR1 — POST /analyze(동기). §D-6 통합 파이프라인:
// 코호트 미달이든 differencing 초과든 같은 마스킹 페이로드로 응답하고, 감사·resultDigest
// 계산은 예외 없이 거친다. handlePostPreview/handlePostAnalyze는 statsAnalysisContext.ts의
// buildAnalysisContext()를 공유한다(순수 추출, 계획서 pr1-giggly-treehouse.md §4.1).
import { isDeepStrictEqual } from 'node:util';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { INTEGRATED_CATALOG_VERSION } from '../statsCatalogVersion';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { getIntegratedCatalog } from '../statsCatalog';
import { PREDICTION_OUTCOME_SPECS } from '@wr/analytics-core/catalog';
import {
  type CatalogResponse,
  type CatalogVariable,
  type PreviewResponse,
  type PreviewCounts,
  type PreviewEstimability,
} from '@wr/contracts';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { hasCapability, requireCapability } from '../middleware/requireCapability';
import { analyzeRateLimit } from '../middleware/rateLimit';
import { writeAuditLogStrict } from '../middleware/audit';
import { canonicalDigest } from '../canonicalSerializer';
import { MINIMUM_COHORT, ESTIMABILITY_POLICY_VERSION, DIFFERENCING_POLICY, PREDICTION_POLICY } from '../statsPolicy';
import { computeEstimability } from '../statsEstimability';
import { buildRunManifest } from '../statsRunManifest';
import { buildAnalysisContext, deriveAnalysisContext, type AnalysisContext } from '../statsAnalysisContext';
import { handlePostAnalyze, finalizeAnalyzeResponse, isAbortedFinalize, toPublicRunManifest } from '../statsAnalyzeHandler';
import { isLiftApplicable, resolveEffectiveContext } from '../statsLiftedRecompute';
import { deliverStoredLimited, isStoredLimitedMode } from '../statsStoredLimited';
import { createResponseAbort } from '../statsResponseAbort';
import { handlePostExport } from '../statsExportHandler';
import { buildPredictionEngineRequestForState } from '../statsPredictionSuppression';
import { assertPredictionWithinLimits, StatsEngineInputTooLargeError } from '../statsEngine';
import { requestCancel, hasVersionDrifted } from '../statsRunsQueue';
import { STATS_RUN_COLUMNS, type StatsRunRow } from '../statsRunRow';
import type { AnalyzeResult, StatsRunManifestSucceeded } from '@wr/contracts';

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

// grain 단순화(PR0-B4 개정, person grain 삭제 후속) — case/job/disease 3개만 지원한다
// (statsRecipeValidation.ts의 SUPPORTED_GRAINS와 반드시 같은 목록을 유지할 것).
const CASE_GRAIN = 'case' as const;
const JOB_GRAIN = 'job' as const;
const DISEASE_GRAIN = 'disease' as const;
const ALL_GRAINS = ['case', 'job', 'disease'] as const;
const SUPPORTED_GRAINS_SET = new Set<(typeof ALL_GRAINS)[number]>([
  CASE_GRAIN,
  JOB_GRAIN,
  DISEASE_GRAIN,
]);

function toCatalogVariableDto(v: AnalyticsVariableMetadata): CatalogVariable {
  // PR4-B2 — outcome 명세는 PREDICTION_OUTCOME_SPECS(단일 진실원)에서만 파생한다.
  // predictionRole!=='outcome'이면 항상 null(predictor·역할없음 둘 다).
  const outcomeSpec = v.predictionRole === 'outcome' ? PREDICTION_OUTCOME_SPECS[v.key] : undefined;
  return {
    key: v.key,
    label: v.label,
    group: v.group,
    moduleId: v.moduleId,
    grain: v.grain,
    type: v.type,
    unit: v.unit ?? null,
    provenance: v.provenance,
    dependsOn: v.dependsOn,
    availableAt: v.availableAt,
    shownToAssessor: v.shownToAssessor,
    allowedAnalysisPurposes: v.allowedAnalysisPurposes,
    sensitivity: v.sensitivity,
    formulaFamily: v.formulaFamily,
    supportedFormulaPolicies: v.supportedFormulaPolicies,
    formulaVersionKey: v.formulaVersionKey ?? null,
    analysisRole: v.analysisRole ?? 'analyzable',
    broadcastToGrains: v.broadcastToGrains ? [...v.broadcastToGrains] : [],
    predictionRole: v.predictionRole ?? null,
    predictionOutcomeLevels: outcomeSpec ? [...outcomeSpec.levels] : null,
    predictionEventLevels: outcomeSpec ? [...outcomeSpec.eventLevels] : null,
  };
}

async function handleGetCatalog(_req: Request, res: Response): Promise<void> {
  const variables = getIntegratedCatalog().map(toCatalogVariableDto);
  const response: CatalogResponse = {
    catalogVersion: INTEGRATED_CATALOG_VERSION,
    variables,
    supportedGrains: Array.from(SUPPORTED_GRAINS_SET),
    unsupportedGrains: ALL_GRAINS.filter((g) => !SUPPORTED_GRAINS_SET.has(g)).map((grain) => ({
      grain,
      reasonCode: 'GRAIN_NOT_YET_SUPPORTED' as const,
    })),
    minimumCohort: MINIMUM_COHORT,
  };
  res.status(200).json(response);
}

// suppressed(코호트 미달 또는 differencing 초과) 페이로드 — §C. 키/항목 구조는 그대로
// 유지하고 내부 수치만 null로 채운다(스키마가 record/array 자체의 부재를 허용하지 않음).
function buildSuppressedPreviewPayload(
  variableKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
  reasonCode: 'MIN_COHORT_NOT_MET' | 'DIFFERENCING_RATE_LIMIT',
): { counts: PreviewCounts; estimability: PreviewEstimability } {
  const counts: PreviewCounts = {
    personCount: null,
    caseCount: null,
    observationCount: null,
    suppressed: true,
    minimumCohort: MINIMUM_COHORT,
    reasonCode,
  };
  const estimability: PreviewEstimability = {
    completeCaseN: null,
    missingRatesByVariable: Object.fromEntries(variableKeys.map((k) => [k, null])),
    distinctAssignedDoctorClusters: null,
    candidateParameterCount: null,
    eventNonEvent: variableKeys
      .filter((k) => catalogByKey.get(k)?.type === 'boolean')
      .map((k) => ({ variableKey: k, events: null, nonEvents: null, suppressed: true })),
    estimabilityPolicyVersion: ESTIMABILITY_POLICY_VERSION,
  };
  return { counts, estimability };
}

// PR4-B2 — preview도 analyze와 같은 3-4단계 우선순위(③공개통제 → ④비추정
// 판정 → 바이트/작업량 상한)를 따른다. 이 셋 중 하나라도 통과하지 못하면
// candidateParameterCount를 노출하지 않는다(회귀의 design.ok===true 게이트와
// 동일 원칙 — "미생성"과 "생략"을 구분하는 신중함, 실제로 실행 불가능한
// 요청에 파라미터 수를 보여주면 오도한다).
// 코드리뷰(2026-09-25) — candidateParameterCount는 EPV 판정에 쓰이는 K-1
// 관례의 parameterCount여야 한다(design.columnCount는 one-hot 전체 열 수로
// 별개 개념 — statsPredictionDesign.ts의 columnCount≠parameterCount 구분과
// 동일). 범주형 K수준에서 둘이 달라지므로 여기서 columnCount를 반환하면
// preview가 실제 EPV 판단 기준과 다른 숫자를 보여준다.
function predictionCandidateParameterCount(ctx: AnalysisContext): number | null {
  if (ctx.recipe.analysisMode !== 'prediction' || !ctx.predictionState) return null;
  const { predictionState } = ctx;
  const design = predictionState.nonEstimableCheck.design;
  if (!design) return null;
  if (predictionState.s2Rows.length > PREDICTION_POLICY.maxWorkUnits) return null;
  try {
    const { request } = buildPredictionEngineRequestForState(predictionState, design);
    assertPredictionWithinLimits(request);
  } catch (err) {
    if (err instanceof StatsEngineInputTooLargeError) return null;
    throw err;
  }
  return design.parameterCount;
}

async function handlePostPreview(pool: Pool, req: Request, res: Response): Promise<void> {
  const built = await buildAnalysisContext(pool, req, 'preview');
  if (!built.ok) {
    res.status(built.status).json(built.body);
    return;
  }
  const ctx = built.ctx;

  // 제한데이터 권한자는 소수 셀 게이트 때문에 가려진 분석(회귀 등)의 미리보기도 해제 기준으로 본다. 기술통계는 아래
  // liftPossible 경로가 처리한다. 공개 게이트가 닫히면 availableMethods가 비어 UI의 실행 버튼이 잠기므로
  // counts·estimability·availableMethods 전부를 같은 유효 컨텍스트(view)에서 만든다.
  const effective = await resolveEffectiveContext(pool, ctx);
  const view = effective.ctx;
  const modeLifted = effective.lifted;

  let counts: PreviewCounts;
  let estimability: PreviewEstimability;

  // 코드리뷰(2026-09-25) — ctx.requestSuppressed만 보면 예측 전용 ②공개통제
  // (predictionDisclosed)가 실패해도 preview가 일반 집계(counts.suppressed:false)로
  // 진행한다 — statsAnalyzeHandler.ts의 predictionSuppressed 판정과 어긋난다.
  // 계획서 "preview도 같은 공개통제 우선순위를 따른다"를 충족하려면 여기서도
  // 동일하게 억제해야 한다.
  const predictionSuppressed = view.recipe.analysisMode === 'prediction' && !view.predictionDisclosed;

  // 제한데이터 권한자의 기술통계 미리보기는 소수 셀(1~9명) 제한을 푼다. 회귀는 위 유효 컨텍스트(view)가 같은 일을
  // 한다(예측 포함). differencing 제한
  // (forceSuppress)은 남용 방지 장치라 풀지 않는다(이때 reasonCode는 N<10이어도 MIN_COHORT로 보일 수
  // 있어 사유 코드가 아니라 플래그로 판정한다).
  // 권한 조회(DB 1회)는 풀 것이 실제로 있을 때만 한다 — 요청 수준 억제이거나 억제 없는 추정가능성이
  // 제한 적용본과 다를 때. 대부분의 미리보기는 조회 없이 끝난다.
  const liftPossible = ctx.recipe.analysisMode === 'descriptive' && !ctx.differencing.forceSuppress;
  let holder: boolean | null = null;
  const isHolder = async (): Promise<boolean> => {
    holder ??= await hasCapability(pool, 'stats.export_limited_rows', ctx.userId, ctx.orgId);
    return holder;
  };
  // 요청 수준(필터 후 인원 < MINIMUM_COHORT) 게이트를 실제로 우회했는가 — 감사에는 이것만 기록한다.
  const liftedRequestGate = liftPossible && ctx.requestSuppressed && await isHolder();
  let liftedCellLevel = false;

  if ((view.requestSuppressed && !liftedRequestGate) || predictionSuppressed) {
    ({ counts, estimability } = buildSuppressedPreviewPayload(
      ctx.recipe.variableKeys, ctx.catalogByKey, ctx.reasonCode ?? 'MIN_COHORT_NOT_MET',
    ));
  } else {
    // §C 1단계 게이트를 통과했을 때만 §C 2단계(person 단위 소수 셀 억제)를 계산한다.
    // 유효 컨텍스트가 해제 기준이면(회귀) 셀 수준 억제도 함께 끈다.
    const restrictedEst = computeEstimability(
      ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey, modeLifted ? { unrestricted: true } : undefined,
    );
    let est = restrictedEst;
    if (liftPossible) {
      const openEst = computeEstimability(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey, { unrestricted: true });
      // 셀 수준 해제는 제한 적용본과 실제로 달랐을 때만 적용·기록한다(풀 것이 없었으면 일반 응답과 같다).
      if (!isDeepStrictEqual(openEst, restrictedEst) && await isHolder()) {
        est = openEst;
        liftedCellLevel = true;
      }
    }
    counts = {
      personCount: ctx.dataset.personCount,
      caseCount: ctx.dataset.caseCount,
      observationCount: ctx.dataset.observationCount,
      suppressed: false,
      minimumCohort: MINIMUM_COHORT,
      reasonCode: null,
    };
    estimability = {
      completeCaseN: est.completeCaseN,
      missingRatesByVariable: est.missingRatesByVariable,
      distinctAssignedDoctorClusters: ctx.dataset.distinctAssignedDoctorClusters,
      // PR4-A1 §2 "④ 설계행렬" — outcome/predictor 구분이 회귀 레시피에만 있으므로
      // 실제 파라미터 수(더미 확장 후, 절편 포함)도 회귀 모드일 때만 계산할 수
      // 있다. ③ 공개통제를 통과하지 못했거나(ctx.regressionDesign이 null) ④
      // 설계행렬 자체가 non_estimable(design.ok===false)이면 여전히 null —
      // "미생성"이지 "생략"이 아니다(리뷰 #14).
      candidateParameterCount:
        view.recipe.analysisMode === 'regression' && view.regressionDesign?.ok === true
          ? view.regressionDesign.design.columns.length
          : view.recipe.analysisMode === 'prediction'
            ? predictionCandidateParameterCount(view)
            : est.candidateParameterCount,
      eventNonEvent: est.eventNonEvent,
      estimabilityPolicyVersion: ESTIMABILITY_POLICY_VERSION,
    };
  }
  const smallCellLimitLifted = liftedRequestGate || liftedCellLevel || modeLifted;
  // 실제로 전달된 응답이 억제 상태인지 — 해제한 경우 원래 억제 사유(originalReasonCode)와 구분한다.
  const deliveredSuppressed = ctx.requestSuppressed && !liftedRequestGate && !modeLifted;

  // §E — resultDigest는 억제 적용 "후" 실제 공개 페이로드의 해시. 억제 전 원값을 해시하면
  // 무차별대입으로 역산될 수 있어 절대 쓰지 않는다. PR3-A — availableMethods/
  // methodCatalogVersion도 이 preview가 실제로 공개하는 페이로드이므로 해시에 포함한다
  // (계획서 §"resultDigest에 availableMethods 누락 복원" — 3차 리뷰에서 지적됐다가
  // 누락됐던 것을 v7에서 복원).
  const resultDigest = canonicalDigest({
    counts,
    estimability,
    availableMethods: view.availableMethods,
    methodCatalogVersion: view.methodCatalogVersion,
  });

  const runManifest = buildRunManifest({
    recipeDigest: ctx.recipeDigest,
    sourceDigest: ctx.snapshot.sourceDigest,
    resultDigest,
    snapshotAsOf: ctx.snapshot.snapshotAsOf,
    formulaPolicies: ctx.recipe.formulaPolicies,
    analysisMode: ctx.recipe.analysisMode,
  });

  const response: PreviewResponse = {
    runManifest,
    counts,
    estimability,
    availableMethods: view.availableMethods,
    methodCatalogVersion: view.methodCatalogVersion,
    differencing: {
      queryFamilyDigest: ctx.queryFamilyDigest,
      windowMinutes: DIFFERENCING_POLICY.windowMinutes,
      remaining: ctx.differencing.remaining,
    },
    // 소수 셀 억제를 실제로 푼 경우에만 표시한다(풀 것이 없었으면 일반 응답과 같다).
    ...(smallCellLimitLifted ? { limitedDisclosure: 'applied' as const } : {}),
  };

  // §D-6 ⑥ — 감사 기록은 억제 여부와 무관하게 항상 남기고, 실패하면 요청 자체를 500으로
  // 실패시킨다(이번 PR은 감사로그가 유일한 영속 provenance 저장소이므로, §Context 확정사항 2).
  await writeAuditLogStrict(pool, {
    actorUserId: ctx.userId,
    actorOrgId: ctx.orgId,
    action: 'stats_preview',
    targetType: 'analysis_recipe',
    targetId: ctx.recipeDigest,
    outcome: deliveredSuppressed ? 'denied' : 'success',
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    extra: {
      analysisRunId: runManifest.analysisRunId,
      recipeDigest: ctx.recipeDigest,
      sourceDigest: ctx.snapshot.sourceDigest,
      resultDigest,
      internalResultDigest: ctx.dataset.internalResultDigest,
      grain: ctx.recipe.grain,
      variableKeys: ctx.recipe.variableKeys,
      filterKeys: ctx.recipe.filters.map((f) => f.key),
      filterOperators: ctx.recipe.filters.map((f) => f.operator),
      filterCount: ctx.recipe.filters.length,
      analysisPurpose: ctx.recipe.analysisPurpose,
      formulaPolicies: ctx.recipe.formulaPolicies,
      // 실제로 전달된 응답 기준. 제한 해제로 우회한 경우 원래 사유는 originalReasonCode에 남는다.
      suppressed: deliveredSuppressed,
      reasonCode: deliveredSuppressed ? ctx.reasonCode : null,
      originalReasonCode: ctx.reasonCode,
      deliveredReasonCode: deliveredSuppressed ? ctx.reasonCode : null,
      smallCellLimitLifted,
      liftedRequestGate,
      liftedCellLevel,
      // 기술통계 외 모드(회귀)가 유효 컨텍스트로 소수 셀 게이트를 풀고 본 미리보기인가.
      liftedModeGate: modeLifted,
      queryFamilyDigest: ctx.queryFamilyDigest,
      catalogVersion: runManifest.catalogVersion,
      extractorVersion: runManifest.extractorVersion,
      migrationVersion: runManifest.migrationVersion,
      engineVersion: runManifest.engineVersion,
      serializerVersion: runManifest.serializerVersion,
    },
  });

  res.status(200).json(response);
}

// ---------------------------------------------------------------------------
// PR4-B1 — GET /runs/:analysisRunId, POST /runs/:analysisRunId/cancel.
// analysisRunId로 주소를 지정한다(DB id PK가 아님 — 기존 POST /export가 이미
// analysisRunId로 조회하는 관례와 동일).
// ---------------------------------------------------------------------------
async function fetchRunRowForViewer(
  pool: Pool,
  analysisRunId: string,
  organizationId: string,
): Promise<StatsRunRow | null> {
  const { rows } = await pool.query<StatsRunRow>(
    `SELECT ${STATS_RUN_COLUMNS} FROM stats_runs
      WHERE analysis_run_id=$1 AND organization_id=$2 AND expires_at > now()`,
    [analysisRunId, organizationId],
  );
  return rows[0] ?? null;
}

async function handleGetRun(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const analysisRunId = req.params.analysisRunId;
  // 조회 쿼리 자체가 expires_at>now()를 포함 — cleanup 전 만료 행은 존재 자체를
  // 밝히지 않고(cross-org와 동일 취급) RUN_EXPIRED가 아니라 RUN_NOT_FOUND로 응답한다.
  const row = await fetchRunRowForViewer(pool, analysisRunId, session.organizationId!);
  if (!row) {
    res.status(404).json({ code: 'RUN_NOT_FOUND', error: 'Run not found.' });
    return;
  }
  // 소유권 체크(같은 조직+본인 또는 관리자) — 행의 requested_by와 별개로 먼저 수행.
  if (row.requested_by !== session.userId && session.role !== 'admin') {
    res.status(403).json({ code: 'FORBIDDEN', error: 'You do not have access to this run.' });
    return;
  }

  if (row.status === 'queued' || row.status === 'running') {
    res.status(200).json({
      analysisRunId: row.analysis_run_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at ? row.started_at.toISOString() : null,
    });
    return;
  }
  if (row.status === 'cancelled') {
    res.status(200).json({
      analysisRunId: row.analysis_run_id,
      status: 'cancelled',
      cancelledAt: (row.finished_at ?? row.created_at).toISOString(),
    });
    return;
  }
  if (row.status === 'failed') {
    res.status(200).json({ analysisRunId: row.analysis_run_id, status: 'failed', errorCode: row.error_code });
    return;
  }

  // succeeded — viewer(조회자) 컨텍스트로 limited_row 재구성. 버전드리프트 시
  // attached:false로 저하(이미 저장된 aggregate result 자체는 그대로 서빙).
  const manifest = row.manifest as StatsRunManifestSucceeded;
  const publicManifest = toPublicRunManifest(manifest);
  const result = row.result as AnalyzeResult;

  // 상관행렬·예측은 성공 직후 원본 행(frozen_dataset)을 지워서 아래 재구성 경로를 못 탄다 — 실행 시 저장해 둔 해제본을
  // 조회자의 현재 권한으로 고른다(statsStoredLimited.ts). 권한이 없으면 저장된 일반본 그대로다.
  if (isStoredLimitedMode(manifest.analysisMode)) {
    const storedAbort = createResponseAbort(res);
    try {
      const delivered = await deliverStoredLimited(pool, { userId: session.userId, orgId: session.organizationId! }, {
        analysisRunId: row.analysis_run_id,
        executionDigest: row.execution_digest,
        recipeDigest: row.recipe_digest,
        analysisMode: manifest.analysisMode as string,
        runManifest: publicManifest,
        result,
        versionDrifted: hasVersionDrifted(row),
      }, storedAbort.signal);
      if ('aborted' in delivered) return;
      if (delivered.status !== 200) {
        res.status(delivered.status).json(delivered.body);
        return;
      }
      const deliveredBody = delivered.body as { runManifest: typeof publicManifest; result: AnalyzeResult };
      res.status(200).json({ analysisRunId: row.analysis_run_id, status: 'succeeded', ...deliveredBody });
    } finally {
      storedAbort.dispose();
    }
    return;
  }

  // 제한데이터 권한자가 조회한 기술통계 실행인데 응답 시점 해제에 필요한 원본이 없거나(조기 억제 실행 중
  // 생성 당시 권한이 없었거나 differencing으로 막힌 것, 또는 보존기간 이후) 버전이 어긋났다 — 집계 결과는
  // 그대로 서빙하되, 조용히 비공개로 보이지 않도록 사유를 알린다(재실행하면 해제된다).
  if (!row.frozen_dataset || hasVersionDrifted(row)) {
    let body: AnalyzeResult = result;
    const runMode = manifest.analysisMode ?? 'descriptive';
    if (
      (runMode === 'descriptive' || isLiftApplicable(runMode, result))
      && await hasCapability(pool, 'stats.export_limited_rows', session.userId, session.organizationId!)
    ) {
      body = { ...result, limitedDisclosure: row.frozen_dataset ? 'unavailable_version_drift' : 'unavailable_source_missing' };
    }
    res.status(200).json({ analysisRunId: row.analysis_run_id, status: 'succeeded', runManifest: publicManifest, result: body });
    return;
  }
  const ctxResult = deriveAnalysisContext(row.frozen_dataset, {
    viewerUserId: session.userId,
    viewerOrgId: session.organizationId!,
  });
  if (!ctxResult.ok) {
    res.status(200).json({ analysisRunId: row.analysis_run_id, status: 'succeeded', runManifest: publicManifest, result });
    return;
  }
  // 응답 완료 전에 연결이 끊기면 제한 해제 계산을 중단한다(res close 기반 — statsResponseAbort.ts).
  const abort = createResponseAbort(res);
  try {
    const finalized = await finalizeAnalyzeResponse(pool, ctxResult.ctx, row.execution_digest, {
      runManifest: publicManifest,
      result,
    }, abort.signal);
    if (isAbortedFinalize(finalized)) return;
    if (finalized.status !== 200) {
      res.status(finalized.status).json(finalized.body);
      return;
    }
    const body = finalized.body as { runManifest: typeof publicManifest; result: AnalyzeResult };
    res.status(200).json({ analysisRunId: row.analysis_run_id, status: 'succeeded', ...body });
  } finally {
    abort.dispose();
  }
}

async function handlePostCancelRun(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const analysisRunId = req.params.analysisRunId;

  // 취소 권한 — 요청자 본인 또는 관리자(§8.1). requestCancel 자체는 조직 범위만
  // 강제하므로, 행위자 신원 체크는 여기서 먼저 한다.
  const row = await fetchRunRowForViewer(pool, analysisRunId, session.organizationId!);
  if (!row) {
    res.status(404).json({ code: 'RUN_NOT_FOUND', error: 'Run not found.' });
    return;
  }
  if (row.requested_by !== session.userId && session.role !== 'admin') {
    res.status(403).json({ code: 'FORBIDDEN', error: 'You do not have access to this run.' });
    return;
  }

  const result = await requestCancel(pool, analysisRunId, session.organizationId!, session.userId);
  if (result.outcome === 'not_found') {
    res.status(404).json({ code: 'RUN_NOT_FOUND', error: 'Run not found.' });
    return;
  }
  if (result.outcome === 'already_terminal') {
    res.status(409).json({ code: 'ALREADY_TERMINAL', error: 'This run has already finished.' });
    return;
  }
  res.status(200).json({ analysisRunId, status: 'cancel_requested' });
}

export function createStatsRouter(pool: Pool) {
  const router = Router();
  const auth = createAuthMiddleware(pool);

  router.get('/catalog', auth, requireCapability(pool, 'stats.view'), (req, res) =>
    handleGetCatalog(req, res).catch(() => res.status(500).json(internalError())),
  );

  router.post('/preview', auth, requireCapability(pool, 'stats.view'), csrfMiddleware, (req, res) =>
    handlePostPreview(pool, req, res).catch(() => res.status(500).json(internalError())),
  );

  // PR1 — stats.regression은 0028_capability_grants.sql에서 이미 default_all_roles=true로
  // 정의돼 있다(§4.1) — 별도 user_capability_grants 부여가 새로 필요해지지 않는다.
  router.post('/analyze', auth, requireCapability(pool, 'stats.regression'), analyzeRateLimit(), csrfMiddleware, (req, res) =>
    handlePostAnalyze(pool, req, res).catch(() => res.status(500).json(internalError())),
  );

  // PR4-B1 — 폴링·취소. 기존 POST /analyze와 같은 capability로 게이트(§5 기존 관례).
  router.get('/runs/:analysisRunId', auth, requireCapability(pool, 'stats.regression'), (req, res) =>
    handleGetRun(pool, req, res).catch(() => res.status(500).json(internalError())),
  );
  router.post('/runs/:analysisRunId/cancel', auth, requireCapability(pool, 'stats.regression'), csrfMiddleware, (req, res) =>
    handlePostCancelRun(pool, req, res).catch(() => res.status(500).json(internalError())),
  );

  // PR2 §7 — 집계 결과 내보내기. recipe를 다시 안 받고 analysisRunId로 저장된 결과를 그대로
  // CSV로 포맷한다(재계산 없음) — stats.export_results는 이미 0028에서 default_all_roles=true.
  router.post('/export', auth, requireCapability(pool, 'stats.export_results'), csrfMiddleware, (req, res) =>
    handlePostExport(pool, req, res).catch(() => res.status(500).json(internalError())),
  );

  return router;
}

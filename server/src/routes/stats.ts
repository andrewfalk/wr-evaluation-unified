// PR0-C — GET /catalog + POST /preview. §D-6 통합 파이프라인: 코호트 미달이든 differencing
// 초과든 같은 마스킹 페이로드로 응답하고, 감사·resultDigest 계산은 예외 없이 거친다.
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { getFullVariableCatalog, CATALOG_VERSION } from '@wr/analytics-core/catalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import {
  StatsAnalysisRecipeSchema,
  type CatalogResponse,
  type CatalogVariable,
  type PreviewResponse,
  type PreviewCounts,
  type PreviewEstimability,
} from '@wr/contracts';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { requireCapability } from '../middleware/requireCapability';
import { writeAuditLogStrict } from '../middleware/audit';
import { canonicalDigest } from '../canonicalSerializer';
import { MINIMUM_COHORT, ESTIMABILITY_POLICY_VERSION, DIFFERENCING_POLICY } from '../statsPolicy';
import { validateRecipe } from '../statsRecipeValidation';
import { readSnapshot } from '../statsSnapshot';
import { buildDataset } from '../statsDatasetBuilder';
import { computeEstimability } from '../statsEstimability';
import { computeQueryFamilyDigest, checkAndRecordDifferencing } from '../statsDifferencingGuard';
import { buildRunManifest } from '../statsRunManifest';

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

const CASE_GRAIN = 'case' as const;
const ALL_GRAINS = ['person', 'case', 'diagnosis_side', 'job', 'job_diagnosis', 'task', 'vibration_interval'] as const;

function toCatalogVariableDto(v: AnalyticsVariableMetadata): CatalogVariable {
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
  };
}

async function handleGetCatalog(_req: Request, res: Response): Promise<void> {
  const variables = getFullVariableCatalog().map(toCatalogVariableDto);
  const response: CatalogResponse = {
    catalogVersion: CATALOG_VERSION,
    variables,
    supportedGrains: [CASE_GRAIN],
    unsupportedGrains: ALL_GRAINS.filter((g) => g !== CASE_GRAIN).map((grain) => ({
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

async function handlePostPreview(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId = session.organizationId!;

  const parsed = StatsAnalysisRecipeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_RECIPE', errors: parsed.error.issues });
    return;
  }
  const recipe = parsed.data;

  // §A — 레시피 검증(카탈로그 존재·식별자·목적·필터 형태·formulaPolicy 유효성).
  const validation = validateRecipe(recipe);
  if (!validation.valid) {
    res.status(400).json({ code: 'INVALID_RECIPE', errors: validation.errors });
    return;
  }
  const { catalogByKey } = validation;

  // §E — recipeDigest는 검증·정규화(zod 기본값 채움) 후 recipe를 배열 순서 그대로 해시한다.
  const recipeDigest = canonicalDigest(recipe);
  const queryFamilyDigest = computeQueryFamilyDigest(recipe);

  // §D-6 ② differencing 게이트 — 이후 ③ 계산은 결과와 무관하게 항상 실행한다(감사·
  // resultDigest 계산이 억제 여부와 무관하게 항상 일어나야 하므로).
  const differencing = checkAndRecordDifferencing(orgId, session.userId, recipe, queryFamilyDigest);

  // §D-6 ③ snapshot + dataset builder + estimability.
  const snapshot = await readSnapshot(pool, orgId);
  const dataset = buildDataset(snapshot.rows, recipe, recipeDigest, catalogByKey);

  const minCohortExceeded = dataset.personCount < MINIMUM_COHORT;
  // §D-6 — 사유 우선순위: MIN_COHORT_NOT_MET이 DIFFERENCING_RATE_LIMIT보다 우선한다(코호트
  // 자체가 작으면 아무리 기다려도 안 되므로 더 근본적이고 정확한 사유).
  const reasonCode: 'MIN_COHORT_NOT_MET' | 'DIFFERENCING_RATE_LIMIT' | null = minCohortExceeded
    ? 'MIN_COHORT_NOT_MET'
    : differencing.forceSuppress
      ? 'DIFFERENCING_RATE_LIMIT'
      : null;
  const suppressed = reasonCode !== null;

  let counts: PreviewCounts;
  let estimability: PreviewEstimability;

  if (suppressed) {
    ({ counts, estimability } = buildSuppressedPreviewPayload(recipe.variableKeys, catalogByKey, reasonCode!));
  } else {
    // §C 1단계 게이트를 통과했을 때만 §C 2단계(person 단위 소수 셀 억제)를 계산한다.
    const est = computeEstimability(dataset.rows, recipe.variableKeys, catalogByKey);
    counts = {
      personCount: dataset.personCount,
      caseCount: dataset.caseCount,
      observationCount: dataset.observationCount,
      suppressed: false,
      minimumCohort: MINIMUM_COHORT,
      reasonCode: null,
    };
    estimability = {
      completeCaseN: est.completeCaseN,
      missingRatesByVariable: est.missingRatesByVariable,
      distinctAssignedDoctorClusters: dataset.distinctAssignedDoctorClusters,
      candidateParameterCount: est.candidateParameterCount,
      eventNonEvent: est.eventNonEvent,
      estimabilityPolicyVersion: ESTIMABILITY_POLICY_VERSION,
    };
  }

  // §E — resultDigest는 억제 적용 "후" 실제 공개 페이로드의 해시. 억제 전 원값을 해시하면
  // 무차별대입으로 역산될 수 있어 절대 쓰지 않는다.
  const resultDigest = canonicalDigest({ counts, estimability });

  const runManifest = buildRunManifest({
    recipeDigest,
    sourceDigest: snapshot.sourceDigest,
    resultDigest,
    snapshotAsOf: snapshot.snapshotAsOf,
    formulaPolicies: recipe.formulaPolicies,
  });

  const response: PreviewResponse = {
    runManifest,
    counts,
    estimability,
    availableMethods: [],
    methodCatalogVersion: null,
    differencing: {
      queryFamilyDigest,
      windowMinutes: DIFFERENCING_POLICY.windowMinutes,
      remaining: differencing.remaining,
    },
  };

  // §D-6 ⑥ — 감사 기록은 억제 여부와 무관하게 항상 남기고, 실패하면 요청 자체를 500으로
  // 실패시킨다(이번 PR은 감사로그가 유일한 영속 provenance 저장소이므로, §Context 확정사항 2).
  await writeAuditLogStrict(pool, {
    actorUserId: session.userId,
    actorOrgId: orgId,
    action: 'stats_preview',
    targetType: 'analysis_recipe',
    targetId: recipeDigest,
    outcome: suppressed ? 'denied' : 'success',
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    extra: {
      analysisRunId: runManifest.analysisRunId,
      recipeDigest,
      sourceDigest: snapshot.sourceDigest,
      resultDigest,
      internalResultDigest: dataset.internalResultDigest,
      grain: recipe.grain,
      variableKeys: recipe.variableKeys,
      filterKeys: recipe.filters.map((f) => f.key),
      filterOperators: recipe.filters.map((f) => f.operator),
      filterCount: recipe.filters.length,
      analysisPurpose: recipe.analysisPurpose,
      formulaPolicies: recipe.formulaPolicies,
      suppressed,
      reasonCode,
      queryFamilyDigest,
      catalogVersion: runManifest.catalogVersion,
      extractorVersion: runManifest.extractorVersion,
      migrationVersion: runManifest.migrationVersion,
      engineVersion: runManifest.engineVersion,
      serializerVersion: runManifest.serializerVersion,
    },
  });

  res.status(200).json(response);
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

  return router;
}

// PR0-C — GET /catalog + POST /preview. PR1 — POST /analyze(동기). §D-6 통합 파이프라인:
// 코호트 미달이든 differencing 초과든 같은 마스킹 페이로드로 응답하고, 감사·resultDigest
// 계산은 예외 없이 거친다. handlePostPreview/handlePostAnalyze는 statsAnalysisContext.ts의
// buildAnalysisContext()를 공유한다(순수 추출, 계획서 pr1-giggly-treehouse.md §4.1).
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { getFullVariableCatalog, CATALOG_VERSION } from '@wr/analytics-core/catalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import {
  type CatalogResponse,
  type CatalogVariable,
  type PreviewResponse,
  type PreviewCounts,
  type PreviewEstimability,
} from '@wr/contracts';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { requireCapability } from '../middleware/requireCapability';
import { analyzeRateLimit } from '../middleware/rateLimit';
import { writeAuditLogStrict } from '../middleware/audit';
import { canonicalDigest } from '../canonicalSerializer';
import { MINIMUM_COHORT, ESTIMABILITY_POLICY_VERSION, DIFFERENCING_POLICY } from '../statsPolicy';
import { computeEstimability } from '../statsEstimability';
import { buildRunManifest } from '../statsRunManifest';
import { buildAnalysisContext } from '../statsAnalysisContext';
import { handlePostAnalyze } from '../statsAnalyzeHandler';
import { handlePostExport } from '../statsExportHandler';

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
  const built = await buildAnalysisContext(pool, req);
  if (!built.ok) {
    res.status(built.status).json(built.body);
    return;
  }
  const ctx = built.ctx;

  let counts: PreviewCounts;
  let estimability: PreviewEstimability;

  if (ctx.requestSuppressed) {
    ({ counts, estimability } = buildSuppressedPreviewPayload(ctx.recipe.variableKeys, ctx.catalogByKey, ctx.reasonCode!));
  } else {
    // §C 1단계 게이트를 통과했을 때만 §C 2단계(person 단위 소수 셀 억제)를 계산한다.
    const est = computeEstimability(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey);
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
      candidateParameterCount: est.candidateParameterCount,
      eventNonEvent: est.eventNonEvent,
      estimabilityPolicyVersion: ESTIMABILITY_POLICY_VERSION,
    };
  }

  // §E — resultDigest는 억제 적용 "후" 실제 공개 페이로드의 해시. 억제 전 원값을 해시하면
  // 무차별대입으로 역산될 수 있어 절대 쓰지 않는다.
  const resultDigest = canonicalDigest({ counts, estimability });

  const runManifest = buildRunManifest({
    recipeDigest: ctx.recipeDigest,
    sourceDigest: ctx.snapshot.sourceDigest,
    resultDigest,
    snapshotAsOf: ctx.snapshot.snapshotAsOf,
    formulaPolicies: ctx.recipe.formulaPolicies,
  });

  const response: PreviewResponse = {
    runManifest,
    counts,
    estimability,
    availableMethods: [],
    methodCatalogVersion: null,
    differencing: {
      queryFamilyDigest: ctx.queryFamilyDigest,
      windowMinutes: DIFFERENCING_POLICY.windowMinutes,
      remaining: ctx.differencing.remaining,
    },
  };

  // §D-6 ⑥ — 감사 기록은 억제 여부와 무관하게 항상 남기고, 실패하면 요청 자체를 500으로
  // 실패시킨다(이번 PR은 감사로그가 유일한 영속 provenance 저장소이므로, §Context 확정사항 2).
  await writeAuditLogStrict(pool, {
    actorUserId: ctx.userId,
    actorOrgId: ctx.orgId,
    action: 'stats_preview',
    targetType: 'analysis_recipe',
    targetId: ctx.recipeDigest,
    outcome: ctx.requestSuppressed ? 'denied' : 'success',
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
      suppressed: ctx.requestSuppressed,
      reasonCode: ctx.reasonCode,
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

  // PR2 §7 — 집계 결과 내보내기. recipe를 다시 안 받고 analysisRunId로 저장된 결과를 그대로
  // CSV로 포맷한다(재계산 없음) — stats.export_results는 이미 0028에서 default_all_roles=true.
  router.post('/export', auth, requireCapability(pool, 'stats.export_results'), csrfMiddleware, (req, res) =>
    handlePostExport(pool, req, res).catch(() => res.status(500).json(internalError())),
  );

  return router;
}

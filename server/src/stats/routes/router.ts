// Stats workbench router: feature gate, capabilities and the route table.
// Split out of routes/stats.ts (S6 P1-33); handler bodies unchanged.
// PR0-C — GET /catalog + POST /preview. PR1 — POST /analyze(동기). §D-6 통합 파이프라인:
// 코호트 미달이든 differencing 초과든 같은 마스킹 페이로드로 응답하고, 감사·resultDigest
// 계산은 예외 없이 거친다. handlePostPreview/handlePostAnalyze는 stats/recipe/analysisContext.ts의
// buildAnalysisContext()를 공유한다(순수 추출, 계획서 pr1-giggly-treehouse.md §4.1).
import { Router } from 'express';
import type { Pool } from 'pg';
import { createAuthMiddleware } from '../../middleware/auth';
import { csrfMiddleware } from '../../middleware/csrf';
import { requireCapability } from '../../middleware/requireCapability';
import { analyzeRateLimit } from '../../middleware/rateLimit';
import { handlePostAnalyze } from './analyzeHandler';
import { handlePostExport } from '../export/exportHandler';
import { asyncHandler } from '../../http/asyncHandler';
import { requireFeature } from '../../http/authz';
import { getStatsWorkbenchAvailability } from '../policy/workbenchRuntimeState';
import { handleGetCatalog, handlePostPreview } from './catalogPreview';
import { handleGetRun, handlePostCancelRun } from './runs';

export function createStatsRouter(pool: Pool) {
  const router = Router();
  const auth = createAuthMiddleware(pool);
  // Runtime availability (intranet + flag + health) first: while the workbench is closed every route
  // answers 404 so its existence is not revealed — even before authentication (S4 / P1-15). Pass the
  // boolean, not the availability object (that would always be truthy).
  router.use(requireFeature(() => getStatsWorkbenchAvailability().available));

  router.get('/catalog', auth, requireCapability(pool, 'stats.view'), asyncHandler((req, res) => handleGetCatalog(req, res)),
  );

  router.post('/preview', auth, requireCapability(pool, 'stats.view'), csrfMiddleware, asyncHandler((req, res) => handlePostPreview(pool, req, res)),
  );

  // PR1 — stats.regression은 0028_capability_grants.sql에서 이미 default_all_roles=true로
  // 정의돼 있다(§4.1) — 별도 user_capability_grants 부여가 새로 필요해지지 않는다.
  router.post('/analyze', auth, requireCapability(pool, 'stats.regression'), analyzeRateLimit(), csrfMiddleware, asyncHandler((req, res) => handlePostAnalyze(pool, req, res)),
  );

  // PR4-B1 — 폴링·취소. 기존 POST /analyze와 같은 capability로 게이트(§5 기존 관례).
  router.get('/runs/:analysisRunId', auth, requireCapability(pool, 'stats.regression'), asyncHandler((req, res) => handleGetRun(pool, req, res)),
  );
  router.post('/runs/:analysisRunId/cancel', auth, requireCapability(pool, 'stats.regression'), csrfMiddleware, asyncHandler((req, res) => handlePostCancelRun(pool, req, res)),
  );

  // PR2 §7 — 집계 결과 내보내기. recipe를 다시 안 받고 analysisRunId로 저장된 결과를 그대로
  // CSV로 포맷한다(재계산 없음) — stats.export_results는 이미 0028에서 default_all_roles=true.
  router.post('/export', auth, requireCapability(pool, 'stats.export_results'), csrfMiddleware, asyncHandler((req, res) => handlePostExport(pool, req, res)),
  );

  return router;
}

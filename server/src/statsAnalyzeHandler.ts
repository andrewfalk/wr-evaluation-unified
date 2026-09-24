// PR1 §4 / PR4-B1 §0·§B — POST /analyze 핸들러. 계획서(pr4-b-virtual-pnueli.md)
// 11차 통합본 참고. 핵심 불변식:
//   - 공개통제(억제·메서드가용성)·입력상한 검사는 admission보다 먼저, 실행
//     가능하다고 판정된 요청만 admission을 거친다(계산 불필요한 즉답은 행 자체를
//     안 만듦).
//   - admission 이후엔 전부 admission→attempt→finish 파이프라인을 탄다 — sync/async는
//     "HTTP가 결과를 얼마나 기다리는가"의 차이일 뿐, 실행 경로 자체는 하나다.
//   - 감사는 그 사건이 일어나는 트랜잭션 안에서 즉시 쓴다(admission이 캐시hit/합류/
//     거절을, finishRun이 실행의 최종 성패를 각각 담당) — §B는 일반 실행 감사를
//     다시 쓰지 않는다.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { withWriteTransaction } from './db/withWriteTransaction';
import type { AnalyzeResponse, AnalyzeResult, RunManifest, StatsRunManifestSucceeded } from '@wr/contracts';
import { buildAnalysisContext, type AnalysisContext } from './statsAnalysisContext';
import { canonicalDigest } from './canonicalSerializer';
import { computeExecutionDigest } from './statsExecutionDigest';
import { buildStatsEngineRequest } from './statsDescriptiveSuppression';
import {
  assertBivariateWithinLimits,
  assertRegressionWithinLimits,
  assertWithinLimits,
  StatsEngineInputTooLargeError,
} from './statsEngine';
import { buildBivariateEngineRequest } from './statsBivariateSuppression';
import { buildRegressionEngineRequest } from './statsRegressionSuppression';
import { buildRunManifest, toStatsRunManifestSucceeded } from './statsRunManifest';
import { allCorrelationMatrixPairs } from './statsCorrelationMatrixDataset';
import { attachLimitedRowFields } from './statsLimitedRowMerge';
import { hasCapability } from './middleware/requireCapability';
import { writeAuditLogStrict, type AuditOutcome } from './middleware/audit';
import { statsRunExpiresAt as expiresAt } from './statsRunExpiry';
import { admitAnalysisRun, estimateEngineTimeoutMs } from './statsRunAdmission';
import type { StatsRunRow } from './statsRunRow';
import config from './config';

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

const FAILURE_MESSAGES: Record<string, string> = {
  TIMEOUT: 'Analysis timed out.',
  PROCESS_ERROR: 'Analysis engine failed to complete.',
  INVALID_OUTPUT: 'Analysis engine returned invalid output.',
  OUTPUT_TOO_LARGE: 'Analysis output exceeded the supported size.',
  RESULT_SCHEMA_INVALID: 'Analysis engine returned a result that failed validation.',
  EXECUTION_VERSION_DRIFTED: 'Analysis engine version changed while this run was queued — please retry.',
  QUEUE_WAIT_EXCEEDED: 'Analysis could not start before the queue wait budget was exceeded — please retry.',
};

// ---------------------------------------------------------------------------
// 가드A — POST /analyze 핸들러 전체 수명(admission+폴링 대기 전부 포함)의 동시
// 처리 상한. 폴링 대기 구간까지 감싸는 것이 기존 취지("핸들러 전체 수명")와 일치.
// ---------------------------------------------------------------------------
let activeAnalyzeRequests = 0;

/** 테스트 전용. */
export function __resetAnalyzeHandlerForTests(): void {
  activeAnalyzeRequests = 0;
}

/** 테스트 전용 — 가드A 상한 초과 경로를 실제 동시요청 없이 직접 재현하기 위함. */
export function __setActiveAnalyzeRequestsForTests(n: number): void {
  activeAnalyzeRequests = n;
}

/** 응답에서는 항상 기존 RunManifest 계약만 노출한다 — outcome 판별 필드는 저장 계층 전용.
 * GET /runs/:analysisRunId(routes/stats.ts)도 이 함수를 재사용한다(export). */
export function toPublicRunManifest(manifest: StatsRunManifestSucceeded): RunManifest {
  const { outcome: _outcome, ...rest } = manifest;
  return rest;
}

// PR3-A — analysisMode==='bivariate'면 continuous/discrete 대신 bivariate 스텁을
// 만든다(계획서 §"결과 계약 불변조건" — 조기억제 경로에서도 bivariate 필드가 항상
// 존재해야 함). requestedMethod는 이 시점에 항상 존재한다(validateRecipe(analyze)가
// analysisMode==='bivariate'일 때 이미 보장 — buildAnalysisContext가 그 전에 실패함).
function buildSuppressedAnalyzeResult(ctx: AnalysisContext): AnalyzeResult {
  if (ctx.recipe.analysisMode === 'bivariate') {
    return { continuous: [], discrete: [], bivariate: { method: ctx.recipe.requestedMethod!, suppressed: true } };
  }
  if (ctx.recipe.analysisMode === 'correlation_matrix') {
    // PR3-B §4 — 요청 전체가 억제돼도 cells는 항상 C(k,2)개(전부 suppressed:true,
    // 절대 빈 배열이 아님 — "결과 계약 불변조건"을 상관행렬에도 동일하게 적용).
    const method = ctx.recipe.requestedMethod as 'pearson_correlation' | 'spearman_correlation';
    const cells = allCorrelationMatrixPairs(ctx.recipe.variableKeys).map(({ xKey, yKey }) => ({
      suppressed: true as const, xKey, yKey,
    }));
    return {
      continuous: [], discrete: [],
      correlationMatrix: { method, variableKeys: ctx.recipe.variableKeys, cells, adjustedPWithheld: true },
    };
  }
  if (ctx.recipe.analysisMode === 'regression') {
    // PR4-A1 §1 — 회귀 억제는 단일 사유(MIN_COHORT_NOT_MET)로 수렴하는
    // suppressed:true 스텁뿐이다(다른 필드 일절 없음 — 계약 strict).
    return {
      continuous: [], discrete: [],
      regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' },
    };
  }
  return {
    continuous: ctx.recipe.variableKeys
      .filter((k) => ctx.catalogByKey.get(k)?.type === 'continuous')
      .map((k) => ({ variableKey: k, kind: 'continuous' as const, suppressed: true as const })),
    discrete: ctx.recipe.variableKeys
      .filter((k) => ctx.catalogByKey.get(k)?.type !== 'continuous')
      .map((k) => ({ variableKey: k, kind: 'discrete' as const, suppressed: true as const })),
  };
}

function auditExtra(ctx: AnalysisContext, executionDigest: string, extra: Record<string, unknown>) {
  return {
    executionDigest,
    recipeDigest: ctx.recipeDigest,
    sourceDigest: ctx.snapshot.sourceDigest,
    grain: ctx.recipe.grain,
    variableKeys: ctx.recipe.variableKeys,
    analysisPurpose: ctx.recipe.analysisPurpose,
    formulaPolicies: ctx.recipe.formulaPolicies,
    queryFamilyDigest: ctx.queryFamilyDigest,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// §0 입력상한 사전검사 — 각 analysisMode가 실제로 엔진에 보낼 payload 기준으로,
// 엔진 내부(runEngineProcess의 assertLimits)와 정확히 같은 함수를 재사용한다.
// 로직 복제가 아니므로 두 지점의 검사 범위가 구조적으로 어긋날 수 없다.
//
// regression도 buildRegressionEngineRequest(computeRegressionAnalyzeResult와 완전히
// 동일한 함수)로 실제 covariance(cluster groups 포함)·splineContrasts까지 채운
// 진짜 요청을 만들어 검사한다(코드리뷰 2026-09-24 — covariance:hc3·splineContrasts:[]로
// 근사하던 이전 버전은 반복관측 cluster groups만으로도 실측 바이트 상한을 넘는
// 사례가 있었다 — 그 요청은 admission을 통과해 quota를 소비한 뒤 워커에서 뒤늦게
// PROCESS_ERROR로 실패했다, 의도한 400 INPUT_TOO_LARGE가 아니었다).
// correlation_matrix는 buildAnalysisContext의 evaluateCorrelationMatrixInputLimits가
// 이미 정확한 바이트 기준으로 검사했으므로 여기서 다시 하지 않는다.
// ---------------------------------------------------------------------------
function assertInputWithinLimitsForMode(ctx: AnalysisContext): void {
  if (ctx.recipe.analysisMode === 'descriptive') {
    const request = buildStatsEngineRequest(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey);
    assertWithinLimits(request);
    return;
  }
  if (ctx.recipe.analysisMode === 'bivariate') {
    if (!ctx.pairDisclosed || !ctx.paired || !ctx.recipe.requestedMethod) return;
    const [keyX, keyY] = ctx.recipe.variableKeys;
    const request = buildBivariateEngineRequest(ctx.recipe.requestedMethod, ctx.paired.pairs, ctx.catalogByKey, keyX, keyY);
    assertBivariateWithinLimits(request);
    return;
  }
  if (ctx.recipe.analysisMode === 'regression') {
    if (!ctx.regressionDisclosed || !ctx.regressionDesign?.ok) return;
    const { request } = buildRegressionEngineRequest(ctx.regressionDesign.design);
    assertRegressionWithinLimits(request);
  }
}

// PR3-B §9 — 캐시-권한 드리프트 방지. 신규계산·캐시hit·합류자 관측 3경로 전부
// 이 단일 지점을 거쳐야 한다. limited_row 필드(boxplot outlierValues·scatter 원시
// points)가 실제로 붙을 때만 신규 감사 단계를 추가하고, 그 감사가 실패하면
// 500을 반환한다 — aggregate로 강등하지 않는다(§7.4 "제한데이터 export는 감사
// 실패 시 다운로드도 실패"와 가장 단순하게 정합). GET /runs/:analysisRunId도
// 이 함수를 그대로 재사용한다(export).
export async function finalizeAnalyzeResponse(
  pool: Pool,
  ctx: AnalysisContext,
  executionDigest: string,
  outcome: { runManifest: RunManifest; result: AnalyzeResult },
): Promise<{ status: number; body: unknown }> {
  const hasLimitedRowAccess = await hasCapability(pool, 'stats.export_limited_rows', ctx.userId, ctx.orgId);
  const { result: finalResult, attached } = await attachLimitedRowFields(ctx, outcome.result, hasLimitedRowAccess);

  if (attached) {
    const deliveredResultDigest = canonicalDigest({ result: finalResult });
    try {
      await writeAuditLogStrict(pool, {
        actorUserId: ctx.userId,
        actorOrgId: ctx.orgId,
        action: 'stats_analyze',
        targetType: 'analysis_recipe',
        targetId: ctx.recipeDigest,
        outcome: 'success' as AuditOutcome,
        extra: auditExtra(ctx, executionDigest, {
          analysisRunId: outcome.runManifest.analysisRunId,
          limitedRowFieldsAttached: true,
          deliveredResultDigest,
        }),
      });
    } catch {
      return { status: 500, body: internalError() };
    }
  }

  return { status: 200, body: { runManifest: outcome.runManifest, result: finalResult } satisfies AnalyzeResponse };
}

// row.status가 종결(succeeded/failed/cancelled)일 때 HTTP 응답을 조립한다.
// succeeded만 finalizeAnalyzeResponse(limited_row 부착)를 거치고, failed/cancelled는
// 즉시 에러 바디를 만든다.
async function respondForTerminalRow(
  pool: Pool,
  ctx: AnalysisContext,
  executionDigest: string,
  row: Pick<StatsRunRow, 'status' | 'manifest' | 'result' | 'error_code'>,
): Promise<{ status: number; body: unknown }> {
  if (row.status === 'succeeded') {
    const manifest = row.manifest as StatsRunManifestSucceeded;
    return finalizeAnalyzeResponse(pool, ctx, executionDigest, {
      runManifest: toPublicRunManifest(manifest),
      result: row.result as AnalyzeResult,
    });
  }
  if (row.status === 'cancelled') {
    return { status: 409, body: { code: 'RUN_CANCELLED', error: 'Analysis was cancelled.' } };
  }
  // failed
  const code = row.error_code ?? 'PROCESS_ERROR';
  return { status: 500, body: { code, error: FAILURE_MESSAGES[code] ?? 'Analysis request failed.' } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function handlePostAnalyze(pool: Pool, req: Request, res: Response): Promise<void> {
  if (activeAnalyzeRequests >= config.stats.maxConcurrentAnalyzeRequests) {
    const session = req.sessionInfo;
    try {
      await writeAuditLogStrict(pool, {
        actorUserId: session?.userId ?? null,
        actorOrgId: session?.organizationId ?? null,
        action: 'stats_analyze',
        targetType: 'analysis_recipe',
        outcome: 'denied' as AuditOutcome,
        extra: { reasonCode: 'REQUEST_CAPACITY_EXCEEDED' },
      });
    } catch {
      res.status(500).json(internalError());
      return;
    }
    res.status(429).json({ code: 'REQUEST_CAPACITY_EXCEEDED', error: 'Too many concurrent analysis requests' });
    return;
  }
  activeAnalyzeRequests += 1;

  try {
    const built = await buildAnalysisContext(pool, req, 'analyze');
    if (!built.ok) {
      res.status(built.status).json(built.body);
      return;
    }
    const ctx = built.ctx;

    const executionDigest = computeExecutionDigest({
      organizationId: ctx.orgId,
      requestedBy: ctx.userId,
      recipeDigest: ctx.recipeDigest,
      sourceDigest: ctx.snapshot.sourceDigest,
    });

    // 기존 로직 그대로(위치 불변) — 계산이 필요 없는 즉답이라 admission을 거치지
    // 않는다. differencing은 시간에 따라 바뀌므로 이 분기가 admission(캐시 포함)
    // 보다 반드시 먼저여야 한다.
    const bivariatePairSuppressed = ctx.recipe.analysisMode === 'bivariate' && !ctx.pairDisclosed;
    const regressionSuppressed = ctx.recipe.analysisMode === 'regression' && !ctx.regressionDisclosed;
    if (ctx.requestSuppressed || bivariatePairSuppressed || regressionSuppressed) {
      const suppressedResult = buildSuppressedAnalyzeResult(ctx);
      const resultDigest = canonicalDigest({ result: suppressedResult });
      const manifest = toStatsRunManifestSucceeded(
        buildRunManifest({
          recipeDigest: ctx.recipeDigest,
          sourceDigest: ctx.snapshot.sourceDigest,
          resultDigest,
          snapshotAsOf: ctx.snapshot.snapshotAsOf,
          formulaPolicies: ctx.recipe.formulaPolicies,
          analysisMode: ctx.recipe.analysisMode,
        }),
      );

      await withWriteTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO stats_runs (
             organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
             requested_disclosure_profile, cacheable, manifest, result, expires_at, finished_at,
             analysis_run_id
           ) VALUES ($1,$2,'succeeded',$3,$4,$5,'aggregate',false,$6,$7,$8,now(),$9)`,
          [ctx.orgId, ctx.userId, ctx.recipeDigest, ctx.snapshot.sourceDigest, executionDigest,
            JSON.stringify(manifest), JSON.stringify(suppressedResult), expiresAt(), manifest.analysisRunId],
        );
        await writeAuditLogStrict(client, {
          actorUserId: ctx.userId,
          actorOrgId: ctx.orgId,
          action: 'stats_analyze',
          targetType: 'analysis_recipe',
          targetId: ctx.recipeDigest,
          outcome: 'denied' as AuditOutcome,
          extra: auditExtra(ctx, executionDigest, {
            analysisRunId: manifest.analysisRunId,
            reasonCode: ctx.reasonCode ?? (bivariatePairSuppressed || regressionSuppressed ? 'MIN_COHORT_NOT_MET' : null),
          }),
        });
      });

      const response: AnalyzeResponse = { runManifest: toPublicRunManifest(manifest), result: suppressedResult };
      res.status(200).json(response);
      return;
    }

    if (ctx.recipe.analysisMode === 'bivariate' || ctx.recipe.analysisMode === 'correlation_matrix' || ctx.recipe.analysisMode === 'regression') {
      const selected = ctx.availableMethods.find((m) => m.id === ctx.recipe.requestedMethod);
      const executable = selected != null && (selected.status === 'available' || selected.status === 'conditional');
      if (!executable) {
        await writeAuditLogStrict(pool, {
          actorUserId: ctx.userId,
          actorOrgId: ctx.orgId,
          action: 'stats_analyze',
          targetType: 'analysis_recipe',
          targetId: ctx.recipeDigest,
          outcome: 'denied' as AuditOutcome,
          extra: auditExtra(ctx, executionDigest, { reasonCode: 'METHOD_NOT_AVAILABLE' }),
        });
        res.status(400).json({ code: 'METHOD_NOT_AVAILABLE', error: '선택한 분석 방법을 현재 데이터로 실행할 수 없습니다.' });
        return;
      }
    }

    // 입력상한 — 실패 시 admission 자체를 아예 안 거친다(오늘과 동일한 UX, row
    // 생성 없음).
    try {
      assertInputWithinLimitsForMode(ctx);
    } catch (err) {
      if (!(err instanceof StatsEngineInputTooLargeError)) throw err;
      await writeAuditLogStrict(pool, {
        actorUserId: ctx.userId,
        actorOrgId: ctx.orgId,
        action: 'stats_analyze',
        targetType: 'analysis_recipe',
        targetId: ctx.recipeDigest,
        outcome: 'denied' as AuditOutcome,
        extra: auditExtra(ctx, executionDigest, { reasonCode: 'INPUT_TOO_LARGE' }),
      });
      res.status(400).json({ code: 'INPUT_TOO_LARGE', error: 'The recipe exceeds the supported size for statistical analysis.' });
      return;
    }

    // 여기부터만 admission.
    const engineTimeoutMs = estimateEngineTimeoutMs(ctx);
    const admission = await admitAnalysisRun(pool, ctx, executionDigest, engineTimeoutMs);

    if (admission.kind === 'denied') {
      res.status(admission.status).json({ code: admission.code, error: 'Request denied.' });
      return;
    }
    if (admission.kind === 'cache_hit') {
      const finalized = await respondForTerminalRow(pool, ctx, executionDigest, admission.row);
      res.status(finalized.status).json(finalized.body);
      return;
    }

    // admitted 또는 joined — syncBudgetMs 동안 짧게 폴링. 예산 0이어도 admission이
    // 이미 반환한 최신 상태로 최소 1회는 판정한다.
    const deadline = Date.now() + config.stats.async.syncBudgetMs;
    let fresh = admission.row;
    while (true) {
      if (fresh.status === 'succeeded' || fresh.status === 'failed' || fresh.status === 'cancelled') {
        const finalized = await respondForTerminalRow(pool, ctx, executionDigest, fresh);
        res.status(finalized.status).json(finalized.body);
        return;
      }
      if (Date.now() >= deadline) {
        res.status(202).json({ analysisRunId: admission.row.analysis_run_id, status: fresh.status });
        return;
      }
      await sleep(config.stats.async.pollTickMs);
      const polled = await pool.query<StatsRunRow>(
        `SELECT status, manifest, result, error_code FROM stats_runs WHERE analysis_run_id=$1 AND organization_id=$2`,
        [admission.row.analysis_run_id, ctx.orgId],
      );
      if (polled.rows.length === 0) {
        // TTL cleanup이 그 사이 지웠을 극단적 경우 — 방어적으로 failed 취급.
        res.status(500).json(internalError());
        return;
      }
      fresh = { ...fresh, ...polled.rows[0] };
    }
  } finally {
    activeAnalyzeRequests -= 1;
  }
}

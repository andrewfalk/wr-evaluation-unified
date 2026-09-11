// PR1 §4 — POST /analyze 핸들러. 계획서(pr1-giggly-treehouse.md) §4.0/§4.3/§5/§6을
// 그대로 구현한다. 6차례 검토를 거친 핵심 불변식:
//   - 생성자(이 digest 계산을 새로 시작한 요청)만 stats_runs 저장을 책임지고, 그 저장을
//     자신의 감사 기록과 하나의 트랜잭션으로 묶는다.
//   - 합류자(진행 중인 계산에 올라탄 요청)는 stats_runs에 절대 쓰지 않고 자신의 감사만
//     별도로 남긴다 — 공유 계산의 결과와 "내 감사 기록 자체의 성공 여부"를 분리한다.
//   - 요청 단위 억제(코호트미달/differencing)는 cacheable=false로 매번 새 행 — 캐시에
//     절대 섞이지 않는다.
//   - "실행 전 거부"(ENGINE_BUSY/ENGINE_DEGRADED/INPUT_TOO_LARGE — worker가 시작조차
//     못함)와 "실제로 시작한 worker의 실패"는 다르게 저장·감사한다.
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { AnalyzeResponse, AnalyzeResult, RunManifest, StatsRunManifestSucceeded } from '@wr/contracts';
import { buildAnalysisContext, type AnalysisContext } from './statsAnalysisContext';
import { canonicalDigest } from './canonicalSerializer';
import { computeExecutionDigest } from './statsExecutionDigest';
import { getOrCompute } from './statsAnalyzeInFlight';
import { buildStatsEngineRequest, computeDescriptiveSuppression } from './statsDescriptiveSuppression';
import {
  runStatsEngine,
  StatsEngineBusyError,
  StatsEngineDegradedError,
  StatsEngineInputTooLargeError,
  StatsEngineOutputTooLargeError,
  StatsEngineProcessError,
  StatsEngineResultInvalidError,
  StatsEngineTimeoutError,
} from './statsEngine';
import { buildRunManifest, buildFailedStatsRunManifest, toStatsRunManifestSucceeded } from './statsRunManifest';
import { computeBivariateAnalyzeResult } from './statsBivariateSuppression';
import { writeAuditLogStrict, type AuditOutcome } from './middleware/audit';
import config from './config';

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

// ---------------------------------------------------------------------------
// 가드A — POST /analyze 핸들러 전체 수명(snapshot+buildDataset+Python+DB저장 전부 포함)의
// 동시 처리 상한. 가드C(Python 세마포어, statsEngine.ts)와 독립된 Node 측 전처리 자원가드.
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

type EngineErrorClassification = 'denied' | 'failure';

function classifyEngineError(err: unknown): EngineErrorClassification {
  if (
    err instanceof StatsEngineBusyError ||
    err instanceof StatsEngineDegradedError ||
    err instanceof StatsEngineInputTooLargeError
  ) {
    return 'denied';
  }
  return 'failure';
}

function reasonCodeForDenied(err: unknown): string {
  if (err instanceof StatsEngineBusyError) return 'ENGINE_BUSY';
  if (err instanceof StatsEngineDegradedError) return 'ENGINE_DEGRADED';
  if (err instanceof StatsEngineInputTooLargeError) return 'INPUT_TOO_LARGE';
  return 'UNKNOWN_DENIED';
}

function errorCodeForFailure(err: unknown): 'TIMEOUT' | 'PROCESS_ERROR' | 'INVALID_OUTPUT' | 'OUTPUT_TOO_LARGE' | 'RESULT_SCHEMA_INVALID' {
  if (err instanceof StatsEngineTimeoutError) return 'TIMEOUT';
  if (err instanceof StatsEngineOutputTooLargeError) return 'OUTPUT_TOO_LARGE';
  if (err instanceof StatsEngineResultInvalidError) return 'RESULT_SCHEMA_INVALID';
  if (err instanceof StatsEngineProcessError) return err.code === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : 'PROCESS_ERROR';
  return 'PROCESS_ERROR';
}

function httpStatusFor(err: unknown): number {
  if (err instanceof StatsEngineBusyError) return 429;
  if (err instanceof StatsEngineDegradedError) return 503;
  if (err instanceof StatsEngineInputTooLargeError) return 400;
  return 500;
}

// 7차 검토 필수 수정 — err.message를 HTTP 응답에 그대로 실으면 spawn 실행 경로, §2.2
// 의미검증의 기대/실제 n, DB 오류 문구 등 서버 내부 정보가 새어나간다("오류 상세는 서버
// 로그에만"이라는 계획 원칙 위반). 코드별 고정 메시지만 응답에 싣고, 실제 상세는 로그로만.
const DENIED_MESSAGES: Record<string, string> = {
  ENGINE_BUSY: 'Analysis engine is busy — please retry shortly.',
  ENGINE_DEGRADED: 'Analysis engine is temporarily unavailable.',
  INPUT_TOO_LARGE: 'The recipe exceeds the supported size for statistical analysis.',
  UNKNOWN_DENIED: 'Request denied.',
};
const FAILURE_MESSAGES: Record<string, string> = {
  TIMEOUT: 'Analysis timed out.',
  PROCESS_ERROR: 'Analysis engine failed to complete.',
  INVALID_OUTPUT: 'Analysis engine returned invalid output.',
  OUTPUT_TOO_LARGE: 'Analysis output exceeded the supported size.',
  RESULT_SCHEMA_INVALID: 'Analysis engine returned a result that failed validation.',
};

function errorBodyFor(err: unknown): { code: string; error: string } {
  const classification = classifyEngineError(err);
  const code = classification === 'denied' ? reasonCodeForDenied(err) : errorCodeForFailure(err);
  const message = (classification === 'denied' ? DENIED_MESSAGES[code] : FAILURE_MESSAGES[code]) ?? 'Analysis request failed.';
  console.error('[stats-analyze] request failed', { code, classification, detail: err instanceof Error ? err.message : err });
  return { code, error: message };
}

/** 응답에서는 항상 기존 RunManifest 계약만 노출한다 — outcome 판별 필드는 저장 계층 전용. */
function toPublicRunManifest(manifest: StatsRunManifestSucceeded): RunManifest {
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
  return {
    continuous: ctx.recipe.variableKeys
      .filter((k) => ctx.catalogByKey.get(k)?.type === 'continuous')
      .map((k) => ({ variableKey: k, kind: 'continuous' as const, suppressed: true as const })),
    discrete: ctx.recipe.variableKeys
      .filter((k) => ctx.catalogByKey.get(k)?.type !== 'continuous')
      .map((k) => ({ variableKey: k, kind: 'discrete' as const, suppressed: true as const })),
  };
}

function expiresAt(): Date {
  return new Date(Date.now() + config.stats.resultTtlHours * 60 * 60 * 1000);
}

async function withWriteTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
// 생성자 전용 — 합류자는 이 함수를 절대 호출하지 않는다(getOrCompute가 보장).
// 캐시 hit/신규 계산 어느 경로든 이 함수 안에서 결과 저장 + 생성자 자신의 감사를
// 하나의 트랜잭션으로 원자적으로 끝낸다.
// ---------------------------------------------------------------------------
async function computeAndPersist(
  pool: Pool,
  ctx: AnalysisContext,
  executionDigest: string,
): Promise<{ runManifest: RunManifest; result: AnalyzeResult }> {
  const cacheHit = await pool.query<{ manifest: StatsRunManifestSucceeded; result: AnalyzeResult }>(
    `SELECT manifest, result FROM stats_runs
      WHERE organization_id = $1 AND execution_digest = $2 AND status = 'succeeded' AND cacheable AND expires_at > now()
      LIMIT 1`,
    [ctx.orgId, executionDigest],
  );

  if (cacheHit.rows.length > 0) {
    const { manifest, result } = cacheHit.rows[0];
    await writeAuditLogStrict(pool, {
      actorUserId: ctx.userId,
      actorOrgId: ctx.orgId,
      action: 'stats_analyze',
      targetType: 'analysis_recipe',
      targetId: ctx.recipeDigest,
      outcome: 'success',
      extra: auditExtra(ctx, executionDigest, { analysisRunId: manifest.analysisRunId, cached: true }),
    });
    return { runManifest: toPublicRunManifest(manifest), result };
  }

  // 7차 검토 필수 수정(방어적 2차 안전망) — runStatsEngine() 호출뿐 아니라 그 결과를 쓰는
  // computeDescriptiveSuppression/canonicalDigest/buildRunManifest까지 이 try 안에
  // 넣는다. §2.2 의미검증·zod .finite()가 1차 방어선이지만, 혹시 그걸 뚫고 나온 값(또는
  // 예상 못 한 다른 예외)이 이 블록 밖에서 터지면 분류·저장·감사 없이 그냥 reject되는
  // 구멍이 생긴다 — 그 구멍을 없앤다(실제로 canonicalDigest가 NaN/Infinity에서 throw
  // 하는 경로로 재현됨).
  let succeededManifest: ReturnType<typeof toStatsRunManifestSucceeded>;
  let result: AnalyzeResult;
  try {
    if (ctx.recipe.analysisMode === 'bivariate') {
      const bivariate = await computeBivariateAnalyzeResult(ctx);
      result = { continuous: [], discrete: [], bivariate };
    } else {
      const request = buildStatsEngineRequest(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey);
      const raw = await runStatsEngine(request);
      result = computeDescriptiveSuppression(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey, raw);
    }
    const resultDigest = canonicalDigest({ result });
    const runManifestBase = buildRunManifest({
      recipeDigest: ctx.recipeDigest,
      sourceDigest: ctx.snapshot.sourceDigest,
      resultDigest,
      snapshotAsOf: ctx.snapshot.snapshotAsOf,
      formulaPolicies: ctx.recipe.formulaPolicies,
      analysisMode: ctx.recipe.analysisMode,
    });
    succeededManifest = toStatsRunManifestSucceeded(runManifestBase);
  } catch (err) {
    const classification = classifyEngineError(err);
    if (classification === 'denied') {
      await withWriteTransaction(pool, async (client) => {
        await writeAuditLogStrict(client, {
          actorUserId: ctx.userId,
          actorOrgId: ctx.orgId,
          action: 'stats_analyze',
          targetType: 'analysis_recipe',
          targetId: ctx.recipeDigest,
          outcome: 'denied' as AuditOutcome,
          extra: auditExtra(ctx, executionDigest, { reasonCode: reasonCodeForDenied(err) }),
        });
      });
      throw err;
    }

    // 실제로 worker가 시작됐다가 실패 — failed 행 + failure 감사를 원자적으로 저장.
    const failedManifest = buildFailedStatsRunManifest({
      recipeDigest: ctx.recipeDigest,
      sourceDigest: ctx.snapshot.sourceDigest,
      snapshotAsOf: ctx.snapshot.snapshotAsOf,
      formulaPolicies: ctx.recipe.formulaPolicies,
      analysisMode: ctx.recipe.analysisMode,
    });
    const errorCode = errorCodeForFailure(err);
    await withWriteTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO stats_runs (
           organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
           requested_disclosure_profile, cacheable, manifest, result, error_code, expires_at, finished_at,
           analysis_run_id
         ) VALUES ($1,$2,'failed',$3,$4,$5,'aggregate',true,$6,NULL,$7,$8,now(),$9)`,
        [ctx.orgId, ctx.userId, ctx.recipeDigest, ctx.snapshot.sourceDigest, executionDigest,
          JSON.stringify(failedManifest), errorCode, expiresAt(), failedManifest.analysisRunId],
      );
      await writeAuditLogStrict(client, {
        actorUserId: ctx.userId,
        actorOrgId: ctx.orgId,
        action: 'stats_analyze',
        targetType: 'analysis_recipe',
        targetId: ctx.recipeDigest,
        outcome: 'failure' as AuditOutcome,
        extra: auditExtra(ctx, executionDigest, { analysisRunId: failedManifest.analysisRunId, errorCode }),
      });
    });
    // 합류자가 같은 analysisRunId를 참조할 수 있도록 에러 객체에 실어 전파한다.
    (err as { analysisRunId?: string }).analysisRunId = failedManifest.analysisRunId;
    throw err;
  }

  const persisted = await withWriteTransaction(pool, async (client) => {
    let manifest = succeededManifest;
    let finalResult = result;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await client.query(
        `DELETE FROM stats_runs
          WHERE organization_id = $1 AND execution_digest = $2 AND status = 'succeeded' AND cacheable AND expires_at <= now()`,
        [ctx.orgId, executionDigest],
      );
      const insertResult = await client.query<{ id: string; manifest: StatsRunManifestSucceeded; result: AnalyzeResult }>(
        `INSERT INTO stats_runs (
           organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
           requested_disclosure_profile, cacheable, manifest, result, expires_at, finished_at,
           analysis_run_id
         ) VALUES ($1,$2,'succeeded',$3,$4,$5,'aggregate',true,$6,$7,$8,now(),$9)
         ON CONFLICT (organization_id, execution_digest) WHERE status = 'succeeded' AND cacheable
         DO NOTHING
         RETURNING id, manifest, result`,
        [ctx.orgId, ctx.userId, ctx.recipeDigest, ctx.snapshot.sourceDigest, executionDigest,
          JSON.stringify(manifest), JSON.stringify(finalResult), expiresAt(), manifest.analysisRunId],
      );
      if (insertResult.rows.length > 0) {
        manifest = insertResult.rows[0].manifest;
        finalResult = insertResult.rows[0].result;
        break;
      }
      const reselect = await client.query<{ manifest: StatsRunManifestSucceeded; result: AnalyzeResult }>(
        `SELECT manifest, result FROM stats_runs
          WHERE organization_id = $1 AND execution_digest = $2 AND status = 'succeeded' AND cacheable
          LIMIT 1`,
        [ctx.orgId, executionDigest],
      );
      if (reselect.rows.length > 0) {
        manifest = reselect.rows[0].manifest;
        finalResult = reselect.rows[0].result;
        break;
      }
      if (attempt === 2) {
        throw new StatsEngineProcessError('PROCESS_ERROR', 'execution_digest 캐시 경쟁이 재시도 한도 내에 해소되지 않음');
      }
      // 루프 재시도 — 그 사이 만료된 행이 다시 생겼을 가능성에 대비.
    }

    await writeAuditLogStrict(client, {
      actorUserId: ctx.userId,
      actorOrgId: ctx.orgId,
      action: 'stats_analyze',
      targetType: 'analysis_recipe',
      targetId: ctx.recipeDigest,
      outcome: 'success' as AuditOutcome,
      extra: auditExtra(ctx, executionDigest, { analysisRunId: manifest.analysisRunId }),
    });

    return { manifest, result: finalResult };
  });

  return { runManifest: toPublicRunManifest(persisted.manifest), result: persisted.result };
}

export async function handlePostAnalyze(pool: Pool, req: Request, res: Response): Promise<void> {
  if (activeAnalyzeRequests >= config.stats.maxConcurrentAnalyzeRequests) {
    const session = req.sessionInfo;
    // 9차 검토 필수 수정 — 이전 판은 .catch(() => {})로 감사 실패를 삼키고 그대로
    // 429를 내보냈다. 다른 모든 경로("실행 전 거부"의 denied 감사·성공/실패 감사)는
    // 전부 "감사 기록이 실패하면 요청도 실패한다"는 원칙을 지키는데 이 경로만 예외였다
    // (실제로 감사 DB 오류를 주입해 429가 기록 없이 정상 응답으로 나가는 것을 확인).
    // 여기도 같은 원칙을 적용해 감사 실패를 500으로 승격한다.
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

    // §4.4 — 억제 경로 포함 항상 계산한다(NOT NULL 컬럼 문제·요청단위 억제도 digest를
    // 갖는다는 계획서 결정).
    const executionDigest = computeExecutionDigest({
      organizationId: ctx.orgId,
      requestedBy: ctx.userId,
      recipeDigest: ctx.recipeDigest,
      sourceDigest: ctx.snapshot.sourceDigest,
    });

    // PR3-A §"파이프라인" — 기존 request-level 억제(전체 데이터셋 MIN_COHORT·
    // differencing)와 새 쌍-level 억제(레이어1, ctx.pairDisclosed)를 OR로 합친다.
    // 이변량이 아니면 pairDisclosed는 항상 false지만 requestSuppressed로만 판정하므로
    // 영향 없다.
    const bivariatePairSuppressed = ctx.recipe.analysisMode === 'bivariate' && !ctx.pairDisclosed;
    if (ctx.requestSuppressed || bivariatePairSuppressed) {
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
            reasonCode: ctx.reasonCode ?? (bivariatePairSuppressed ? 'MIN_COHORT_NOT_MET' : null),
          }),
        });
      });

      const response: AnalyzeResponse = { runManifest: toPublicRunManifest(manifest), result: suppressedResult };
      res.status(200).json(response);
      return;
    }

    // PR3-A — 파이프라인 3단계: A-사유로 unsupported이거나 아예 목록에 없는 method면
    // 400(§"방법 가용성 판정" — B-사유는 여기서 절대 걸리지 않는다, 이미 위에서
    // pairDisclosed 검사로 다 걸러졌거나 그룹/셀 단위 소수셀이라 여기 도달하지 않음).
    if (ctx.recipe.analysisMode === 'bivariate') {
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

    const { promise, joined } = getOrCompute(executionDigest, () => computeAndPersist(pool, ctx, executionDigest));

    if (!joined) {
      try {
        const outcome = await promise;
        const response: AnalyzeResponse = { runManifest: outcome.runManifest, result: outcome.result };
        res.status(200).json(response);
      } catch (err) {
        res.status(httpStatusFor(err)).json(errorBodyFor(err));
      }
      return;
    }

    // 합류자 — "공유 계산의 결과"와 "내 감사 기록 자체의 성공 여부"를 분리한다.
    let sharedOutcome:
      | { kind: 'success'; value: { runManifest: RunManifest; result: AnalyzeResult } }
      | { kind: 'denied' | 'failure'; err: unknown };
    try {
      sharedOutcome = { kind: 'success', value: await promise };
    } catch (err) {
      sharedOutcome = { kind: classifyEngineError(err), err };
    }

    try {
      if (sharedOutcome.kind === 'success') {
        await writeAuditLogStrict(pool, {
          actorUserId: ctx.userId,
          actorOrgId: ctx.orgId,
          action: 'stats_analyze',
          targetType: 'analysis_recipe',
          targetId: ctx.recipeDigest,
          outcome: 'success' as AuditOutcome,
          extra: auditExtra(ctx, executionDigest, {
            analysisRunId: sharedOutcome.value.runManifest.analysisRunId, cached: true, joinedInFlight: true,
          }),
        });
      } else {
        const analysisRunId = (sharedOutcome.err as { analysisRunId?: string })?.analysisRunId ?? null;
        await writeAuditLogStrict(pool, {
          actorUserId: ctx.userId,
          actorOrgId: ctx.orgId,
          action: 'stats_analyze',
          targetType: 'analysis_recipe',
          targetId: ctx.recipeDigest,
          outcome: sharedOutcome.kind as AuditOutcome,
          extra: auditExtra(ctx, executionDigest, {
            analysisRunId,
            joinedInFlight: true,
            reasonCode: sharedOutcome.kind === 'denied' ? reasonCodeForDenied(sharedOutcome.err) : undefined,
            errorCode: sharedOutcome.kind === 'failure' ? errorCodeForFailure(sharedOutcome.err) : undefined,
          }),
        });
      }
    } catch {
      // 이 요청 자신의 감사 기록 자체가 실패 — 계산 결과와 무관한 별개 문제로 처리한다.
      res.status(500).json(internalError());
      return;
    }

    if (sharedOutcome.kind === 'success') {
      const response: AnalyzeResponse = { runManifest: sharedOutcome.value.runManifest, result: sharedOutcome.value.result };
      res.status(200).json(response);
    } else {
      res.status(httpStatusFor(sharedOutcome.err)).json(errorBodyFor(sharedOutcome.err));
    }
  } finally {
    activeAnalyzeRequests -= 1;
  }
}

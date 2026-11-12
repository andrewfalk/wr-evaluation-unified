// Stats workbench: GET /runs/:analysisRunId and POST /runs/:analysisRunId/cancel.
// Split out of routes/stats.ts (S6 P1-33); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { hasCapability } from '../../middleware/requireCapability';
import { deriveAnalysisContext } from '../recipe/analysisContext';
import { finalizeAnalyzeResponse, isAbortedFinalize, toPublicRunManifest } from './analyzeHandler';
import { isLiftApplicable } from '../disclosure/liftedRecompute';
import { deliverStoredLimited, isStoredLimitedMode } from '../disclosure/storedLimited';
import { createResponseAbort } from './responseAbort';
import { requestCancel, hasVersionDrifted } from '../queue/runsQueue';
import { STATS_RUN_COLUMNS, type StatsRunRow } from '../queue/runRow';
import type { AnalyzeResult, StatsRunManifestSucceeded } from '@wr/contracts';
import { sessionOf } from '../../http/authz';
import config from '../../config';

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

export async function handleGetRun(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
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
  // 조회자의 현재 권한으로 고른다(stats/disclosure/storedLimited.ts). 권한이 없으면 저장된 일반본 그대로다.
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
  // 응답 완료 전에 연결이 끊기면 제한 해제 계산을 중단한다(res close 기반 — stats/routes/responseAbort.ts).
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

export async function handlePostCancelRun(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
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

  // S8: a run of another queue namespace (visible above, since reads are not namespaced) is not cancelled — 404.
  const result = await requestCancel(pool, analysisRunId, session.organizationId!, session.userId, config.queueNamespace);
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

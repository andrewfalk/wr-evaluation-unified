// 제한데이터(stats.export_limited_rows) 권한자에게 "실행 시점에 저장해 둔 해제본"(stats_runs.limited_result)을 전달한다.
// 상관행렬·예측 전용 — 이 모드들은 성공 직후 frozen_dataset(원본 행)을 지워서 기술통계·회귀·이변량처럼 조회 때 다시
// 계산할 수 없다(statsRunsQueue.ts frozenDatasetAfterSuccess). 그래서 권한자가 실행한 경우에만 워커가 일반본(result)과 해제본을
// 함께 만들어 둔다(attempt). 여기는 그 해제본을 "조회자의 현재 권한"으로 골라 내보내는 단일 지점이다.
//
// 보안 불변식:
//  - limited_result는 STATS_RUN_COLUMNS 밖이다. 이 모듈의 fetchStoredLimitedResult만 읽는다 — 일반 GET·캐시 hit·CSV export는
//    이 컬럼을 절대 읽지 않는다. 권한 확인이 끝나기 전에는 이 컬럼을 조회하지 않는다.
//  - 권한은 조회자의 "현재" 권한이다(실행자가 아니다). 조회 직후 한 번 더 확인하고, 회수됐으면 일반본을 돌려준다.
//  - 해제본을 내보내기 전에 strict 감사를 먼저 쓴다. 감사가 실패하면 500이고 일반본으로 강등하지 않는다.
//  - 이 모드들은 컨텍스트(frozen_dataset)가 없으므로 감사 extra는 실행 식별 정보만 담는다.
import type { Pool } from 'pg';
import type { AnalyzeResult, LimitedDisclosureStatus, RunManifest } from '@wr/contracts';
import { canonicalDigest } from './canonicalSerializer';
import { hasCapability } from './middleware/requireCapability';
import { writeAuditLog, writeAuditLogStrict, type AuditOutcome } from './middleware/audit';

const CAP = 'stats.export_limited_rows';

// 해제본을 실행 시점에 저장하는 모드 — 성공 직후 frozen_dataset을 지워 조회 때 재계산할 수 없는 모드. 예측은 계산에 수 분이 걸려
// 조회 경로에서 재계산할 수도 없다.
const STORED_LIMITED_MODES: ReadonlySet<string> = new Set(['correlation_matrix', 'prediction']);

export function isStoredLimitedMode(analysisMode: string | undefined): boolean {
  return analysisMode !== undefined && STORED_LIMITED_MODES.has(analysisMode);
}

export interface StoredLimitedViewer {
  userId: string;
  orgId: string;
}

export interface StoredLimitedRun {
  analysisRunId: string;
  executionDigest: string;
  recipeDigest: string;
  analysisMode: string;
  /** 공개용 manifest(RunManifest) — 호출부가 toPublicRunManifest로 이미 변환해서 넘긴다. */
  runManifest: RunManifest;
  /** stats_runs.result — 일반(집계) 결과. */
  result: AnalyzeResult;
  /**
   * 행의 execution_digest가 현재 코드의 버전 상수와 어긋났는가(GET만 해당 — POST는 digest가 일치해야 행이 적중한다).
   * 어긋난 실행의 해제본은 이전 규칙으로 만들어졌으므로 내보내지 않고 안내만 한다(기술통계의 unavailable_version_drift와 동일).
   */
  versionDrifted?: boolean;
}

export type StoredLimitedOutcome =
  | { status: number; body: unknown }
  | { aborted: true };

/**
 * 해제본 조회 전용 접근자. 호출부가 조회자의 stats.export_limited_rows 권한을 먼저 확인해야 한다.
 * 같은 조직의 성공한 미만료 행만 읽는다(일반 조회와 같은 범위). 해제본이 없으면 null.
 */
export async function fetchStoredLimitedResult(
  pool: Pool,
  organizationId: string,
  analysisRunId: string,
): Promise<AnalyzeResult | null> {
  const { rows } = await pool.query<{ limited_result: AnalyzeResult | null }>(
    `SELECT limited_result FROM stats_runs
      WHERE analysis_run_id=$1 AND organization_id=$2 AND status='succeeded' AND expires_at > now()`,
    [analysisRunId, organizationId],
  );
  return rows[0]?.limited_result ?? null;
}

function auditExtra(run: StoredLimitedRun, extra: Record<string, unknown>) {
  return {
    executionDigest: run.executionDigest,
    recipeDigest: run.recipeDigest,
    analysisRunId: run.analysisRunId,
    analysisMode: run.analysisMode,
    ...extra,
  };
}

/**
 * POST(캐시 hit·합류·신규 완료)와 GET /runs/:analysisRunId가 같은 이 함수를 쓴다.
 * 권한 없음 → 일반본 그대로. 권한 있음 → 해제본이 있으면 해제본(limitedDisclosure:'applied'), 없으면 일반본 +
 * 'unavailable_source_missing'(권한을 받기 전에 실행했거나 워커 시점에 권한이 회수됨 — 재실행하면 해제된다).
 */
export async function deliverStoredLimited(
  pool: Pool,
  viewer: StoredLimitedViewer,
  run: StoredLimitedRun,
  signal?: AbortSignal,
): Promise<StoredLimitedOutcome> {
  const aggregate = (extra?: LimitedDisclosureStatus): StoredLimitedOutcome => ({
    status: 200,
    body: { runManifest: run.runManifest, result: extra ? { ...run.result, limitedDisclosure: extra } : run.result },
  });

  if (!(await hasCapability(pool, CAP, viewer.userId, viewer.orgId))) return aggregate();
  if (signal?.aborted) return { aborted: true };
  if (run.versionDrifted) return aggregate('unavailable_version_drift');

  // 권한이 확인된 뒤에만 해제본 컬럼을 읽는다.
  const limited = await fetchStoredLimitedResult(pool, viewer.orgId, run.analysisRunId);
  if (signal?.aborted) return { aborted: true };

  if (limited === null) {
    // 공개된 것이 없으므로 best-effort 감사(기술통계 폴백과 같은 규칙). 감사 실패가 응답을 막지 않는다.
    try {
      await writeAuditLog(pool, {
        actorUserId: viewer.userId,
        actorOrgId: viewer.orgId,
        action: 'stats_analyze',
        targetType: 'analysis_recipe',
        targetId: run.recipeDigest,
        outcome: 'success' as AuditOutcome,
        extra: auditExtra(run, { limitedRowFieldsAttached: false, smallCellLimitStatus: 'unavailable_source_missing' }),
      });
    } catch (err) {
      console.error('[stats-stored-limited] best-effort 폴백 감사 실패 — 응답은 그대로 반환', err);
    }
    if (signal?.aborted) return { aborted: true };
    return aggregate('unavailable_source_missing');
  }

  // 해제본 조회 사이에 권한이 회수됐을 수 있다 — 감사·공개 직전에 다시 확인한다.
  if (!(await hasCapability(pool, CAP, viewer.userId, viewer.orgId))) return aggregate();
  if (signal?.aborted) return { aborted: true };

  const finalResult: AnalyzeResult = { ...limited, limitedDisclosure: 'applied' };
  try {
    await writeAuditLogStrict(pool, {
      actorUserId: viewer.userId,
      actorOrgId: viewer.orgId,
      action: 'stats_analyze',
      targetType: 'analysis_recipe',
      targetId: run.recipeDigest,
      outcome: 'success' as AuditOutcome,
      extra: auditExtra(run, {
        limitedRowFieldsAttached: false,
        smallCellLimitStatus: 'applied' satisfies LimitedDisclosureStatus,
        limitedDisclosureSource: 'stored',
        deliveredResultDigest: canonicalDigest({ result: finalResult }),
      }),
    });
  } catch {
    return { status: 500, body: { code: 'INTERNAL_ERROR', error: 'Internal server error' } };
  }
  if (signal?.aborted) return { aborted: true };

  return { status: 200, body: { runManifest: run.runManifest, result: finalResult } };
}

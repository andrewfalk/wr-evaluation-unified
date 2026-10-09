// 제한데이터(stats.export_limited_rows) 권한자의 기술통계 응답 — 소수 셀(1~9명) 제한 해제.
//
// 집계 결과(stats_runs.result, 캐시)는 그대로 두고, 응답 직전(finalizeAnalyzeResponse)에 원본 행
// (ctx.dataset.rows)에서 억제 없는 결과를 다시 계산해 바꿔 보낸다. 해제된 수치를 캐시에 넣으면
// 권한 없는 조회자(같은 조직의 admin 등)에게 새므로 여기 결과는 절대 저장하지 않는다
// (프로세스 메모리 memo만 짧게 쓴다 — statsLimitedDisclosureGuard.ts).
//
// 호출 규칙: 일반/층화를 먼저 분기하고 각 분기에서 엔진을 정확히 한 번만 호출한다. 층화는
// 집계용 분할(ctx.descriptiveStratifyPartition, 소수 담당의가 "기타"로 병합됨)을 재사용하지 않고
// 원본 행에서 mergeSmallGroups:false로 새로 분할한다. 입력 상한은 실제로 엔진에 보낼 요청에
// assertWithinLimits로 검사한다(집계 경로의 사전검사는 병합된 분할 기준이라 같지 않다).
//
// 오류 처리: 예상되는 엔진 계열 오류만 unavailable_*로 매핑한다. 결과 무결성 assertion·zod 파싱·
// StatsEngineResultInvalidError는 잡지 않고 전파한다(구현·계약 결함이 폴백에 가려지지 않게).
import type { Pool } from 'pg';
import type { AnalyzeResult, LimitedDisclosureStatus } from '@wr/contracts';
import config from './config';
import type { AnalysisContext } from './statsAnalysisContext';
import { buildStatsEngineRequest, computeDescriptiveSuppression } from './statsDescriptiveSuppression';
import { partitionRowsForStratify } from './statsDescriptiveStratify';
import {
  computeDescriptiveStratifiedAnalyzeResult,
  resolveStratifyGroupLabels,
} from './statsDescriptiveStratifySuppression';
import {
  assertWithinLimits,
  runStatsEngine,
  StatsEngineBusyError,
  StatsEngineCancelledError,
  StatsEngineDegradedError,
  StatsEngineInputTooLargeError,
  StatsEngineOutputTooLargeError,
  StatsEngineProcessError,
  StatsEngineTimeoutError,
} from './statsEngine';
import { MAX_STRATIFY_GROUPS } from './statsEngineLimits';
import {
  getMemoizedUnrestricted,
  releaseUserLock,
  tryAcquireUserLock,
} from './statsLimitedDisclosureGuard';

export type UnrestrictedUnavailableStatus = Exclude<
  LimitedDisclosureStatus,
  'applied' | 'unavailable_source_missing' | 'unavailable_version_drift'
>;

export type UnrestrictedOutcome =
  | { kind: 'applied'; result: AnalyzeResult; source: 'computed' | 'memo' }
  | { kind: 'unavailable'; status: UnrestrictedUnavailableStatus }
  // 클라이언트 연결이 끊겼다 — 호출부는 응답·memo 저장·공개 감사를 하지 않고 즉시 중단한다.
  | { kind: 'aborted' };

// 계산 도중 "해제본을 만들 수 없다"고 확정된 경우(그룹 수 초과, 방법 실행 불가 등)를 집계본 폴백 상태와 함께 던진다.
// 결함이 아니라 예상된 폴백이므로 아래 resolveUnrestricted가 unavailable_*로 매핑한다.
export class UnrestrictedUnavailable extends Error {
  constructor(readonly status: UnrestrictedUnavailableStatus) {
    super(status);
  }
}

async function computeUnrestricted(
  pool: Pool,
  ctx: AnalysisContext,
  aggregate: AnalyzeResult,
  signal: AbortSignal | undefined,
): Promise<AnalyzeResult> {
  const opts = { timeoutMs: config.stats.timeoutMs, signal };
  const stratifyByKey = ctx.recipe.descriptive?.stratifyByKey;

  if (stratifyByKey) {
    const stratifyType = ctx.catalogByKey.get(stratifyByKey)?.type;
    const partition = partitionRowsForStratify(ctx.dataset.rows, stratifyByKey, stratifyType, { mergeSmallGroups: false });
    if (partition.groups.length > MAX_STRATIFY_GROUPS) throw new UnrestrictedUnavailable('unavailable_group_limit');
    const stratified = await computeDescriptiveStratifiedAnalyzeResult(ctx, opts, { unrestricted: true, partition });
    const labeled = await resolveStratifyGroupLabels(pool, ctx.orgId, ctx.catalogByKey, stratified);
    // 층화 결과는 최상위 continuous/discrete가 항상 빈 배열이다(진실 공급원 하나 — 계약).
    return { ...aggregate, continuous: [], discrete: [], descriptiveStratified: labeled };
  }

  const request = buildStatsEngineRequest(ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey);
  assertWithinLimits(request);
  const raw = await runStatsEngine(request, opts);
  const { continuous, discrete } = computeDescriptiveSuppression(
    ctx.dataset.rows, ctx.recipe.variableKeys, ctx.catalogByKey, raw, { unrestricted: true },
  );
  return { ...aggregate, continuous, discrete };
}

/**
 * 호출 전에 호출부가 (1) 조회자의 stats.export_limited_rows 권한 (2) analysisMode==='descriptive'를
 * 확인해야 한다. memo는 권한 검사 "뒤에" 조회한다.
 */
export async function resolveUnrestrictedDescriptive(
  pool: Pool,
  ctx: AnalysisContext,
  aggregate: AnalyzeResult,
  executionDigest: string,
  signal?: AbortSignal,
): Promise<UnrestrictedOutcome> {
  return resolveUnrestricted(ctx.userId, executionDigest, signal, () => computeUnrestricted(pool, ctx, aggregate, signal));
}

/**
 * 모드 무관 공통 골격 — abort 확인 → memo 조회 → 사용자당 동시 1건 락 → 계산 → 오류 매핑.
 * 기술통계 외 모드(statsLiftedRecompute.ts)도 락·memo·폴백 매핑을 복제하지 않고 이 함수를 쓴다.
 * 호출 전에 호출부가 조회자의 stats.export_limited_rows 권한을 확인해야 한다(memo는 그 "뒤에" 조회).
 */
export async function resolveUnrestricted(
  userId: string,
  executionDigest: string,
  signal: AbortSignal | undefined,
  compute: () => Promise<AnalyzeResult>,
): Promise<UnrestrictedOutcome> {
  if (signal?.aborted) return { kind: 'aborted' };

  const memoized = getMemoizedUnrestricted(executionDigest, userId);
  if (memoized) return { kind: 'applied', result: memoized, source: 'memo' };

  // 같은 사용자의 동시 해제 계산은 1건만 — 이미 돌고 있으면 기다리지 않고 폴백한다.
  if (!tryAcquireUserLock(userId)) return { kind: 'unavailable', status: 'unavailable_engine_busy' };
  try {
    const result = await compute();
    if (signal?.aborted) return { kind: 'aborted' };
    // memo는 여기서 저장하지 않는다 — 계산 뒤 권한 재검사·감사·취소 확인을 통과해 실제로 전달할 때만
    // 호출부(finalizeAnalyzeResponse)가 저장한다. 그 전에 저장하면 취소·회수된 요청의 해제 결과가 남는다.
    return { kind: 'applied', result, source: 'computed' };
  } catch (err) {
    if (err instanceof StatsEngineCancelledError || signal?.aborted) return { kind: 'aborted' };
    if (err instanceof StatsEngineBusyError) return { kind: 'unavailable', status: 'unavailable_engine_busy' };
    if (
      err instanceof StatsEngineTimeoutError
      || err instanceof StatsEngineProcessError
      || err instanceof StatsEngineOutputTooLargeError
    ) {
      return { kind: 'unavailable', status: 'unavailable_computation_failed' };
    }
    if (err instanceof StatsEngineDegradedError) return { kind: 'unavailable', status: 'unavailable_engine_degraded' };
    if (err instanceof StatsEngineInputTooLargeError) return { kind: 'unavailable', status: 'unavailable_input_too_large' };
    if (err instanceof UnrestrictedUnavailable) return { kind: 'unavailable', status: err.status };
    throw err; // StatsEngineResultInvalidError·무결성 assertion·zod 오류 등은 결함이므로 전파한다.
  } finally {
    releaseUserLock(userId);
  }
}

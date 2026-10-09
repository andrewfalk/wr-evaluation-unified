// 제한데이터(stats.export_limited_rows) 권한자 응답 시점 해제 — 기술통계 외 "조회 시 재계산" 모드(현재 회귀).
//
// 기술통계(statsDescriptiveUnrestricted.ts)와 같은 원칙이다: 집계 결과(stats_runs.result, 캐시)는 그대로 두고
// 응답 직전에 원본 행(ctx.dataset)으로 소수 셀(1~9명) 게이트만 끈 컨텍스트(deriveLiftedContext)를 만들어 다시
// 계산한다. 해제된 수치는 절대 저장하지 않는다. 락·memo·오류→unavailable_* 매핑은 resolveUnrestricted를 그대로 쓴다.
//
// 통계적 계산 가능 조건(완전사례 수, 분산 0, EPV, rank 등)은 lifted 컨텍스트에서도 그대로 판정된다 —
// 소수 인원 때문에 가려졌던 결과가 풀리면 계산 가능 여부에 따라 추정 결과 또는 non_estimable 사유가 나온다.
import type { Pool } from 'pg';
import type { AnalyzeResult } from '@wr/contracts';
import config from './config';
import { hasCapability } from './middleware/requireCapability';
import { deriveLiftedContext, type AnalysisContext } from './statsAnalysisContext';
import {
  resolveUnrestricted,
  UnrestrictedUnavailable,
  type UnrestrictedOutcome,
} from './statsDescriptiveUnrestricted';
import { computeRegressionAnalyzeResult } from './statsRegressionSuppression';

/**
 * 저장된 집계 결과에서 실제로 "풀 것이 있는" 실행인가. 풀 것이 없는데 재계산하면 엔진을 낭비하고
 * 일반 응답과 같은 결과에 '해제됨' 표시만 붙는다.
 * - 회귀: 공개통제 ③이 닫혀 suppressed 스텁으로 저장된 실행만. ③을 통과한 실행은 결과 자체에 가려진 값이 없다.
 * 기술통계는 기존 경로(resolveUnrestrictedDescriptive)가 별도로 처리하므로 여기서 다루지 않는다.
 */
export function isLiftApplicable(analysisMode: string, aggregate: AnalyzeResult): boolean {
  if (analysisMode === 'regression') return aggregate.regression?.suppressed === true;
  return false;
}

/** restricted 컨텍스트에서 소수 셀(1~9명) 게이트 때문에 "가려진 것"이 있는가. 가려진 게 없으면 해제해도 같은 결과다. */
function isRestrictedMasked(ctx: AnalysisContext): boolean {
  if (ctx.recipe.analysisMode === 'regression') return ctx.requestSuppressed || !ctx.regressionDisclosed;
  return false;
}

/**
 * 미리보기(와 이후 PR의 실행 가능성 판정·admission)가 쓰는 "유효 컨텍스트".
 * 공개 게이트가 닫히면 availableMethods가 비어 있어(statsAnalysisContext.ts) 권한자도 실행 가능 여부를 알 수 없다.
 * 권한자이고 풀 것이 있으면 소수 셀 게이트를 끈 컨텍스트를 돌려주고, 아니면 입력 ctx를 그대로 돌려준다.
 * 권한 조회(DB 1회)는 가려진 것이 실제로 있을 때만 한다 — 대부분의 요청은 조회 없이 끝난다.
 * differencing(forceSuppress)은 풀지 않는다. 기술통계는 기존 경로(routes/stats.ts liftPossible)가 처리한다.
 */
export async function resolveEffectiveContext(
  pool: Pool,
  ctx: AnalysisContext,
): Promise<{ ctx: AnalysisContext; lifted: boolean }> {
  if (ctx.differencing.forceSuppress || !isRestrictedMasked(ctx)) return { ctx, lifted: false };
  if (!(await hasCapability(pool, 'stats.export_limited_rows', ctx.userId, ctx.orgId))) return { ctx, lifted: false };
  const built = deriveLiftedContext(ctx);
  if (!built.ok) return { ctx, lifted: false };
  return { ctx: built.ctx, lifted: true };
}

/**
 * 해제된 응답에 권한자용 원시 필드(회귀 점별 진단 등)를 붙일 때 쓸 컨텍스트. 제한 컨텍스트는 공개통제가 닫혀 있어
 * regressionDesign이 null이라 진단이 항상 unavailable_computation_failed가 된다 — 해제본을 만든 것과 같은
 * 해제 컨텍스트로 부착해야 한다. memo hit에서도 해제 결과만 있고 컨텍스트는 없으므로 여기서 다시 만든다.
 */
export function liftedContextOrSelf(ctx: AnalysisContext): AnalysisContext {
  const built = deriveLiftedContext(ctx);
  return built.ok ? built.ctx : ctx;
}

async function computeLifted(
  ctx: AnalysisContext,
  aggregate: AnalyzeResult,
  signal: AbortSignal | undefined,
): Promise<AnalyzeResult> {
  const built = deriveLiftedContext(ctx);
  // 입력상한 초과는 gate와 무관하게 restricted에서도 같은 값으로 걸렸을 것이므로 정상 경로에서는 도달하지 않는다.
  if (!built.ok) throw new UnrestrictedUnavailable('unavailable_input_too_large');
  const lifted = built.ctx;

  // 실행 가능성 가드 — 이 검사는 POST 핸들러(METHOD_NOT_AVAILABLE)에만 있고 compute* 함수는 다시 하지 않는다.
  // restricted에서는 소수 셀 때문에 availableMethods가 비거나 세부 사유가 가려져 있었으므로, 해제된 컨텍스트에서
  // 방법이 실제로 실행 가능한지 다시 확인하지 않으면 통계적으로 불가능한 분석을 계산하게 된다.
  const selected = lifted.availableMethods.find((m) => m.id === lifted.recipe.requestedMethod);
  const executable = selected != null && (selected.status === 'available' || selected.status === 'conditional');
  if (!executable) throw new UnrestrictedUnavailable('unavailable_method_not_executable');
  // 방법이 실행 가능으로 보여도 설계행렬이 없으면 compute*가 결함 오류를 던져 500이 된다(예: 지원하지 않는 outcome 타입으로
  // regressionMethod가 null). 예상된 폴백으로 처리한다.
  if (lifted.recipe.analysisMode === 'regression' && (!lifted.regressionDisclosed || !lifted.regressionDesign)) {
    throw new UnrestrictedUnavailable('unavailable_method_not_executable');
  }

  if (lifted.recipe.analysisMode === 'regression') {
    const regression = await computeRegressionAnalyzeResult(lifted, { timeoutMs: config.stats.timeoutMs, signal });
    return { ...aggregate, regression };
  }
  throw new Error(`statsLiftedRecompute: 지원하지 않는 analysisMode=${lifted.recipe.analysisMode} — 호출 순서 위반`);
}

/**
 * 호출 전에 호출부가 (1) 조회자의 stats.export_limited_rows 권한 (2) isLiftApplicable (3) !forceSuppress를
 * 확인해야 한다. memo는 권한 검사 "뒤에" 조회한다.
 */
export async function resolveLiftedRecompute(
  ctx: AnalysisContext,
  aggregate: AnalyzeResult,
  executionDigest: string,
  signal?: AbortSignal,
): Promise<UnrestrictedOutcome> {
  return resolveUnrestricted(ctx.userId, executionDigest, signal, () => computeLifted(ctx, aggregate, signal));
}

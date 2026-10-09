// statsLiftedRecompute.ts 단위 테스트 — 제한데이터 권한자 해제의 "무엇을 언제 푸는가"와 실행 가능성 가드.
// 실제 Postgres·Python 경로는 statsRegressionLimitedDisclosure.integration.test.ts가 증명한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeResult } from '@wr/contracts';

const hasCapability = vi.fn();
vi.mock('../middleware/requireCapability', () => ({
  hasCapability: (...args: unknown[]) => hasCapability(...args),
  requireCapability: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const deriveLiftedContext = vi.fn();
vi.mock('../statsAnalysisContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsAnalysisContext')>();
  return { ...actual, deriveLiftedContext: (...args: unknown[]) => deriveLiftedContext(...args) };
});

const computeRegressionAnalyzeResult = vi.fn();
vi.mock('../statsRegressionSuppression', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsRegressionSuppression')>();
  return { ...actual, computeRegressionAnalyzeResult: (...args: unknown[]) => computeRegressionAnalyzeResult(...args) };
});

import { isLiftApplicable, liftedContextOrSelf, resolveEffectiveContext, resolveLiftedRecompute } from '../statsLiftedRecompute';
import { __resetLimitedDisclosureGuardForTests } from '../statsLimitedDisclosureGuard';
import { StatsEngineTimeoutError } from '../statsEngine';
import type { AnalysisContext } from '../statsAnalysisContext';

const stubResult = (): AnalyzeResult => ({
  continuous: [], discrete: [], regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' },
});

type CtxOverrides = Partial<Pick<AnalysisContext, 'requestSuppressed' | 'regressionDisclosed' | 'regressionDesign' | 'availableMethods'>> & {
  mode?: string;
  forceSuppress?: boolean;
  requestedMethod?: string;
};

function makeCtx(o: CtxOverrides = {}): AnalysisContext {
  return {
    orgId: 'org-1',
    userId: 'user-1',
    recipe: { analysisMode: o.mode ?? 'regression', requestedMethod: o.requestedMethod ?? 'ols_linear', variableKeys: ['y', 'x'] },
    differencing: { forceSuppress: o.forceSuppress ?? false, remaining: 10 },
    requestSuppressed: o.requestSuppressed ?? false,
    regressionDisclosed: o.regressionDisclosed ?? false,
    regressionDesign: 'regressionDesign' in o ? o.regressionDesign : { ok: true },
    availableMethods: o.availableMethods ?? [],
  } as unknown as AnalysisContext;
}

const method = (id: string, status: string) => ({ id, status }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  __resetLimitedDisclosureGuardForTests();
});

describe('isLiftApplicable', () => {
  it('회귀: 공개통제로 억제 스텁이 저장된 실행만 풀 것이 있다', () => {
    expect(isLiftApplicable('regression', stubResult())).toBe(true);
  });

  it('회귀: 공개통제를 통과해 결과가 이미 있으면 풀 것이 없다', () => {
    const estimated = { continuous: [], discrete: [], regression: { suppressed: false } } as unknown as AnalyzeResult;
    expect(isLiftApplicable('regression', estimated)).toBe(false);
  });

  it('회귀 필드가 없거나 다른 모드면 대상이 아니다(기술통계는 기존 경로가 처리)', () => {
    expect(isLiftApplicable('regression', { continuous: [], discrete: [] })).toBe(false);
    expect(isLiftApplicable('descriptive', stubResult())).toBe(false);
    expect(isLiftApplicable('bivariate', stubResult())).toBe(false);
    expect(isLiftApplicable('prediction', stubResult())).toBe(false);
  });
});

describe('resolveEffectiveContext', () => {
  it('differencing(forceSuppress)이면 권한 조회 없이 그대로 돌려준다 — 풀지 않는다', async () => {
    const ctx = makeCtx({ requestSuppressed: true, forceSuppress: true });
    const out = await resolveEffectiveContext(null as never, ctx);
    expect(out).toEqual({ ctx, lifted: false });
    expect(hasCapability).not.toHaveBeenCalled();
    expect(deriveLiftedContext).not.toHaveBeenCalled();
  });

  it('가려진 것이 없으면(공개통제 통과) 권한 조회 자체를 하지 않는다', async () => {
    const ctx = makeCtx({ regressionDisclosed: true, requestSuppressed: false });
    const out = await resolveEffectiveContext(null as never, ctx);
    expect(out.lifted).toBe(false);
    expect(hasCapability).not.toHaveBeenCalled();
  });

  it('기술통계는 이 경로의 대상이 아니다(기존 liftPossible 경로가 처리)', async () => {
    const out = await resolveEffectiveContext(null as never, makeCtx({ mode: 'descriptive', requestSuppressed: true }));
    expect(out.lifted).toBe(false);
    expect(hasCapability).not.toHaveBeenCalled();
  });

  it('가려졌지만 권한이 없으면 해제하지 않는다', async () => {
    hasCapability.mockResolvedValue(false);
    const ctx = makeCtx({ regressionDisclosed: false });
    const out = await resolveEffectiveContext(null as never, ctx);
    expect(out).toEqual({ ctx, lifted: false });
    expect(hasCapability).toHaveBeenCalledWith(null, 'stats.export_limited_rows', 'user-1', 'org-1');
    expect(deriveLiftedContext).not.toHaveBeenCalled();
  });

  it('요청 수준 억제(전체 N<10)도 가려진 것으로 본다', async () => {
    hasCapability.mockResolvedValue(true);
    const lifted = makeCtx({ regressionDisclosed: true });
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: lifted });
    const out = await resolveEffectiveContext(null as never, makeCtx({ requestSuppressed: true, regressionDisclosed: true }));
    expect(out).toEqual({ ctx: lifted, lifted: true });
  });

  it('권한자이고 공개통제가 닫혀 있으면 해제 컨텍스트를 돌려준다', async () => {
    hasCapability.mockResolvedValue(true);
    const lifted = makeCtx({ regressionDisclosed: true, availableMethods: [method('ols_linear', 'available')] });
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: lifted });
    const out = await resolveEffectiveContext(null as never, makeCtx({ regressionDisclosed: false }));
    expect(out.lifted).toBe(true);
    expect(out.ctx).toBe(lifted);
  });

  it('해제 컨텍스트를 만들지 못하면(ok:false) 입력 컨텍스트로 폴백한다', async () => {
    hasCapability.mockResolvedValue(true);
    deriveLiftedContext.mockReturnValue({ ok: false, status: 400, body: {} });
    const ctx = makeCtx({ regressionDisclosed: false });
    const out = await resolveEffectiveContext(null as never, ctx);
    expect(out).toEqual({ ctx, lifted: false });
  });
});

describe('resolveLiftedRecompute — 실행 가능성 가드와 오류 매핑', () => {
  const estimated = { suppressed: false, estimation: 'ok' } as never;

  it('해제 컨텍스트에서 방법이 실행 가능하면 재계산해 회귀 결과만 교체한다', async () => {
    const lifted = makeCtx({ regressionDisclosed: true, availableMethods: [method('ols_linear', 'available')] });
    deriveLiftedContext.mockReturnValue({ ok: true, ctx: lifted });
    computeRegressionAnalyzeResult.mockResolvedValue(estimated);

    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1');
    expect(out).toMatchObject({ kind: 'applied', source: 'computed' });
    if (out.kind !== 'applied') return;
    expect(out.result.regression).toBe(estimated);
    expect(computeRegressionAnalyzeResult).toHaveBeenCalledTimes(1);
    expect(computeRegressionAnalyzeResult.mock.calls[0][0]).toBe(lifted); // 제한 컨텍스트가 아니라 해제 컨텍스트
  });

  it('conditional 상태의 방법도 실행 가능으로 본다(POST 핸들러의 METHOD_NOT_AVAILABLE과 같은 기준)', async () => {
    deriveLiftedContext.mockReturnValue({
      ok: true, ctx: makeCtx({ regressionDisclosed: true, availableMethods: [method('ols_linear', 'conditional')] }),
    });
    computeRegressionAnalyzeResult.mockResolvedValue(estimated);
    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1');
    expect(out.kind).toBe('applied');
  });

  it('소수 셀을 풀고 보니 방법이 실행 불가(unsupported)면 계산하지 않고 unavailable_method_not_executable로 폴백한다', async () => {
    deriveLiftedContext.mockReturnValue({
      ok: true, ctx: makeCtx({ regressionDisclosed: true, availableMethods: [method('ols_linear', 'unsupported')] }),
    });
    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1');
    expect(out).toEqual({ kind: 'unavailable', status: 'unavailable_method_not_executable' });
    expect(computeRegressionAnalyzeResult).not.toHaveBeenCalled();
  });

  it('요청한 방법이 목록에 아예 없어도 계산하지 않는다(undefined 통과 방지)', async () => {
    deriveLiftedContext.mockReturnValue({
      ok: true, ctx: makeCtx({ regressionDisclosed: true, availableMethods: [method('binary_logistic', 'available')] }),
    });
    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1');
    expect(out).toEqual({ kind: 'unavailable', status: 'unavailable_method_not_executable' });
    expect(computeRegressionAnalyzeResult).not.toHaveBeenCalled();
  });

  it('방법이 실행 가능으로 보여도 설계행렬이 없으면 결함 500이 아니라 unavailable_method_not_executable로 폴백한다', async () => {
    deriveLiftedContext.mockReturnValue({
      ok: true,
      ctx: makeCtx({ regressionDisclosed: true, regressionDesign: null, availableMethods: [method('ols_linear', 'available')] }),
    });
    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1');
    expect(out).toEqual({ kind: 'unavailable', status: 'unavailable_method_not_executable' });
    expect(computeRegressionAnalyzeResult).not.toHaveBeenCalled();
  });

  it('해제 컨텍스트를 만들지 못하면 unavailable_input_too_large로 폴백한다', async () => {
    deriveLiftedContext.mockReturnValue({ ok: false, status: 400, body: {} });
    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1');
    expect(out).toEqual({ kind: 'unavailable', status: 'unavailable_input_too_large' });
  });

  it('엔진 타임아웃은 unavailable_computation_failed로 매핑한다(집계 응답 유지)', async () => {
    deriveLiftedContext.mockReturnValue({
      ok: true, ctx: makeCtx({ regressionDisclosed: true, availableMethods: [method('ols_linear', 'available')] }),
    });
    computeRegressionAnalyzeResult.mockRejectedValue(new StatsEngineTimeoutError());
    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1');
    expect(out).toEqual({ kind: 'unavailable', status: 'unavailable_computation_failed' });
  });

  it('이미 중단된 요청은 계산하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await resolveLiftedRecompute(makeCtx(), stubResult(), 'exec-1', controller.signal);
    expect(out).toEqual({ kind: 'aborted' });
    expect(deriveLiftedContext).not.toHaveBeenCalled();
  });
});

describe('liftedContextOrSelf', () => {
  it('해제 컨텍스트를 만들 수 있으면 그것을, 못 만들면 입력 컨텍스트를 돌려준다', () => {
    const lifted = makeCtx({ regressionDisclosed: true });
    const input = makeCtx();
    deriveLiftedContext.mockReturnValueOnce({ ok: true, ctx: lifted });
    expect(liftedContextOrSelf(input)).toBe(lifted);
    deriveLiftedContext.mockReturnValueOnce({ ok: false, status: 400, body: {} });
    expect(liftedContextOrSelf(input)).toBe(input);
  });
});

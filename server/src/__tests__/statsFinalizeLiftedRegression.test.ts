// finalizeAnalyzeResponse의 회귀 해제 경계 — 특히 "회귀 점별 진단(별도 엔진 호출) 대기 중 권한이 회수되면 해제 수치·진단값이
// 나가지 않는다"(Codex 2회차 P1)와 "풀 것이 없는 실행은 재계산하지 않는다"를 mock으로 결정적으로 재현한다.
// 실제 DB·엔진 경로는 statsRegressionLimitedDisclosure.integration.test.ts가 증명한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeResult } from '@wr/contracts';

const hasCapability = vi.fn();
vi.mock('../middleware/requireCapability', () => ({
  hasCapability: (...args: unknown[]) => hasCapability(...args),
  requireCapability: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const writeAuditLog = vi.fn();
const writeAuditLogStrict = vi.fn();
vi.mock('../middleware/audit', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
  writeAuditLogStrict: (...args: unknown[]) => writeAuditLogStrict(...args),
}));

const attachLimitedRowFields = vi.fn();
vi.mock('../statsLimitedRowMerge', () => ({
  attachLimitedRowFields: (...args: unknown[]) => attachLimitedRowFields(...args),
}));

const resolveLiftedRecompute = vi.fn();
const liftedContextOrSelf = vi.fn();
vi.mock('../statsLiftedRecompute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsLiftedRecompute')>();
  return {
    ...actual,
    resolveLiftedRecompute: (...args: unknown[]) => resolveLiftedRecompute(...args),
    liftedContextOrSelf: (...args: unknown[]) => liftedContextOrSelf(...args),
  };
});

import { finalizeAnalyzeResponse, isAbortedFinalize } from '../statsAnalyzeHandler';
import { __resetLimitedDisclosureGuardForTests, getMemoizedUnrestricted } from '../statsLimitedDisclosureGuard';
import type { AnalysisContext } from '../statsAnalysisContext';

const EXEC = 'exec-digest-reg';
const manifest = { analysisRunId: 'run-reg' } as never;

function makeCtx(forceSuppress = false): AnalysisContext {
  return {
    orgId: 'org-1', userId: 'user-1',
    recipe: {
      grain: 'case', variableKeys: ['y', 'x'], filters: [], analysisPurpose: 'association',
      formulaPolicies: {}, analysisMode: 'regression', requestedMethod: 'ols_linear',
    },
    differencing: { forceSuppress, remaining: 10 },
    catalogByKey: new Map(), recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    snapshot: { sourceDigest: 'sd' },
  } as unknown as AnalysisContext;
}

const stub: AnalyzeResult = { continuous: [], discrete: [], regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' } };
const lifted = {
  continuous: [], discrete: [], regression: { suppressed: false, estimation: 'ok' },
} as unknown as AnalyzeResult;
const estimatedAggregate = lifted;

beforeEach(() => {
  // mockResolvedValueOnce 큐가 앞 테스트에서 소비되지 않고 남아 다음 테스트로 새는 것을 막는다.
  vi.resetAllMocks();
  __resetLimitedDisclosureGuardForTests();
  writeAuditLog.mockResolvedValue(undefined);
  writeAuditLogStrict.mockResolvedValue(undefined);
  // 기본: 부착할 원시 필드 없음 — 입력 결과를 그대로 돌려준다.
  attachLimitedRowFields.mockImplementation(async (_ctx: unknown, result: AnalyzeResult) => ({ result, attached: false }));
  liftedContextOrSelf.mockImplementation((ctx: unknown) => ctx);
});

describe('finalizeAnalyzeResponse — 회귀 해제', () => {
  it('억제 스텁이 저장된 회귀를 권한자가 조회하면 재계산한 해제본을 limitedDisclosure=applied로 전달하고 strict 감사·memo를 남긴다', async () => {
    resolveLiftedRecompute.mockResolvedValue({ kind: 'applied', result: lifted, source: 'computed' });
    hasCapability.mockResolvedValue(true);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: stub });
    expect(isAbortedFinalize(out)).toBe(false);
    if (isAbortedFinalize(out)) return;
    const body = out.body as { result: AnalyzeResult };
    expect(body.result.limitedDisclosure).toBe('applied');
    expect(body.result.regression).toEqual(lifted.regression);
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
    expect(writeAuditLogStrict.mock.calls[0][1].extra).toMatchObject({ smallCellLimitStatus: 'applied', limitedDisclosureSource: 'computed' });
    expect(getMemoizedUnrestricted(EXEC, 'user-1')).toEqual(lifted);
  });

  it('점별 진단 부착(별도 엔진 호출) 대기 중 권한이 회수되면 해제 수치·진단값을 버리고 저장된 집계본을 반환하며 memo·감사가 없다', async () => {
    resolveLiftedRecompute.mockResolvedValue({ kind: 'applied', result: lifted, source: 'computed' });
    // 1) 최초 확인 true  2) 재계산 직후 true  3) 진단 부착 직후 false(회수)
    hasCapability.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    attachLimitedRowFields.mockImplementation(async (_ctx: unknown, result: AnalyzeResult, hasAccess: boolean) => (
      hasAccess
        ? { result: { ...result, regression: { ...(result.regression as object), diagnostics: { pointDiagnostics: ['secret'] } } }, attached: true }
        : { result, attached: false }
    ));

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: stub });
    expect(hasCapability).toHaveBeenCalledTimes(3);
    expect(isAbortedFinalize(out)).toBe(false);
    if (isAbortedFinalize(out)) return;
    const result = (out.body as { result: AnalyzeResult }).result;
    expect(result).toEqual(stub);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect('limitedDisclosure' in result).toBe(false);
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(getMemoizedUnrestricted(EXEC, 'user-1')).toBeNull();
    // 되돌릴 때는 권한 없는 조회자의 일반 응답과 같은 경로(hasAccess=false)로 만든다.
    expect(attachLimitedRowFields.mock.calls.at(-1)?.[2]).toBe(false);
  });

  it('해제된 회귀의 원시 필드(점별 진단)는 제한 컨텍스트가 아니라 해제 컨텍스트로 부착한다(설계행렬 필요)', async () => {
    const liftedCtx = { marker: 'lifted-ctx' };
    liftedContextOrSelf.mockReturnValue(liftedCtx);
    resolveLiftedRecompute.mockResolvedValue({ kind: 'applied', result: lifted, source: 'computed' });
    hasCapability.mockResolvedValue(true);

    const restricted = makeCtx();
    await finalizeAnalyzeResponse(null as never, restricted, EXEC, { runManifest: manifest, result: stub });
    expect(attachLimitedRowFields.mock.calls[0][0]).toBe(liftedCtx);
    expect(attachLimitedRowFields.mock.calls[0][0]).not.toBe(restricted);
  });

  it('memo hit이어도 해제 컨텍스트로 부착한다', async () => {
    const liftedCtx = { marker: 'lifted-ctx' };
    liftedContextOrSelf.mockReturnValue(liftedCtx);
    resolveLiftedRecompute.mockResolvedValue({ kind: 'applied', result: lifted, source: 'memo' });
    hasCapability.mockResolvedValue(true);

    await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: stub });
    expect(attachLimitedRowFields.mock.calls[0][0]).toBe(liftedCtx);
  });

  it('진단 부착 뒤 연결이 끊기면 응답·memo 없이 중단한다', async () => {
    const controller = new AbortController();
    resolveLiftedRecompute.mockResolvedValue({ kind: 'applied', result: lifted, source: 'computed' });
    hasCapability.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: stub }, controller.signal);
    expect(isAbortedFinalize(out)).toBe(true);
    expect(getMemoizedUnrestricted(EXEC, 'user-1')).toBeNull();
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('이미 공개통제를 통과한 회귀(풀 것이 없음)는 재계산하지 않고, 해제됨 표시도 붙이지 않는다', async () => {
    hasCapability.mockResolvedValue(true);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: estimatedAggregate });
    expect(resolveLiftedRecompute).not.toHaveBeenCalled();
    expect(hasCapability).toHaveBeenCalledTimes(1); // 풀 것도 붙인 것도 없으면 최종 재확인 쿼리를 더하지 않는다
    expect(isAbortedFinalize(out)).toBe(false);
    if (isAbortedFinalize(out)) return;
    const result = (out.body as { result: AnalyzeResult }).result;
    expect(result).toEqual(estimatedAggregate);
    expect('limitedDisclosure' in result).toBe(false);
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('differencing(forceSuppress)이 걸린 컨텍스트는 권한자여도 재계산하지 않는다', async () => {
    hasCapability.mockResolvedValue(true);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(true), EXEC, { runManifest: manifest, result: stub });
    expect(resolveLiftedRecompute).not.toHaveBeenCalled();
    if (isAbortedFinalize(out)) throw new Error('unexpected abort');
    expect((out.body as { result: AnalyzeResult }).result).toEqual(stub);
  });

  it('권한이 없으면 재계산하지 않고 저장된 스텁을 그대로 반환한다', async () => {
    hasCapability.mockResolvedValue(false);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: stub });
    expect(resolveLiftedRecompute).not.toHaveBeenCalled();
    expect(hasCapability).toHaveBeenCalledTimes(1);
    if (isAbortedFinalize(out)) throw new Error('unexpected abort');
    expect((out.body as { result: AnalyzeResult }).result).toEqual(stub);
  });

  it('방법 실행 불가로 폴백하면 집계 스텁에 unavailable_method_not_executable 상태만 붙는다', async () => {
    resolveLiftedRecompute.mockResolvedValue({ kind: 'unavailable', status: 'unavailable_method_not_executable' });
    hasCapability.mockResolvedValue(true);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: stub });
    if (isAbortedFinalize(out)) throw new Error('unexpected abort');
    const result = (out.body as { result: AnalyzeResult }).result;
    expect(result.regression).toEqual(stub.regression);
    expect(result.limitedDisclosure).toBe('unavailable_method_not_executable');
    // 공개된 것이 없으므로 best-effort 감사만(strict 아님)
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
});

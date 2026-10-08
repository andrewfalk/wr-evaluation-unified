// finalizeAnalyzeResponse의 제한 해제 경계 동작 단위 테스트 — 실제 타이밍(계산 뒤 권한 재검사 중 연결 끊김,
// 감사 대기 중 연결 끊김)을 결정적으로 재현하려고 의존 모듈을 mock한다. HTTP 레벨 시나리오는
// statsLimitedDisclosure.integration.test.ts가 실제 Postgres+Python으로 증명한다.
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

const runStatsEngine = vi.fn();
vi.mock('../statsEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../statsEngine')>();
  return { ...actual, runStatsEngine: (...args: unknown[]) => runStatsEngine(...args) };
});

const resolveUnrestrictedDescriptive = vi.fn();
vi.mock('../statsDescriptiveUnrestricted', () => ({
  resolveUnrestrictedDescriptive: (...args: unknown[]) => resolveUnrestrictedDescriptive(...args),
}));

import { finalizeAnalyzeResponse, isAbortedFinalize } from '../statsAnalyzeHandler';
import { __resetLimitedDisclosureGuardForTests, getMemoizedUnrestricted } from '../statsLimitedDisclosureGuard';
import type { AnalysisContext } from '../statsAnalysisContext';

const EXEC = 'exec-digest-1';

function makeCtx(): AnalysisContext {
  return {
    orgId: 'org-1', userId: 'user-1',
    recipe: { grain: 'case', variableKeys: ['v'], filters: [], analysisPurpose: 'association', formulaPolicies: {}, analysisMode: 'descriptive' },
    catalogByKey: new Map(), recipeDigest: 'rd', queryFamilyDigest: 'qfd',
    snapshot: { sourceDigest: 'sd' },
    dataset: { rows: [] },
  } as unknown as AnalysisContext;
}

const aggregate: AnalyzeResult = { continuous: [], discrete: [{ variableKey: 'v', kind: 'discrete', suppressed: true }] };
const unrestricted: AnalyzeResult = {
  continuous: [],
  discrete: [{ variableKey: 'v', kind: 'discrete', suppressed: false, n: 3, missingCount: 2, missingPatterns: null, levels: [{ level: 'A', count: 3, proportion: 1 }], mode: 'A' }],
};
const manifest = { analysisRunId: 'run-1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  __resetLimitedDisclosureGuardForTests();
  writeAuditLog.mockResolvedValue(undefined);
  writeAuditLogStrict.mockResolvedValue(undefined);
});

describe('finalizeAnalyzeResponse — 제한 해제 경계', () => {
  it('해제 성공 후 권한 재검사 중 연결이 끊기면 응답을 중단하고 memo에 해제 결과를 남기지 않는다(P2, 실제 헬퍼 사용)', async () => {
    // 헬퍼를 mock하면 "헬퍼 안에서 memo를 먼저 저장하던" 결함이 아예 실행되지 않는다 — 실제 헬퍼를 통과시킨다.
    const ctx = makeCtx();
    ctx.catalogByKey = new Map([['v', { key: 'v', type: 'categorical' } as never]]);
    (ctx.dataset as unknown as { rows: unknown[] }).rows = ['p1', 'p2', 'p3'].map((p, i) => ({
      caseId: `c${i}`, personClusterKey: p, entityKey: null,
      values: { v: { value: 'A', missing: null, qualityFlags: [] } },
    }));
    runStatsEngine.mockResolvedValue({ continuous: [], discrete: [{ variableKey: 'v', n: 3, levels: [{ level: 'A', count: 3 }] }] });
    resolveUnrestrictedDescriptive.mockImplementation(async (...args: unknown[]) => {
      const actual = await vi.importActual<typeof import('../statsDescriptiveUnrestricted')>('../statsDescriptiveUnrestricted');
      return (actual.resolveUnrestrictedDescriptive as (...a: unknown[]) => unknown)(...args);
    });
    const controller = new AbortController();
    hasCapability
      .mockResolvedValueOnce(true) // 1차
      .mockImplementationOnce(async () => { controller.abort(); return true; }); // 2차 중 연결 끊김

    const out = await finalizeAnalyzeResponse(null as never, ctx, EXEC, { runManifest: manifest, result: aggregate }, controller.signal);
    expect(runStatsEngine).toHaveBeenCalledTimes(1); // 실제로 계산이 일어났다
    expect(isAbortedFinalize(out)).toBe(true);
    expect(getMemoizedUnrestricted(EXEC, 'user-1')).toBeNull();
    expect(writeAuditLogStrict).not.toHaveBeenCalled(); // 새 공개 감사도 없다
  });

  it('감사까지 마친 뒤 연결이 끊겨도 memo는 남기지 않는다(응답이 전달되지 않았다)', async () => {
    const controller = new AbortController();
    resolveUnrestrictedDescriptive.mockResolvedValue({ kind: 'applied', result: unrestricted, source: 'computed' });
    hasCapability.mockResolvedValue(true);
    writeAuditLogStrict.mockImplementationOnce(async () => { controller.abort(); });

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: aggregate }, controller.signal);
    expect(isAbortedFinalize(out)).toBe(true);
    expect(getMemoizedUnrestricted(EXEC, 'user-1')).toBeNull();
  });

  it('정상 전달이면 감사 후 memo에 저장하고 limitedDisclosure=applied로 응답한다', async () => {
    resolveUnrestrictedDescriptive.mockResolvedValue({ kind: 'applied', result: unrestricted, source: 'computed' });
    hasCapability.mockResolvedValue(true);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: aggregate });
    expect(isAbortedFinalize(out)).toBe(false);
    if (isAbortedFinalize(out)) return;
    expect(out.status).toBe(200);
    expect((out.body as { result: AnalyzeResult }).result.limitedDisclosure).toBe('applied');
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
    expect(getMemoizedUnrestricted(EXEC, 'user-1')).toEqual(unrestricted);
  });

  it('best-effort 감사(폴백, 원시 필드 없음) 대기 중 연결이 끊기면 200을 반환하지 않고 중단한다(P3)', async () => {
    const controller = new AbortController();
    resolveUnrestrictedDescriptive.mockResolvedValue({ kind: 'unavailable', status: 'unavailable_engine_busy' });
    hasCapability.mockResolvedValue(true);
    writeAuditLog.mockImplementationOnce(async () => { controller.abort(); });

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: aggregate }, controller.signal);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(isAbortedFinalize(out)).toBe(true);
  });

  it('폴백(unavailable)에서도 계산 뒤 권한을 다시 확인하고, 회수됐으면 집계 결과만 반환하며 해제 상태·감사가 없다(P1)', async () => {
    resolveUnrestrictedDescriptive.mockResolvedValue({ kind: 'unavailable', status: 'unavailable_computation_failed' });
    hasCapability.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: aggregate });
    expect(hasCapability).toHaveBeenCalledTimes(2);
    expect(isAbortedFinalize(out)).toBe(false);
    if (isAbortedFinalize(out)) return;
    const result = (out.body as { result: AnalyzeResult }).result;
    expect(result).toEqual(aggregate);
    expect('limitedDisclosure' in result).toBe(false);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('memo hit은 기다림이 없었으므로 권한을 다시 조회하지 않고 memo를 다시 저장하지도 않는다', async () => {
    resolveUnrestrictedDescriptive.mockResolvedValue({ kind: 'applied', result: unrestricted, source: 'memo' });
    hasCapability.mockResolvedValue(true);

    const out = await finalizeAnalyzeResponse(null as never, makeCtx(), EXEC, { runManifest: manifest, result: aggregate });
    expect(hasCapability).toHaveBeenCalledTimes(1);
    expect(isAbortedFinalize(out)).toBe(false);
    expect(getMemoizedUnrestricted(EXEC, 'user-1')).toBeNull(); // 이번 요청이 새로 저장한 것이 없다
    const audit = writeAuditLogStrict.mock.calls[0][1];
    expect(audit.extra).toMatchObject({ smallCellLimitStatus: 'applied', limitedDisclosureSource: 'memo' });
  });
});

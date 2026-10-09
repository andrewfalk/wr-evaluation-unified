// statsStoredLimited.ts 단위 테스트 — 실행 시점에 저장해 둔 해제본(stats_runs.limited_result)을 조회자의 "현재" 권한으로
// 고르는 단일 지점. 핵심 불변식: 권한 확인 전에는 해제본 컬럼을 읽지 않는다 / 권한은 조회 뒤 다시 확인한다 /
// 해제본을 내보내기 전에 strict 감사를 쓰고 실패하면 500이며 일반본으로 강등하지 않는다 / 연결이 끊기면 응답하지 않는다.
// 실제 Postgres 경로(워커가 만든 해제본·캐시·GET)는 statsCorrelationMatrixLimitedDisclosure.integration.test.ts가 증명한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeResult, RunManifest } from '@wr/contracts';

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

import { deliverStoredLimited, fetchStoredLimitedResult, isStoredLimitedMode } from '../statsStoredLimited';
import { computeExecutionDigest } from '../statsExecutionDigest';

const VIEWER = { userId: 'user-1', orgId: 'org-1' };
const manifest = { analysisRunId: 'run-1' } as unknown as RunManifest;

const aggregate: AnalyzeResult = {
  continuous: [], discrete: [],
  correlationMatrix: {
    method: 'pearson_correlation', variableKeys: ['a', 'b', 'c'], adjustedPWithheld: true,
    cells: [{ suppressed: true, xKey: 'a', yKey: 'b' }, { suppressed: true, xKey: 'a', yKey: 'c' }, { suppressed: true, xKey: 'b', yKey: 'c' }],
  },
};
const limited: AnalyzeResult = {
  continuous: [], discrete: [],
  correlationMatrix: {
    method: 'pearson_correlation', variableKeys: ['a', 'b', 'c'], adjustedPWithheld: false,
    cells: [
      { suppressed: false, xKey: 'a', yKey: 'b', n: 5, r: 0.91, pValue: 0.03, adjustedP: 0.05 },
      { suppressed: false, xKey: 'a', yKey: 'c', n: 5, r: 0.82, pValue: 0.09, adjustedP: 0.09 },
      { suppressed: false, xKey: 'b', yKey: 'c', n: 5, r: 0.73, pValue: 0.16, adjustedP: 0.16 },
    ],
  },
};

const run = (over: Record<string, unknown> = {}) => ({
  analysisRunId: 'run-1', executionDigest: 'exec-1', recipeDigest: 'rd-1', analysisMode: 'correlation_matrix',
  runManifest: manifest, result: aggregate, ...over,
});

function poolReturning(limitedResult: AnalyzeResult | null) {
  const query = vi.fn().mockResolvedValue({ rows: [{ limited_result: limitedResult }] });
  return { pool: { query } as never, query };
}

beforeEach(() => {
  vi.resetAllMocks();
  writeAuditLog.mockResolvedValue(undefined);
  writeAuditLogStrict.mockResolvedValue(undefined);
});

describe('isStoredLimitedMode', () => {
  it('상관행렬만 저장형 해제 모드다(예측은 PR4, 나머지는 조회 시 재계산)', () => {
    expect(isStoredLimitedMode('correlation_matrix')).toBe(true);
    for (const mode of ['descriptive', 'bivariate', 'regression', 'prediction', undefined]) {
      expect(isStoredLimitedMode(mode)).toBe(false);
    }
  });
});

describe('computeExecutionDigest — 해제 적격 프로파일', () => {
  const base = { organizationId: 'org', requestedBy: 'user', recipeDigest: 'rd', sourceDigest: 'sd' };

  it('프로파일을 생략하면 기존 aggregate digest와 같다(기존 캐시 행의 digest가 바뀌지 않는다)', () => {
    expect(computeExecutionDigest(base)).toBe(computeExecutionDigest({ ...base, requestedDisclosureProfile: 'aggregate' }));
  });

  it('lift_eligible은 aggregate와 다른 digest라 권한자 실행과 비권한자 실행의 캐시·합류가 섞이지 않는다', () => {
    expect(computeExecutionDigest({ ...base, requestedDisclosureProfile: 'lift_eligible' })).not.toBe(computeExecutionDigest(base));
  });
});

describe('fetchStoredLimitedResult', () => {
  it('같은 조직의 성공한 미만료 행만 읽는다', async () => {
    const { pool, query } = poolReturning(limited);
    await expect(fetchStoredLimitedResult(pool, 'org-1', 'run-1')).resolves.toBe(limited);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('limited_result');
    expect(sql).toContain("status='succeeded'");
    expect(sql).toContain('expires_at > now()');
    expect(params).toEqual(['run-1', 'org-1']);
  });

  it('행이 없거나 해제본이 없으면 null이다', async () => {
    expect(await fetchStoredLimitedResult({ query: vi.fn().mockResolvedValue({ rows: [] }) } as never, 'org-1', 'run-1')).toBeNull();
    expect(await fetchStoredLimitedResult(poolReturning(null).pool, 'org-1', 'run-1')).toBeNull();
  });
});

describe('deliverStoredLimited', () => {
  it('권한이 없으면 해제본 컬럼을 읽지 않고 일반본을 그대로 돌려준다', async () => {
    hasCapability.mockResolvedValue(false);
    const { pool, query } = poolReturning(limited);

    const out = await deliverStoredLimited(pool, VIEWER, run());
    expect(query).not.toHaveBeenCalled(); // 권한 확인 전에는 limited_result를 읽지 않는다
    expect(out).toEqual({ status: 200, body: { runManifest: manifest, result: aggregate } });
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('권한자이고 해제본이 있으면 해제본을 limitedDisclosure=applied로 전달하고 공개 전에 strict 감사를 쓴다', async () => {
    hasCapability.mockResolvedValue(true);
    const { pool } = poolReturning(limited);

    const out = await deliverStoredLimited(pool, VIEWER, run());
    if ('aborted' in out) throw new Error('unexpected abort');
    const body = out.body as { result: AnalyzeResult };
    expect(out.status).toBe(200);
    expect(body.result.limitedDisclosure).toBe('applied');
    expect(body.result.correlationMatrix).toEqual(limited.correlationMatrix);
    expect(writeAuditLogStrict).toHaveBeenCalledTimes(1);
    const audit = writeAuditLogStrict.mock.calls[0][1];
    expect(audit).toMatchObject({ actorUserId: 'user-1', actorOrgId: 'org-1', action: 'stats_analyze', targetId: 'rd-1' });
    expect(audit.extra).toMatchObject({
      analysisRunId: 'run-1', executionDigest: 'exec-1', analysisMode: 'correlation_matrix',
      smallCellLimitStatus: 'applied', limitedDisclosureSource: 'stored',
    });
    expect(typeof audit.extra.deliveredResultDigest).toBe('string');
  });

  it('해제본이 없으면(권한 전에 실행했거나 워커 시점에 회수됨) 일반본 + unavailable_source_missing이다', async () => {
    hasCapability.mockResolvedValue(true);
    const { pool } = poolReturning(null);

    const out = await deliverStoredLimited(pool, VIEWER, run());
    if ('aborted' in out) throw new Error('unexpected abort');
    const result = (out.body as { result: AnalyzeResult }).result;
    expect(result.correlationMatrix).toEqual(aggregate.correlationMatrix);
    expect(result.limitedDisclosure).toBe('unavailable_source_missing');
    expect(writeAuditLogStrict).not.toHaveBeenCalled(); // 공개된 것이 없으므로 strict가 아니라 best-effort
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it('해제본 조회 사이에 권한이 회수되면 일반본을 돌려주고 감사·해제 표시가 없다', async () => {
    hasCapability.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { pool } = poolReturning(limited);

    const out = await deliverStoredLimited(pool, VIEWER, run());
    expect(hasCapability).toHaveBeenCalledTimes(2);
    if ('aborted' in out) throw new Error('unexpected abort');
    const result = (out.body as { result: AnalyzeResult }).result;
    expect(result).toEqual(aggregate);
    expect(JSON.stringify(result)).not.toContain('0.91');
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('strict 감사가 실패하면 500이다 — 일반본으로 강등해 조용히 넘기지 않는다', async () => {
    hasCapability.mockResolvedValue(true);
    writeAuditLogStrict.mockRejectedValue(new Error('audit down'));
    const { pool } = poolReturning(limited);

    const out = await deliverStoredLimited(pool, VIEWER, run());
    if ('aborted' in out) throw new Error('unexpected abort');
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain('0.91');
  });

  it('버전 드리프트인 실행은 해제본을 읽지 않고 unavailable_version_drift로 안내한다', async () => {
    hasCapability.mockResolvedValue(true);
    const { pool, query } = poolReturning(limited);

    const out = await deliverStoredLimited(pool, VIEWER, run({ versionDrifted: true }));
    if ('aborted' in out) throw new Error('unexpected abort');
    expect(query).not.toHaveBeenCalled();
    expect((out.body as { result: AnalyzeResult }).result.limitedDisclosure).toBe('unavailable_version_drift');
  });

  it('이미 끊긴 연결이면 아무것도 읽지 않고 중단한다', async () => {
    hasCapability.mockResolvedValue(true);
    const { pool, query } = poolReturning(limited);
    const controller = new AbortController();
    controller.abort();

    expect(await deliverStoredLimited(pool, VIEWER, run(), controller.signal)).toEqual({ aborted: true });
    expect(query).not.toHaveBeenCalled();
  });

  it('감사 대기 중 연결이 끊기면 응답하지 않는다', async () => {
    hasCapability.mockResolvedValue(true);
    const controller = new AbortController();
    writeAuditLogStrict.mockImplementation(async () => { controller.abort(); });
    const { pool } = poolReturning(limited);

    expect(await deliverStoredLimited(pool, VIEWER, run(), controller.signal)).toEqual({ aborted: true });
  });
});

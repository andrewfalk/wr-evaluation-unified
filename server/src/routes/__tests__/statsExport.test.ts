// PR2 §7 — POST /api/stats/export. `stats_runs`에 이미 억제 적용 후 저장된 manifest/result를
// analysisRunId로 조회해 그대로 CSV로 포맷한다(재계산 없음). 계획서(pr2-dreamy-frog.md) §7의
// 상태코드 전체를 검증한다: 0행→404 RUN_NOT_FOUND, status!='succeeded'→409 RUN_NOT_SUCCEEDED,
// 만료→410 RUN_EXPIRED, UUID 형식 오류→400, 저장 데이터 스키마 위반→500, 성공→200 CSV.
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'pg';

vi.mock('../../config', () => ({
  default: {
    env: 'test',
    cors: { origins: [] },
    auth: {
      accessTokenTtl: 900,
      accessTokenSecret: 'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
    stats: {
      python: 'python', scriptsDir: '/fake/scripts', timeoutMs: 30000, killGraceMs: 2000,
      maxConcurrency: 1, maxConcurrentAnalyzeRequests: 4,
      stdoutMaxBytes: 10 * 1024 * 1024, stderrMaxBytes: 64 * 1024,
      maxInputBytes: 2 * 1024 * 1024, resultTtlHours: 168,
    },
  },
}));

vi.mock('../../statsWorkbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: true, reason: null, checkedAt: null }),
}));

const writeAuditLogStrict = vi.fn().mockResolvedValue(undefined);
vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
  writeAuditLogStrict: (...args: unknown[]) => writeAuditLogStrict(...args),
}));

import { createStatsRouter } from '../stats';
import { generateAccessToken } from '../../auth/tokens';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CSRF_TOKEN = 'ok';
const CSRF_HASH = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');
const RUN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

function orgToken(): string {
  return generateAccessToken({
    sub: USER_ID, sessionId: 'sess-1', orgId: ORG_ID,
    role: 'doctor', name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/stats', createStatsRouter(pool));
  return app;
}

function wireAuthAndCapability(pool: Pool): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth session check
  mock.mockResolvedValueOnce({ rows: [{ has_default: true, has_grant: false }] }); // requireCapability
}

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    analysisRunId: RUN_ID,
    snapshotAsOf: '2024-01-01T00:00:00.000Z',
    recipeDigest: 'recipe-digest',
    sourceDigest: 'source-digest',
    resultDigest: 'result-digest',
    catalogVersion: 'cv1',
    extractorVersion: 'cv1',
    migrationVersion: 'mv1',
    formulaPolicies: {},
    estimabilityPolicyVersion: 'v0-preview-counts',
    engineVersion: 'v1-python-descriptive',
    serializerVersion: 'sv1',
    ...overrides,
  };
}

function baseResult(overrides: Partial<{ continuous: unknown[]; discrete: unknown[] }> = {}) {
  return { continuous: [], discrete: [], ...overrides };
}

function wireRunRow(pool: Pool, row: Record<string, unknown> | null): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: row ? [row] : [] });
}

function postExport(pool: Pool, body: Record<string, unknown> = { analysisRunId: RUN_ID }) {
  return request(makeApp(pool))
    .post('/api/stats/export')
    .set('Authorization', `Bearer ${orgToken()}`)
    .set('X-CSRF-Token', CSRF_TOKEN)
    .send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  writeAuditLogStrict.mockResolvedValue(undefined);
});

describe('POST /export — 요청 검증', () => {
  it('analysisRunId가 UUID 형식이 아니면 400이고 DB에 접근하지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    const res = await postExport(pool, { analysisRunId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
    expect(pool.query).toHaveBeenCalledTimes(2); // auth + capability만, SELECT 없음
  });
});

describe('POST /export — run 조회 실패', () => {
  it('0행이면 404 RUN_NOT_FOUND + denied 감사', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, null);
    const res = await postExport(pool);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'stats_export_aggregate', outcome: 'denied',
      extra: expect.objectContaining({ reasonCode: 'RUN_NOT_FOUND' }),
    }));
  });

  it('조회 SQL이 organization_id로도 거른다 (조직 스코프 회귀 방지)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, null);
    await postExport(pool);
    const selectCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(selectCall[0]).toMatch(/organization_id/);
    expect(selectCall[1]).toEqual([ORG_ID, RUN_ID]);
  });

  it("status='failed' run은 409 RUN_NOT_SUCCEEDED — 실패 run은 export 대상이 아니다", async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(), result: null, status: 'failed',
      requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_NOT_SUCCEEDED');
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'denied' }));
  });

  it('요청단위 억제(succeeded + cacheable=false) run도 succeeded면 export 성공한다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(), result: baseResult(), status: 'succeeded',
      requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
  });

  it('만료됐지만 아직 cleanup 전이면(행이 존재) 410 RUN_EXPIRED', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(), result: baseResult(), status: 'succeeded',
      requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('RUN_EXPIRED');
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'denied', extra: expect.objectContaining({ reasonCode: 'RUN_EXPIRED' }),
    }));
  });

  it('cleanup이 이미 지운 만료 행은 그냥 0행 — 404로 수렴한다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, null); // cleanup 후엔 조회 결과가 그냥 없다
    const res = await postExport(pool);
    expect(res.status).toBe(404);
  });

  it('저장된 manifest/result가 스키마를 위반하면 500이고 CSV가 전송되지 않는다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: { broken: true }, result: baseResult(), status: 'succeeded',
      requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(500);
    expect(writeAuditLogStrict).not.toHaveBeenCalled();
  });

  it('requested_disclosure_profile이 aggregate가 아니면 500(방어적 검사)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(), result: baseResult(), status: 'succeeded',
      requested_disclosure_profile: 'limited_row',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(500);
  });

  it('감사 INSERT가 실패하면 CSV가 전송되지 않고 500을 반환한다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(), result: baseResult(), status: 'succeeded',
      requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    writeAuditLogStrict.mockRejectedValueOnce(new Error('audit insert failed'));
    const res = await postExport(pool);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('analysisRunId');
  });
});

describe('POST /export — 조직 공유 캐시 정책 (§7 [필수 수정 2])', () => {
  it('요청자가 누구였는지와 무관하게 같은 조직이면 export가 성공한다 (requested_by 소유권 검사 없음)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool); // 이 요청은 USER_ID로 인증됨
    // 이 run을 실제로 만든 사람이 다른 사용자(예: 의사 A)였다는 걸 SQL이 조회하지도, 비교하지도
    // 않는다는 것을 보여준다 — SELECT 자체가 requested_by를 안 select하고 WHERE에도 안 씀
    // (§7 [필수 수정 2]: 조직 공유 캐시이므로 캐시 히트로 같은 결과를 받은 B도 export해야 한다).
    wireRunRow(pool, {
      manifest: baseManifest(), result: baseResult(), status: 'succeeded',
      requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
    const selectCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(selectCall[0]).not.toMatch(/requested_by/);
  });
});

describe('POST /export — analysisMode별 CSV export 차단', () => {
  it('bivariate 결과는 400 BIVARIATE_EXPORT_NOT_SUPPORTED + denied 감사(기존 동작 회귀 방지)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest({ analysisMode: 'bivariate' }),
      result: { continuous: [], discrete: [], bivariate: { method: 'welch_t', suppressed: true } },
      status: 'succeeded', requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BIVARIATE_EXPORT_NOT_SUPPORTED');
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'denied' }));
  });

  it('correlation_matrix 결과는 400 CORRELATION_MATRIX_EXPORT_NOT_SUPPORTED + denied 감사(PR3-B)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest({ analysisMode: 'correlation_matrix' }),
      result: {
        continuous: [], discrete: [],
        correlationMatrix: { method: 'pearson_correlation', variableKeys: ['a', 'b', 'c'], cells: [], adjustedPWithheld: false },
      },
      status: 'succeeded', requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CORRELATION_MATRIX_EXPORT_NOT_SUPPORTED');
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'denied' }));
  });

  it('analysisMode가 없는 구버전 저장 결과는 descriptive로 취급해 export를 허용한다(하위호환)', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(), // analysisMode 필드 자체가 없음
      result: baseResult(),
      status: 'succeeded', requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
  });
});

describe('POST /export — 성공 경로 + CSV 포맷', () => {
  it('성공하면 200 + CSV(BOM, analysisRunId 메타헤더) + success 감사', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(), result: baseResult(), status: 'succeeded',
      requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(RUN_ID);
    expect(res.text.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    expect(res.text).toContain(`analysisRunId,${RUN_ID}`);
    expect(writeAuditLogStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'stats_export_aggregate', outcome: 'success',
      extra: expect.objectContaining({ analysisRunId: RUN_ID }),
    }));
  });

  it('억제된 변수는 다른 필드 없이 suppressed=true 행만 낸다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(),
      result: baseResult({ continuous: [{ variableKey: 'knee.relatedness.max', kind: 'continuous', suppressed: true }] }),
      status: 'succeeded', requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
    expect(res.text).toContain('continuous,knee.relatedness.max,true,,,,,,,,,,,,,,,,,');
  });

  it('음수 통계값은 문자열 이스케이프 없이 그대로 숫자로 나온다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(),
      result: baseResult({
        continuous: [{
          variableKey: 'v1', kind: 'continuous', suppressed: false,
          n: 20, missingCount: 0, missingPatterns: [],
          mean: -5.2, sd: 1.1, median: -5, q1: -6, q3: -4, iqr: 2,
          skewness: -0.1, kurtosis: 0, min: -10, max: -1,
          nullReasons: {},
        }],
      }),
      status: 'succeeded', requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
    // -5.2가 '-5.2로 이스케이프되지 않고 그대로 숫자 셀로 남는지.
    expect(res.text).toContain(',-5.2,');
    expect(res.text).not.toContain("'-5.2");
  });

  it('missingPatterns null(억제)과 []([]0건)을 다른 표기로 구분한다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(),
      result: baseResult({
        continuous: [
          {
            variableKey: 'suppressed-patterns', kind: 'continuous', suppressed: false,
            n: 20, missingCount: 3, missingPatterns: null,
            mean: 1, sd: 1, median: 1, q1: 1, q3: 1, iqr: 0, skewness: 0, kurtosis: 0, min: 1, max: 1,
            nullReasons: {},
          },
          {
            variableKey: 'empty-patterns', kind: 'continuous', suppressed: false,
            n: 20, missingCount: 0, missingPatterns: [],
            mean: 1, sd: 1, median: 1, q1: 1, q3: 1, iqr: 0, skewness: 0, kurtosis: 0, min: 1, max: 1,
            nullReasons: {},
          },
        ],
      }),
      status: 'succeeded', requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
    expect(res.text).toContain('(비공개)');
    expect(res.text).toContain('(없음)');
  });

  it('=로 시작하는 범주형 level 라벨은 CSV formula injection 방어로 이스케이프된다', async () => {
    const pool = makePool();
    wireAuthAndCapability(pool);
    wireRunRow(pool, {
      manifest: baseManifest(),
      result: baseResult({
        discrete: [{
          variableKey: 'v2', kind: 'discrete', suppressed: false,
          n: 20, missingCount: 0, missingPatterns: [],
          levels: [{ level: '=1+1', count: 20, proportion: 1 }],
          mode: '=1+1',
        }],
      }),
      status: 'succeeded', requested_disclosure_profile: 'aggregate',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await postExport(pool);
    expect(res.status).toBe(200);
    expect(res.text).toContain("'=1+1");
    expect(res.text).not.toMatch(/[^']=1\+1/); // escape 안 된 원문 "=1+1"이 단독으로 남아있지 않아야 함
  });
});

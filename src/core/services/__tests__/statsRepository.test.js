// PR2 §9 — statsRepository.js가 실제로 @wr/contracts 스키마로 safeParse하는지, httpClient의
// 어떤 함수를 어떤 인자로 호출하는지 검증한다.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestJson = vi.fn();
const requestBlobPost = vi.fn();
vi.mock('../httpClient', () => ({ requestJson: (...a) => requestJson(...a), requestBlobPost: (...a) => requestBlobPost(...a) }));

import {
  fetchStatsCatalog,
  previewStatsAnalysis,
  runStatsAnalysis,
  exportStatsAggregate,
} from '../statsRepository.js';

const SESSION = { apiBaseUrl: 'https://intranet.local', accessToken: 'tok' };

function validCatalogResponse() {
  return {
    catalogVersion: 'cv1',
    variables: [],
    supportedGrains: ['case'],
    unsupportedGrains: [{ grain: 'person', reasonCode: 'GRAIN_NOT_YET_SUPPORTED' }],
    minimumCohort: 10,
  };
}

function validRunManifest() {
  return {
    analysisRunId: '11111111-1111-1111-1111-111111111111',
    snapshotAsOf: '2024-01-01T00:00:00.000Z',
    recipeDigest: 'r', sourceDigest: 's', resultDigest: 'd',
    catalogVersion: 'cv1', extractorVersion: 'cv1', migrationVersion: 'mv1',
    formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e1', serializerVersion: 'sv1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchStatsCatalog', () => {
  it('GET /api/stats/catalog를 호출하고 유효한 응답을 그대로 반환한다', async () => {
    requestJson.mockResolvedValueOnce(validCatalogResponse());
    const result = await fetchStatsCatalog(SESSION);
    expect(result.catalogVersion).toBe('cv1');
    expect(requestJson).toHaveBeenCalledWith('/api/stats/catalog', expect.objectContaining({
      session: SESSION, baseUrl: SESSION.apiBaseUrl,
    }));
  });

  it('계약과 다른 응답이면 safeParse가 실패해 에러를 던진다(런타임 검증)', async () => {
    requestJson.mockResolvedValueOnce({ catalogVersion: 'cv1' /* variables 누락 */ });
    await expect(fetchStatsCatalog(SESSION)).rejects.toThrow(/계약과 다릅니다/);
  });
});

describe('previewStatsAnalysis / runStatsAnalysis', () => {
  const RECIPE = { grain: 'case', variableKeys: ['knee.relatedness.max'], filters: [], analysisPurpose: 'association', formulaPolicies: {} };

  it('previewStatsAnalysis는 POST /preview에 recipe를 그대로 보낸다', async () => {
    requestJson.mockResolvedValueOnce({
      runManifest: validRunManifest(),
      counts: { personCount: 20, caseCount: 20, observationCount: 20, suppressed: false, minimumCohort: 10, reasonCode: null },
      estimability: { completeCaseN: 20, missingRatesByVariable: {}, distinctAssignedDoctorClusters: 2, candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'v1' },
      availableMethods: [], methodCatalogVersion: null,
      differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
    });
    const result = await previewStatsAnalysis(RECIPE, SESSION);
    expect(result.counts.personCount).toBe(20);
    expect(requestJson).toHaveBeenCalledWith('/api/stats/preview', expect.objectContaining({
      method: 'POST', body: RECIPE, session: SESSION,
    }));
  });

  it('runStatsAnalysis는 POST /analyze에 recipe를 그대로 보내고 결과를 반환한다', async () => {
    requestJson.mockResolvedValueOnce({
      runManifest: validRunManifest(),
      result: { continuous: [], discrete: [] },
    });
    const result = await runStatsAnalysis(RECIPE, SESSION);
    expect(result.result).toEqual({ continuous: [], discrete: [] });
    expect(requestJson).toHaveBeenCalledWith('/api/stats/analyze', expect.objectContaining({
      method: 'POST', body: RECIPE, session: SESSION,
    }));
  });

  it('analyze 응답이 discriminated union 계약을 어기면(suppressed=false인데 필드 없음) 던진다', async () => {
    requestJson.mockResolvedValueOnce({
      runManifest: validRunManifest(),
      result: { continuous: [{ variableKey: 'v1', kind: 'continuous', suppressed: false /* n 등 필수 필드 누락 */ }], discrete: [] },
    });
    await expect(runStatsAnalysis(RECIPE, SESSION)).rejects.toThrow(/계약과 다릅니다/);
  });
});

describe('exportStatsAggregate', () => {
  it('requestBlobPost로 analysisRunId만 보내고 blob을 그대로 반환한다', async () => {
    const fakeBlob = { size: 10, type: 'text/csv' };
    requestBlobPost.mockResolvedValueOnce(fakeBlob);
    const result = await exportStatsAggregate('11111111-1111-1111-1111-111111111111', SESSION);
    expect(result).toBe(fakeBlob);
    expect(requestBlobPost).toHaveBeenCalledWith('/api/stats/export', expect.objectContaining({
      session: SESSION,
      body: { analysisRunId: '11111111-1111-1111-1111-111111111111' },
    }));
  });
});

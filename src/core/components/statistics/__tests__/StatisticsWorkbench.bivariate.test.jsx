// @vitest-environment jsdom
// PR3-A — 이변량 모드의 클라이언트 핵심 불변식을 검증한다: method 미선택이어도
// preview가 나가는지(순환의존 재발 방지, 계획서 §"이슈1"), canExecute가 method
// 존재+상태를 명시적으로 확인하는지, 3개 이상 선택된 채로 모드 전환을 시도하면
// 막히는지, variableKeys 순서가 선택 순서 그대로 보존되는지(정렬 안 함).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchStatsCatalog = vi.fn();
const previewStatsAnalysis = vi.fn();
const runStatsAnalysis = vi.fn();
const exportStatsAggregate = vi.fn();
vi.mock('../../../services/statsRepository', () => ({
  fetchStatsCatalog: (...a) => fetchStatsCatalog(...a),
  previewStatsAnalysis: (...a) => previewStatsAnalysis(...a),
  runStatsAnalysis: (...a) => runStatsAnalysis(...a),
  exportStatsAggregate: (...a) => exportStatsAggregate(...a),
}));

import { StatisticsWorkbench } from '../StatisticsWorkbench.jsx';

const SESSION = { apiBaseUrl: 'https://intranet.local', accessToken: 'tok' };

function catalogFixture() {
  return {
    catalogVersion: 'cv1',
    variables: [
      {
        key: 'knee.relatedness.max', label: '신체부담기여도(최대)', group: '무릎 · 파생지표', moduleId: 'knee',
        grain: 'case', type: 'continuous', unit: '%', provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'knee_relatedness',
        supportedFormulaPolicies: ['recompute_recorded_version'], formulaVersionKey: null,
      },
      {
        key: 'shoulder.exposure.anyExceeded', label: '노출 한도 초과 여부', group: '어깨', moduleId: 'shoulder',
        grain: 'case', type: 'boolean', unit: null, provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'shoulder_exposure',
        supportedFormulaPolicies: ['recompute_current'], formulaVersionKey: null,
      },
      {
        key: 'spine.vibration.dvMax', label: '전신진동 일일노출량', group: '척추', moduleId: 'spine',
        grain: 'case', type: 'continuous', unit: null, provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'spine_wbv',
        supportedFormulaPolicies: ['recompute_current'], formulaVersionKey: null,
      },
    ],
    supportedGrains: ['case'],
    unsupportedGrains: [{ grain: 'person', reasonCode: 'GRAIN_NOT_YET_SUPPORTED' }],
    minimumCohort: 10,
  };
}

function runManifest(id) {
  return {
    analysisRunId: id, snapshotAsOf: '2024-01-01T00:00:00.000Z',
    recipeDigest: 'r', sourceDigest: 's', resultDigest: 'd',
    catalogVersion: 'cv1', extractorVersion: 'cv1', migrationVersion: 'mv1',
    formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e2', serializerVersion: 'sv1',
    inferenceGatePolicyVersion: 'v1-repeated-measures-gate', analysisMode: 'bivariate',
  };
}

function bivariatePreview(availableMethods) {
  return {
    runManifest: runManifest('11111111-1111-1111-1111-111111111111'),
    counts: { personCount: 20, caseCount: 20, observationCount: 20, suppressed: false, minimumCohort: 10, reasonCode: null },
    estimability: { completeCaseN: 20, missingRatesByVariable: {}, distinctAssignedDoctorClusters: 2, candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'v1' },
    availableMethods,
    methodCatalogVersion: 'v1-bivariate',
    differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
  };
}

function availableMethod(id, overrides = {}) {
  return {
    id, label: id, purpose: 'association', status: 'available', reasonCode: null,
    observed: { personCount: 20, rowCount: 20 }, required: null, remedy: null, remedyRecipePatch: null,
    methodPolicyVersion: 'v1-bivariate',
    ...overrides,
  };
}

async function waitForDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1920;
});

async function switchToBivariate(user) {
  await user.click(await screen.findByRole('button', { name: '이변량' }));
}

describe('StatisticsWorkbench — PR3-A 이변량 모드', () => {
  it('method 미선택 상태에서도 변수 2개를 고르면 preview가 정상 발사된다(순환의존 재발 방지)', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToBivariate(user);

    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));

    previewStatsAnalysis.mockResolvedValueOnce(bivariatePreview([
      availableMethod('pearson_correlation'),
      availableMethod('spearman_correlation'),
    ]));
    await waitForDebounce();

    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisMode: 'bivariate',
        variableKeys: ['knee.relatedness.max', 'spine.vibration.dvMax'],
      }),
      SESSION,
      expect.anything(),
    );
    // 요청 바디에 requestedMethod 키 자체가 없어야 한다(선택 안 했으므로).
    expect(previewStatsAnalysis.mock.calls[0][0].requestedMethod).toBeUndefined();
    await waitFor(() => expect(screen.getByText('Pearson 상관')).toBeTruthy());
  });

  it('method를 선택하지 않으면 preview가 ready여도 실행 버튼이 비활성 상태다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToBivariate(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));

    previewStatsAnalysis.mockResolvedValueOnce(bivariatePreview([availableMethod('pearson_correlation')]));
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('Pearson 상관')).toBeTruthy());

    expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(true);
  });

  it('available 상태 method를 클릭해 선택하면 실행 버튼이 활성화된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToBivariate(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));

    previewStatsAnalysis.mockResolvedValueOnce(bivariatePreview([availableMethod('pearson_correlation')]));
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('Pearson 상관')).toBeTruthy());

    // 다음 preview 호출(method 선택으로 조건 키가 바뀌어 재발사됨)도 준비해둔다.
    previewStatsAnalysis.mockResolvedValueOnce(bivariatePreview([availableMethod('pearson_correlation')]));
    await user.click(screen.getByText('Pearson 상관'));
    await waitForDebounce();

    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));
  });

  it('unsupported 상태 method는 클릭해도 선택되지 않는다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToBivariate(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));

    previewStatsAnalysis.mockResolvedValueOnce(bivariatePreview([
      availableMethod('welch_t', { status: 'unsupported', reasonCode: 'METHOD_TYPE_MISMATCH' }),
    ]));
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('Welch t 검정')).toBeTruthy());

    await user.click(screen.getByText('Welch t 검정'));
    // unsupported라 클릭이 무시되므로 실행 버튼은 여전히 비활성.
    expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(true);
  });

  it('변수 3개 선택 상태에서 이변량 전환을 시도하면 막히고 경고가 뜬다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /노출 한도 초과/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));

    await switchToBivariate(user);

    expect(screen.getByText(/변수를 2개까지만 지원합니다/)).toBeTruthy();
    // 전환이 거부됐으므로 "기술통계" 세그먼트가 여전히 활성 상태여야 한다.
    expect(screen.getByRole('button', { name: '기술통계' }).className).toContain('swb-seg-opt--active');
  });
});

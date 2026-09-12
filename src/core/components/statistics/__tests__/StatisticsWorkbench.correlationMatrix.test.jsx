// @vitest-environment jsdom
// PR3-B — 상관행렬 모드의 클라이언트 핵심 불변식: 변수 3개 미만이면 preview가 안
// 나가는지, 3개 이상이면 method 미선택이어도 preview가 나가는지(이변량과 동일한
// 순환의존 방지 원칙), available method 선택 후에만 실행 버튼이 활성화되는지.
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

function continuousVar(key, label, formulaFamily) {
  return {
    key, label, group: 'test', moduleId: 'test',
    grain: 'case', type: 'continuous', unit: null, provenance: 'derived', dependsOn: [],
    availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive', formulaFamily,
    supportedFormulaPolicies: ['recompute_current'], formulaVersionKey: null,
  };
}

function catalogFixture() {
  return {
    catalogVersion: 'cv1',
    variables: [
      continuousVar('knee.relatedness.max', '신체부담기여도(최대)', 'knee_relatedness'),
      continuousVar('spine.vibration.dvMax', '전신진동 일일노출량', 'spine_wbv'),
      continuousVar('cervical.case.maxJobCumulativeKgHours', '경추 누적부하', 'cervical_bk2109'),
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
    formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e3', serializerVersion: 'sv1',
    inferenceGatePolicyVersion: 'v1-repeated-measures-gate', analysisMode: 'correlation_matrix',
  };
}

function correlationMatrixPreview(availableMethods) {
  return {
    runManifest: runManifest('22222222-2222-2222-2222-222222222222'),
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

async function switchToCorrelationMatrix(user) {
  await user.click(await screen.findByRole('button', { name: '상관행렬' }));
}

describe('StatisticsWorkbench — PR3-B 상관행렬 모드', () => {
  it('변수 2개만 선택하면 preview가 나가지 않는다(3개 미만은 미완성 레시피)', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToCorrelationMatrix(user);

    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));
    await waitForDebounce();

    expect(previewStatsAnalysis).not.toHaveBeenCalled();
  });

  it('변수 3개를 선택하면 method 미선택이어도 preview가 발사된다(순환의존 방지)', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToCorrelationMatrix(user);

    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));
    await user.click(screen.getByRole('checkbox', { name: /경추 누적부하/ }));

    previewStatsAnalysis.mockResolvedValueOnce(correlationMatrixPreview([
      availableMethod('pearson_correlation'),
      availableMethod('spearman_correlation'),
    ]));
    await waitForDebounce();

    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisMode: 'correlation_matrix',
        variableKeys: expect.arrayContaining([
          'knee.relatedness.max', 'spine.vibration.dvMax', 'cervical.case.maxJobCumulativeKgHours',
        ]),
      }),
      SESSION,
      expect.anything(),
    );
    expect(previewStatsAnalysis.mock.calls[0][0].requestedMethod).toBeUndefined();
    await waitFor(() => expect(screen.getByText('Pearson 상관')).toBeTruthy());
  });

  it('method를 선택하지 않으면 실행 버튼이 비활성 상태다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToCorrelationMatrix(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));
    await user.click(screen.getByRole('checkbox', { name: /경추 누적부하/ }));

    previewStatsAnalysis.mockResolvedValueOnce(correlationMatrixPreview([availableMethod('pearson_correlation')]));
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('Pearson 상관')).toBeTruthy());

    expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(true);
  });

  it('available 상태 method를 선택하면 실행 버튼이 활성화된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToCorrelationMatrix(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /전신진동/ }));
    await user.click(screen.getByRole('checkbox', { name: /경추 누적부하/ }));

    previewStatsAnalysis.mockResolvedValueOnce(correlationMatrixPreview([availableMethod('pearson_correlation')]));
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('Pearson 상관')).toBeTruthy());

    previewStatsAnalysis.mockResolvedValueOnce(correlationMatrixPreview([availableMethod('pearson_correlation')]));
    await user.click(screen.getByText('Pearson 상관'));
    await waitForDebounce();

    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));
  });
});

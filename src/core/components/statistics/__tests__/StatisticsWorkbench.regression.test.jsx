// @vitest-environment jsdom
// PR4-A1 — 회귀 모드의 클라이언트 핵심 불변식: outcome 미지정이면 preview가 안
// 나가는지(zod가 regression 객체를 필수로 요구하므로), outcome 지정 시 method
// 미선택이어도 preview가 나가는지(리뷰 #1 — 순환의존 방지 원칙 재확인),
// outcome을 바꾸면 preview가 재실행되는지(계획 §5 "outcomeKey를 조건 키에
// 반드시 포함" — grain 버그와 동일한 함정), available method 선택 후에만
// 실행 버튼이 활성화되는지. StatisticsWorkbench.correlationMatrix.test.jsx와
// 동일한 패턴.
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

function variable(key, label, type, formulaFamily) {
  return {
    key, label, group: 'test', moduleId: 'test',
    grain: 'case', type, unit: null, provenance: 'derived', dependsOn: [],
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
      variable('knee.relatedness.max', '신체부담기여도(최대)', 'continuous', 'knee_relatedness'),
      variable('shoulder.exposure.anyExceeded', '어깨 노출 초과', 'boolean', 'shoulder_exposure'),
    ],
    supportedGrains: ['case'],
    unsupportedGrains: [],
    minimumCohort: 10,
  };
}

function runManifest(id) {
  return {
    analysisRunId: id, snapshotAsOf: '2024-01-01T00:00:00.000Z',
    recipeDigest: 'r', sourceDigest: 's', resultDigest: 'd',
    catalogVersion: 'cv1', extractorVersion: 'cv1', migrationVersion: 'mv1',
    formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e5', serializerVersion: 'sv1',
    inferenceGatePolicyVersion: 'v1-repeated-measures-gate', analysisMode: 'regression',
  };
}

function regressionPreview(availableMethods, candidateParameterCount = 2) {
  return {
    runManifest: runManifest('33333333-3333-3333-3333-333333333333'),
    counts: { personCount: 40, caseCount: 40, observationCount: 40, suppressed: false, minimumCohort: 10, reasonCode: null },
    estimability: { completeCaseN: 40, missingRatesByVariable: {}, distinctAssignedDoctorClusters: 2, candidateParameterCount, eventNonEvent: [], estimabilityPolicyVersion: 'v1' },
    availableMethods,
    methodCatalogVersion: 'v2-regression',
    differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
  };
}

function availableMethod(id, overrides = {}) {
  return {
    id, label: id, purpose: 'association', status: 'available', reasonCode: null,
    observed: { personCount: 40, rowCount: 40 }, required: null, remedy: null, remedyRecipePatch: null,
    methodPolicyVersion: 'v2-regression',
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

async function switchToRegression(user) {
  // "회귀"라는 이름의 버튼이 2개 있다 — RecipePanel의 분석 모드 세그먼트와
  // ResultPanel의 결과 탭(TABS). DOM 순서상 RecipePanel이 먼저 렌더되므로
  // 첫 번째가 모드 전환 버튼이다.
  const buttons = await screen.findAllByRole('button', { name: '회귀' });
  await user.click(buttons[0]);
}

describe('StatisticsWorkbench — PR4-A1 회귀 모드', () => {
  it('변수 2개를 선택해도 outcome을 지정하지 않으면 preview가 나가지 않는다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToRegression(user);

    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /어깨 노출 초과/ }));
    await waitForDebounce();

    expect(previewStatsAnalysis).not.toHaveBeenCalled();
  });

  it('outcome을 지정하면 method 미선택이어도 preview가 발사된다(순환의존 방지, 리뷰 #1)', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToRegression(user);

    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /어깨 노출 초과/ }));

    previewStatsAnalysis.mockResolvedValueOnce(regressionPreview([
      availableMethod('ols_linear'),
      availableMethod('binary_logistic', { status: 'unsupported', reasonCode: 'METHOD_TYPE_MISMATCH' }),
    ]));
    const outcomeSelect = await screen.findByRole('combobox', { name: '결과변수' });
    await user.selectOptions(outcomeSelect, '신체부담기여도(최대)');
    await waitForDebounce();

    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisMode: 'regression',
        variableKeys: expect.arrayContaining(['knee.relatedness.max', 'shoulder.exposure.anyExceeded']),
        regression: { outcomeKey: 'knee.relatedness.max' },
      }),
      SESSION,
      expect.anything(),
    );
    expect(previewStatsAnalysis.mock.calls[0][0].requestedMethod).toBeUndefined();
    await waitFor(() => expect(screen.getByText('선형회귀(OLS)')).toBeTruthy());
  });

  it('outcome을 바꾸면 preview가 재실행된다(조건 키에 outcomeKey 포함)', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToRegression(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /어깨 노출 초과/ }));

    previewStatsAnalysis.mockResolvedValueOnce(regressionPreview([availableMethod('ols_linear')]));
    const outcomeSelect = await screen.findByRole('combobox', { name: '결과변수' });
    await user.selectOptions(outcomeSelect, '신체부담기여도(최대)');
    await waitForDebounce();
    expect(previewStatsAnalysis).toHaveBeenCalledTimes(1);

    previewStatsAnalysis.mockResolvedValueOnce(regressionPreview([availableMethod('binary_logistic')]));
    await user.selectOptions(outcomeSelect, '어깨 노출 초과');
    await waitForDebounce();

    expect(previewStatsAnalysis).toHaveBeenCalledTimes(2);
    expect(previewStatsAnalysis.mock.calls[1][0].regression).toEqual({ outcomeKey: 'shoulder.exposure.anyExceeded' });
  });

  it('method를 선택하지 않으면 실행 버튼이 비활성 상태다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToRegression(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /어깨 노출 초과/ }));

    previewStatsAnalysis.mockResolvedValueOnce(regressionPreview([availableMethod('ols_linear')]));
    const outcomeSelect = await screen.findByRole('combobox', { name: '결과변수' });
    await user.selectOptions(outcomeSelect, '신체부담기여도(최대)');
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('선형회귀(OLS)')).toBeTruthy());

    expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(true);
  });

  it('available 상태 method를 선택하면 실행 버튼이 활성화된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await switchToRegression(user);
    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('checkbox', { name: /어깨 노출 초과/ }));

    previewStatsAnalysis.mockResolvedValueOnce(regressionPreview([availableMethod('ols_linear')]));
    const outcomeSelect = await screen.findByRole('combobox', { name: '결과변수' });
    await user.selectOptions(outcomeSelect, '신체부담기여도(최대)');
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('선형회귀(OLS)')).toBeTruthy());

    previewStatsAnalysis.mockResolvedValueOnce(regressionPreview([availableMethod('ols_linear')]));
    await user.click(screen.getByText('선형회귀(OLS)'));
    await waitForDebounce();

    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));
  });
});

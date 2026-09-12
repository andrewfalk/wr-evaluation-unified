// @vitest-environment jsdom
// PR0-B3 Part A — grain 선택 UI. 계획 pr0-b3-shimmying-magpie.md "Grain 선택 UI" 절의
// 요구사항 3가지를 실측한다: (1) grain 변경 시 buildConditionKey에 grain이 포함돼
// preview가 재실행되는지, (2) grain 변경 시 선택된 변수·필터가 초기화되는지, (3) 이전
// grain에서 필터를 편집하던 중 전환해도 FilterEditor가 재마운트되어 새 grain의 필터를
// 정상 추가할 수 있는지(key={grain}).
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
        key: 'spine.vibration.intervalA8Max', label: '전신진동 구간별 A(8) 등가 가속도(상한)', group: '요추(허리) · 파생지표', moduleId: 'spine',
        grain: 'vibration_interval', type: 'continuous', unit: 'm/s²', provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'spine_wbv',
        supportedFormulaPolicies: ['recompute_current'], formulaVersionKey: null,
      },
      {
        key: 'knee.diagnosisSide.klGrade', label: 'K-L Grade', group: '무릎 · 진단별 판정', moduleId: 'knee',
        grain: 'diagnosis_side', type: 'ordinal', unit: null, provenance: 'clinician_judgment', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'knee_kl_grade_side',
        supportedFormulaPolicies: [], formulaVersionKey: null,
      },
      {
        key: 'job.identity.jobNameNormalized', label: '직종명(정규화)', group: '직업력 · 공통', moduleId: 'job',
        grain: 'job', type: 'high_cardinality', unit: null, provenance: 'raw', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association'],
        sensitivity: 'quasi_identifier', formulaFamily: 'job_identity',
        supportedFormulaPolicies: [], formulaVersionKey: null,
      },
      {
        key: 'spine.task.weightKg', label: 'MDDM 작업 중량물(kg)', group: '요추(허리) · 파생지표', moduleId: 'spine',
        grain: 'task', type: 'continuous', unit: 'kg', provenance: 'raw', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'spine_mddm_task',
        supportedFormulaPolicies: [], formulaVersionKey: null, analysisRole: 'analyzable',
      },
      // PR0-B3 Part C-2 — 필터 전용 변수 계약 실측용. case grain인데 analysisRole이
      // filter_only라 분석 변수 체크박스에는 안 뜨고, 필터 선택 후보에는 떠야 한다.
      {
        key: 'case.meta.registeredAt', label: '등록일', group: '사례 메타 · 공통', moduleId: 'meta',
        grain: 'case', type: 'date', unit: null, provenance: 'raw', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'case_meta_registered_at',
        supportedFormulaPolicies: [], formulaVersionKey: null, analysisRole: 'filter_only',
      },
    ],
    supportedGrains: ['case', 'vibration_interval', 'diagnosis_side', 'job', 'task'],
    unsupportedGrains: [
      { grain: 'person', reasonCode: 'GRAIN_NOT_YET_SUPPORTED' },
      { grain: 'job_diagnosis', reasonCode: 'GRAIN_NOT_YET_SUPPORTED' },
    ],
    minimumCohort: 10,
  };
}

function runManifest(id) {
  return {
    analysisRunId: id, snapshotAsOf: '2024-01-01T00:00:00.000Z',
    recipeDigest: 'r', sourceDigest: 's', resultDigest: 'd',
    catalogVersion: 'cv1', extractorVersion: 'cv1', migrationVersion: 'mv1',
    formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e1', serializerVersion: 'sv1',
  };
}

function readyPreview() {
  return {
    runManifest: runManifest('11111111-1111-1111-1111-111111111111'),
    counts: { personCount: 20, caseCount: 20, observationCount: 20, suppressed: false, minimumCohort: 10, reasonCode: null },
    estimability: { completeCaseN: 20, missingRatesByVariable: {}, distinctAssignedDoctorClusters: 2, candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'v1' },
    availableMethods: [], methodCatalogVersion: null,
    differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
  };
}

async function waitForDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
}

function analyzeResponse() {
  return {
    runManifest: runManifest('22222222-2222-2222-2222-222222222222'),
    result: {
      continuous: [{
        variableKey: 'spine.vibration.intervalA8Max', kind: 'continuous', suppressed: false,
        n: 20, missingCount: 0, missingPatterns: [],
        mean: 0.85, sd: 0.2, median: 0.8, q1: 0.7, q3: 1.0, iqr: 0.3, skewness: 0.1, kurtosis: -0.2, min: 0.3, max: 1.5,
        nullReasons: {},
      }],
      discrete: [],
    },
  };
}

function discreteAnalyzeResponse() {
  return {
    runManifest: runManifest('33333333-3333-3333-3333-333333333333'),
    result: {
      continuous: [],
      discrete: [{
        variableKey: 'knee.diagnosisSide.klGrade', kind: 'discrete', suppressed: false,
        n: 20, missingCount: 0, missingPatterns: [],
        levels: [{ level: '2', count: 20, proportion: 1 }], mode: '2',
      }],
    },
  };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1920;
});

describe('StatisticsWorkbench — grain 선택(PR0-B3 Part A)', () => {
  it('supportedGrains의 두 grain이 모두 선택지로 보이고, case가 기본 선택이다', async () => {
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    const caseBtn = await screen.findByRole('button', { name: '사례(case)' });
    const vibBtn = screen.getByRole('button', { name: '진동구간' });
    expect(caseBtn.className).toMatch(/active/);
    expect(vibBtn.className).not.toMatch(/active/);
    // CatalogPanel이 case grain 변수만 보여준다.
    expect(screen.getByRole('checkbox', { name: /신체부담기여도/ })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /전신진동 구간별/ })).toBeNull();
  });

  it('grain을 진동구간으로 바꾸면 카탈로그 후보가 바뀌고, 선택된 변수가 초기화된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    expect(screen.getByRole('checkbox', { name: /신체부담기여도/ }).checked).toBe(true);

    await user.click(screen.getByRole('button', { name: '진동구간' }));

    // case grain 변수 후보는 더 이상 안 보인다 — grain 전환 시 후보 자체를 제한.
    expect(screen.queryByRole('checkbox', { name: /신체부담기여도/ })).toBeNull();
    // vibration_interval 변수가 후보로 보이고, 선택 상태는 초기화돼 있다(체크 안 됨).
    const vibCheckbox = screen.getByRole('checkbox', { name: /전신진동 구간별/ });
    expect(vibCheckbox.checked).toBe(false);
  });

  it('grain 변경이 조건 키에 반영돼 새 grain으로 preview가 재요청된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '진동구간' }));
    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /전신진동 구간별/ }));
    await waitForDebounce();

    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'vibration_interval', variableKeys: ['spine.vibration.intervalA8Max'] }),
      SESSION,
      expect.anything(),
    );
  });

  it('case grain에서 필터를 추가한 뒤 진동구간으로 전환해도 새 grain의 필터를 정상적으로 추가할 수 있다(FilterEditor 재마운트)', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    // case grain에서 필터 편집 select가 이미 렌더돼 있는지 확인(내부 useState가 채워진 상태).
    const caseFilterKeySelect = await screen.findByDisplayValue('신체부담기여도(최대)');
    expect(caseFilterKeySelect).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '진동구간' }));

    // 전환 후 필터 편집기의 변수 select에는 vibration_interval 변수만 후보로 있어야 하고
    // (case 변수 잔존 없음), 정상적으로 필터를 추가할 수 있어야 한다(재마운트 확인).
    const vibFilterKeySelect = screen.getByDisplayValue('전신진동 구간별 A(8) 등가 가속도(상한)');
    expect(vibFilterKeySelect).toBeTruthy();
    expect(screen.queryByText('신체부담기여도(최대)', { selector: 'option' })).toBeNull();

    await user.type(screen.getByPlaceholderText('값'), '1.2');
    await user.click(screen.getByRole('button', { name: '필터 추가' }));

    // 필터 추가가 실제로 반영됐는지(칩으로 표시) 확인 — 무동작(조용한 실패)이 아니었다는 증거.
    expect(await screen.findByText(/전신진동 구간별.*1\.2/)).toBeTruthy();
  });

  it('진동구간 grain에서 변수 선택 → preview → 분석 실행까지 전체 경로가 동작하고 결과가 표시된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '진동구간' }));
    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /전신진동 구간별/ }));
    await waitForDebounce();
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce(analyzeResponse());
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));

    await waitFor(() => expect(screen.getByText(/0\.85/)).toBeTruthy());
    expect(runStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'vibration_interval', variableKeys: ['spine.vibration.intervalA8Max'] }),
      SESSION,
    );
  });

  // PR0-B3 Part B — diagnosis_side grain도 vibration_interval(Part A)과 동일하게 전체
  // 경로가 동작하는지 실측한다. supportedGrains 응답에 따라 후보 자체가 늘어난다는 점만
  // 다르다(그 외 grain-agnostic 배선은 위 vibration_interval 테스트가 이미 증명).
  it('진단측(diagnosis_side) grain에서 변수 선택 → preview → 분석 실행까지 전체 경로가 동작하고 결과가 표시된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    const diagBtn = await screen.findByRole('button', { name: '진단측' });
    expect(diagBtn.className).not.toMatch(/active/);
    await user.click(diagBtn);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /K-L Grade/ }));
    await waitForDebounce();
    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'diagnosis_side', variableKeys: ['knee.diagnosisSide.klGrade'] }),
      SESSION,
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce(discreteAnalyzeResponse());
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));

    await waitFor(() => expect(screen.getByText(/최빈값=2/)).toBeTruthy());
    expect(runStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'diagnosis_side', variableKeys: ['knee.diagnosisSide.klGrade'] }),
      SESSION,
    );
  });

  // PR0-B3 Part C — job grain도 동일하게 전체 경로가 동작하는지 실측한다.
  it('직업력(job) grain에서 변수 선택 → preview → 분석 실행까지 전체 경로가 동작하고 결과가 표시된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    const jobBtn = await screen.findByRole('button', { name: '직업력' });
    expect(jobBtn.className).not.toMatch(/active/);
    await user.click(jobBtn);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /직종명/ }));
    await waitForDebounce();
    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'job', variableKeys: ['job.identity.jobNameNormalized'] }),
      SESSION,
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce({
      runManifest: runManifest('44444444-4444-4444-4444-444444444444'),
      result: {
        continuous: [],
        discrete: [{
          variableKey: 'job.identity.jobNameNormalized', kind: 'discrete', suppressed: false,
          n: 20, missingCount: 0, missingPatterns: [],
          levels: [{ level: '용접공', count: 20, proportion: 1 }], mode: '용접공',
        }],
      },
    });
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));

    await waitFor(() => expect(screen.getByText(/최빈값=용접공/)).toBeTruthy());
    expect(runStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'job', variableKeys: ['job.identity.jobNameNormalized'] }),
      SESSION,
    );
  });

  // PR0-B3 Part C-2 — task grain도 동일하게 전체 경로가 동작하는지 실측한다.
  it('작업(task) grain에서 변수 선택 → preview → 분석 실행까지 전체 경로가 동작하고 결과가 표시된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    const taskBtn = await screen.findByRole('button', { name: '작업' });
    expect(taskBtn.className).not.toMatch(/active/);
    await user.click(taskBtn);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /MDDM 작업 중량물/ }));
    await waitForDebounce();
    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'task', variableKeys: ['spine.task.weightKg'] }),
      SESSION,
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce(analyzeResponse());
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));

    await waitFor(() => expect(screen.getByText(/0\.85/)).toBeTruthy());
    expect(runStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'task', variableKeys: ['spine.task.weightKg'] }),
      SESSION,
    );
  });

  // PR0-B3 Part C — 필터 전용 변수 계약(analysisRole). 등록일은 case grain 소속이므로
  // 기본 화면(case)에서 확인한다.
  it('필터 전용 변수(등록일)는 분석 변수 체크박스에 없지만 필터 후보에는 있다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await screen.findByRole('checkbox', { name: /신체부담기여도/ });
    expect(screen.queryByRole('checkbox', { name: /등록일/ })).toBeNull();

    await user.selectOptions(await screen.findByDisplayValue('신체부담기여도(최대)'), '등록일');
    expect(await screen.findByDisplayValue('등록일')).toBeTruthy();
  });
});

// @vitest-environment jsdom
// PR2 §6 — 가장 많이 리뷰를 거친 상태 머신(조건-key+요청세대 기반 preview 유효성,
// committed snapshot, draft≠committed 배너)이 실제로 화면에서 동작하는지 검증한다.
// 500ms 디바운스는 fake timer 대신 실제 대기로 넘긴다(testing-library의 findBy*/waitFor
// 내부 폴링이 fake timer와 얽히면 불안정해지는 문제를 피하기 위함 — useServerConfig 테스트에서
// 이미 한 번 겪은 함정과 동일한 종류).
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
    formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e1', serializerVersion: 'sv1',
  };
}

function readyPreview(overrides = {}) {
  return {
    runManifest: runManifest('11111111-1111-1111-1111-111111111111'),
    counts: { personCount: 20, caseCount: 20, observationCount: 20, suppressed: false, minimumCohort: 10, reasonCode: null, ...overrides.counts },
    estimability: { completeCaseN: 20, missingRatesByVariable: {}, distinctAssignedDoctorClusters: 2, candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'v1' },
    availableMethods: [], methodCatalogVersion: null,
    differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
  };
}

function analyzeResponse() {
  return {
    runManifest: runManifest('22222222-2222-2222-2222-222222222222'),
    result: {
      continuous: [{
        variableKey: 'knee.relatedness.max', kind: 'continuous', suppressed: false,
        n: 20, missingCount: 0, missingPatterns: [],
        mean: 12.3, sd: 4.1, median: 11, q1: 9, q3: 14, iqr: 5, skewness: 0.1, kurtosis: -0.2, min: 2, max: 30,
        nullReasons: {},
      }],
      discrete: [],
    },
  };
}

async function selectFirstVariable(user) {
  const checkbox = await screen.findByRole('checkbox', { name: /신체부담기여도/ });
  await user.click(checkbox);
}

// preview effect의 500ms 디바운스가 실제로 지나가고 그 응답이 반영될 때까지 대기.
async function waitForDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // jsdom 기본 innerWidth는 1024px — §10 반응형 규칙("<1280이면 카탈로그 자동 접힘")이
  // 그대로 발동해 카탈로그가 접힌 채로 마운트된다(실제 좁은 창에서는 의도된 동작이지만,
  // 이 테스트들은 카탈로그가 펼쳐진 넓은 화면을 전제로 하므로 뷰포트를 넓게 고정한다).
  window.innerWidth = 1920;
});

describe('StatisticsWorkbench — 카탈로그 로드 + 변수 선택 → preview', () => {
  it('카탈로그를 불러와 변수 목록을 렌더링한다', async () => {
    // 같은 라벨 텍스트가 RecipePanel의 필터-변수 <select> 옵션에도 나타나므로(§5 FilterEditor),
    // 카탈로그 체크박스로 구체적으로 조회한다 — getByText는 두 곳 다 매칭돼 모호해진다.
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    expect(await screen.findByRole('checkbox', { name: /신체부담기여도/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /노출 한도 초과/ })).toBeTruthy();
  });

  it('변수를 선택하면 500ms 후 preview가 호출되고 결과가 표시된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText('person')).toBeTruthy());
    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ variableKeys: ['knee.relatedness.max'] }),
      SESSION,
      expect.anything(),
    );
  });

  it('preview가 최소표본 미달로 억제되면 실행 버튼이 비활성 상태로 남는다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview({
      counts: { personCount: null, caseCount: null, observationCount: null, suppressed: true, minimumCohort: 10, reasonCode: 'MIN_COHORT_NOT_MET' },
    }));
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText(/최소 표본/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(true);
  });
});

describe('StatisticsWorkbench — analyze 실행 + committed snapshot', () => {
  it('분석 실행 성공 시 결과가 표시되고, 이후 draft를 바꾸면 "조건 변경됨" 배너가 뜬다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await waitForDebounce();
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce(analyzeResponse());
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));
    await waitFor(() => expect(screen.getByText(/12\.3/)).toBeTruthy());
    expect(screen.queryByText(/조건이 변경됨/)).toBeNull();

    // draft를 바꾼다(두 번째 변수 선택) — committed 결과는 그대로 남고 배너만 뜬다.
    const secondCheckbox = screen.getByRole('checkbox', { name: /노출 한도 초과/ });
    await user.click(secondCheckbox);
    await waitFor(() => expect(screen.getByText(/조건이 변경됨/)).toBeTruthy());
    // 이미 실행된 committed 결과(12.3)는 draft가 바뀌어도 그대로 남아 있어야 한다.
    expect(screen.getByText(/12\.3/)).toBeTruthy();
  });

  it('억제된 연속형 변수는 다른 값 없이 "공개 정책에 따라 표시되지 않음"만 보여준다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);
    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await waitForDebounce();
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce({
      runManifest: runManifest('33333333-3333-3333-3333-333333333333'),
      result: { continuous: [{ variableKey: 'knee.relatedness.max', kind: 'continuous', suppressed: true }], discrete: [] },
    });
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));
    await waitFor(() => expect(screen.getByText('공개 정책에 따라 표시되지 않음')).toBeTruthy());
  });
});

describe('StatisticsWorkbench — 내보내기', () => {
  it('실행 결과가 있으면 내보내기 버튼이 exportStatsAggregate를 analysisRunId로 호출한다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);
    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await waitForDebounce();
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    const analyzeRes = analyzeResponse();
    runStatsAnalysis.mockResolvedValueOnce(analyzeRes);
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));
    await waitFor(() => expect(screen.getByText(/집계 결과 내보내기/)).toBeTruthy());

    exportStatsAggregate.mockResolvedValueOnce(new Blob(['csv'], { type: 'text/csv' }));
    // jsdom엔 URL.createObjectURL이 없다 — 다운로드 트리거 자체는 이 테스트의 관심사가 아니므로 스텁.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    await user.click(screen.getByText(/집계 결과 내보내기/));
    await waitFor(() => expect(exportStatsAggregate).toHaveBeenCalledWith(analyzeRes.runManifest.analysisRunId, SESSION));
  });
});

describe('StatisticsWorkbench — 가용성 배너(§4)', () => {
  it('API가 404 NOT_FOUND를 반환하면 배너를 띄우고 새로고침 버튼이 refetchConfig를 부른다', async () => {
    fetchStatsCatalog.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404, data: { code: 'NOT_FOUND' } }));
    const refetchConfig = vi.fn();
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} refetchConfig={refetchConfig} />);
    expect(await screen.findByText('기능을 사용할 수 없게 되었습니다.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '새로고침' }));
    expect(refetchConfig).toHaveBeenCalledTimes(1);
  });

  // 리뷰 §2 — statsAvailable이 true→true(값 변화 없음)로 재조회가 끝나는 경우(config는 이미
  // true로 저장돼 있었고, 일시적 404만 있다가 서버가 복구된 상황)에도 배너가 내려가고 카탈로그가
  // 다시 조회돼야 한다. configRefreshing의 true→false 하강 엣지로 감지하는지 검증한다.
  it('statsAvailable 값이 안 바뀌어도(true→true) 재조회가 끝나면 배너가 내려가고 카탈로그를 다시 가져온다', async () => {
    fetchStatsCatalog.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404, data: { code: 'NOT_FOUND' } }));
    const { rerender } = render(
      <StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} configRefreshing={false} />,
    );
    expect(await screen.findByText('기능을 사용할 수 없게 되었습니다.')).toBeTruthy();
    expect(fetchStatsCatalog).toHaveBeenCalledTimes(1);

    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    // 부모(App.jsx)가 refetchConfig()를 실행하는 동안의 실제 prop 전이를 재현: false → true → false.
    // statsAvailable 자체는 시종일관 true(값이 안 바뀜)라는 게 이 시나리오의 핵심.
    rerender(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} configRefreshing />);
    rerender(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} configRefreshing={false} />);

    await waitFor(() => expect(screen.queryByText('기능을 사용할 수 없게 되었습니다.')).toBeNull());
    expect(fetchStatsCatalog).toHaveBeenCalledTimes(2);
  });

  // 리뷰 §1(2차) — useServerConfig.js의 refetchConfig()는 실패 시 statsAvailable 값을 그대로
  // 둔다(오래된 응답이 최신 상태를 덮지 않게 하려는 설계). 즉 재조회가 "실패"해도
  // configRefreshing은 true→false로 전이하고 statsAvailable은 여전히 true다 — 이 경우를
  // 성공한 복구와 혼동하면 안 된다. configRefreshError가 남아있으면 배너·잠금을 유지해야 한다.
  it('재조회가 실패하면(configRefreshError 남음) statsAvailable이 true여도 복구로 처리하지 않는다', async () => {
    fetchStatsCatalog.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404, data: { code: 'NOT_FOUND' } }));
    const { rerender } = render(
      <StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} configRefreshing={false} configRefreshError={null} />,
    );
    expect(await screen.findByText('기능을 사용할 수 없게 되었습니다.')).toBeTruthy();
    expect(fetchStatsCatalog).toHaveBeenCalledTimes(1);

    // 재조회 시도(false→true) → 실패로 끝남(true→false, statsAvailable은 그대로 true, 하지만
    // configRefreshError가 남는다) — useServerConfig.js:127의 "실패 시 config 유지" 그대로 재현.
    rerender(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} configRefreshing configRefreshError={null} />);
    rerender(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} configRefreshing={false} configRefreshError="새로고침 실패" />);

    // 복구로 오인하지 않았어야 한다 — 배너 유지, 카탈로그 재조회 안 함.
    expect(screen.getByText('기능을 사용할 수 없게 되었습니다.')).toBeTruthy();
    expect(fetchStatsCatalog).toHaveBeenCalledTimes(1);
  });
});

describe('StatisticsWorkbench — 기능 비가용 시 실행·내보내기 잠금(§3)', () => {
  it('preview 실패로 배너가 뜨면, statsAvailable=true·이전 preview=ready가 남아있어도 실행 버튼이 비활성 유지된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await waitForDebounce();
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    // 두 번째 변수를 골라 조건을 바꾸고, 그 preview가 기능비가용(404)으로 실패하는 상황을 만든다.
    previewStatsAnalysis.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404, data: { code: 'NOT_FOUND' } }));
    await user.click(screen.getByRole('checkbox', { name: /노출 한도 초과/ }));
    await waitForDebounce();

    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(true));
  });

  // 3차 리뷰 제안 — 지금까지의 잠금 테스트는 preview 자체가 실패하는 경우만 확인했다.
  // preview는 정상(ready)인데 analyze 호출 자체가 비가용 오류를 반환하는 경로도 검증한다.
  it('preview는 정상인데 analyze가 404 NOT_FOUND를 반환하면 그 이후 재실행 버튼이 잠긴다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await waitForDebounce();
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404, data: { code: 'NOT_FOUND' } }));
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));

    await waitFor(() => expect(screen.getByText('기능을 사용할 수 없게 되었습니다.')).toBeTruthy());
    // preview는 여전히 ready 상태로 남아있지만(조건이 안 바뀜), actionsLocked 때문에 재실행이 잠겨야 한다.
    expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(true);
  });

  it('분석 성공 후 export가 404 NOT_FOUND를 반환하면 내보내기 버튼이 잠긴다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await selectFirstVariable(user);

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await waitForDebounce();
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce(analyzeResponse());
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));
    await waitFor(() => expect(screen.getByText(/집계 결과 내보내기/)).toBeTruthy());

    exportStatsAggregate.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404, data: { code: 'NOT_FOUND' } }));
    await user.click(screen.getByText(/집계 결과 내보내기/));

    await waitFor(() => expect(screen.getByText('기능을 사용할 수 없게 되었습니다.')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: /집계 결과 내보내기/ }).disabled).toBe(true));
  });
});

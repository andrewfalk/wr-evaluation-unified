// @vitest-environment jsdom
//
// 통계 작업대 특성화(P2-76a, Phase 2 C9 구간 B) — 작업대 전체 화면(DOM·폼 값)을 초기(카탈로그 불러오는 중·불러온 뒤)·
// 미리보기 뒤·실행 뒤·실행 실패 뒤에 얼리고, 서버 호출(카탈로그·미리보기·실행·내보내기)의 **횟수와 순서, 보낸 레시피**를 함께 얼린다.
// 변수 상한 사례(K8b-①): 이변량에서 두 개를 고르고 방법을 고른 뒤 세 번째 변수를 누르면 변수는 그대로이고 방법 선택이 초기화되어
// 미리보기가 한 번 더 나간다 — 지금 동작 그대로 얼린다(P2-77b의 reducer가 이것을 지켜야 한다).
// 뒤따르는 이동·구조 PR(P2-76b-ts · P2-77a · P2-77b · P2-77c)의 안전망이다 — 이 골든은 그 PR들에서 바뀌면 안 된다.
// 서버 호출은 기존 작업대 테스트와 같이 statsRepository를 mock한다. 디바운스(500ms)는 가짜 타이머로 넘긴다 — 클릭은 모두
// fireEvent(동기)라 클릭 사이에 미리보기가 끼어들지 않는다(호출 횟수가 기계 부하에 흔들리지 않는다).
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useGoldenEnvironment } from '../../../fixtures/goldenEnv';
import { KEY, availableMethod, previewResponse, resultCases, runManifest, statsCatalog } from '../../../fixtures/statsScreenFixtures';
import type { AnalyzeResponse, CatalogResponse, PreviewResponse, StatsAnalysisRecipe } from '@wr/contracts/stats';
import { formState, serializeDom } from '../../../../testing/renderEvaluation';

type Call = [string, ...unknown[]];
const calls: Call[] = [];
const answers = {
  catalog: [] as Array<() => Promise<CatalogResponse>>,
  preview: [] as Array<() => Promise<PreviewResponse>>,
  analyze: [] as Array<() => Promise<AnalyzeResponse>>,
};
function next<T>(queue: Array<() => Promise<T>>, name: string): Promise<T> {
  const answer = queue.shift();
  if (!answer) throw new Error(`준비하지 않은 ${name} 호출`);
  return answer();
}

vi.mock('../../../services/statsRepository', () => ({
  fetchStatsCatalog: () => { calls.push(['catalog']); return next(answers.catalog, 'catalog'); },
  previewStatsAnalysis: (recipe: StatsAnalysisRecipe) => { calls.push(['preview', recipe]); return next(answers.preview, 'preview'); },
  runStatsAnalysis: (recipe: StatsAnalysisRecipe) => { calls.push(['analyze', recipe]); return next(answers.analyze, 'analyze'); },
  exportStatsAggregate: (analysisRunId: string) => { calls.push(['export', analysisRunId]); return Promise.resolve(new Blob(['a,b\n'])); },
  getStatsRun: () => { calls.push(['getRun']); return Promise.reject(new Error('준비하지 않은 getRun 호출')); },
  cancelStatsRun: () => { calls.push(['cancelRun']); return Promise.resolve(null); },
}));

import { StatisticsWorkbench } from '../StatisticsWorkbench';

const SESSION = { apiBaseUrl: 'https://intranet.synthetic.test', accessToken: 'synthetic-token' };

function goldenJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  useGoldenEnvironment();
  // 디바운스·폴링 타이머까지 가짜로(시계는 useGoldenEnvironment와 같은 시각). vitest는 가짜 타이머가 이미 켜져 있으면
  // useFakeTimers를 다시 불러도 대상을 바꾸지 않는다 — 진짜 타이머로 한 번 되돌린 뒤 다시 켠다.
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  window.innerWidth = 1920;
  calls.length = 0;
  answers.catalog.length = 0;
  answers.preview.length = 0;
  answers.analyze.length = 0;
  URL.createObjectURL = () => 'blob:synthetic';
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function snapshot(container: Element) {
  return { dom: serializeDom(container), form: formState(container), calls: calls.splice(0) };
}

function renderWorkbench() {
  // 앱(ScreenRouter)이 넘기는 props를 모두 넘긴다 — 서버 설정 재조회는 진행 중이 아니고 실패도 없는 상태.
  return render(
    <StatisticsWorkbench
      session={SESSION}
      serverConfig={null}
      statsAvailable
      refetchConfig={() => {}}
      configRefreshing={false}
      configRefreshError={null}
      onClose={() => {}}
    />,
  );
}

function recipePanel(): HTMLElement {
  return screen.getByRole('complementary', { name: '분석 레시피' });
}

function checkbox(name: RegExp) {
  fireEvent.click(screen.getByRole('checkbox', { name }));
}

/** 기술통계 흐름이 고르는 두 변수(신체부담기여도·대표 직종명)의 결과만 담은 실행 응답. */
function descriptiveRun(): AnalyzeResponse {
  const base = resultCases()[0].response;
  const picked = new Set<string>([KEY.relatedness, KEY.job]);
  return {
    ...base,
    result: {
      ...base.result,
      continuous: base.result.continuous.filter((r) => picked.has(r.variableKey)),
      discrete: base.result.discrete.filter((r) => picked.has(r.variableKey)),
    },
  };
}

describe('StatisticsWorkbench 특성화 — 기술통계 흐름', () => {
  it('초기 → 변수 선택 → 미리보기 → 실행 → 조건 변경 → 내보내기', async () => {
    const out: Record<string, unknown> = {};
    answers.catalog.push(() => Promise.resolve(statsCatalog()));
    const { container } = renderWorkbench();
    out['1 카탈로그 불러오는 중'] = snapshot(container);
    await flush();
    out['2 카탈로그 불러온 뒤'] = snapshot(container);

    answers.preview.push(() => Promise.resolve(previewResponse('descriptive')));
    checkbox(/신체부담기여도/);
    checkbox(/대표 직종명/);
    out['3 변수 두 개 선택 직후(디바운스 전)'] = snapshot(container);
    await flush(600);
    out['4 미리보기 뒤'] = snapshot(container);

    answers.analyze.push(() => Promise.resolve({
      ...descriptiveRun(),
      runManifest: runManifest('30000000-0000-4000-8000-000000000001', 'descriptive'),
    }));
    fireEvent.click(screen.getByRole('button', { name: '분석 실행' }));
    await flush();
    out['5 실행 뒤'] = snapshot(container);

    answers.preview.push(() => Promise.resolve(previewResponse('descriptive')));
    fireEvent.click(screen.getByRole('button', { name: '공식 감사' }));
    await flush(600);
    out['6 목적을 바꾼 뒤(조건 변경 배너)'] = snapshot(container);

    // 내려받기 링크 클릭은 jsdom이 탐색을 구현하지 않아 막는다 — 대신 눌린 링크의 파일 이름을 기록한다.
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) { downloads.push(this.download); });
    fireEvent.click(screen.getByRole('button', { name: '집계 결과 내보내기 (CSV)' }));
    await flush();
    out['7 내보내기 뒤'] = { ...snapshot(container), downloads };

    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/statistics-workbench-descriptive.json');
  });
});

describe('StatisticsWorkbench 특성화 — 이변량 변수 상한(K8b-①)', () => {
  it('두 개 선택 → 방법 선택 → 세 번째 변수: 변수는 그대로, 방법 초기화, 미리보기 한 번 더', async () => {
    const out: Record<string, unknown> = {};
    answers.catalog.push(() => Promise.resolve(statsCatalog()));
    const { container } = renderWorkbench();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '이변량' }));
    calls.splice(0);

    const methods = () => Promise.resolve(previewResponse('bivariate', [availableMethod('welch_t'), availableMethod('mann_whitney')]));
    answers.preview.push(methods);
    checkbox(/신체부담기여도/);
    checkbox(/노출 한도 초과/);
    await flush(600);
    out['1 두 개 선택 뒤 미리보기'] = snapshot(container);

    answers.preview.push(methods);
    fireEvent.click(screen.getByRole('button', { name: /Welch t 검정/ }));
    await flush(600);
    out['2 방법 선택 뒤 미리보기'] = snapshot(container);

    answers.preview.push(methods);
    checkbox(/전신진동/);
    out['3 세 번째 변수 누른 직후'] = snapshot(container);
    await flush(600);
    out['4 세 번째 변수 누른 뒤 미리보기'] = snapshot(container);

    // 이 상태로는 세 번째 변수가 선택되지 않는다(체크 상태도 확인).
    expect((screen.getByRole('checkbox', { name: /전신진동/ }) as HTMLInputElement).checked).toBe(false);
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/statistics-workbench-cap.json');
  });
});

describe('StatisticsWorkbench 특성화 — 실행 실패와 미리보기 실패', () => {
  it('회귀 미리보기 실패 → 다시 미리보기 → 실행 실패 배너', async () => {
    const out: Record<string, unknown> = {};
    answers.catalog.push(() => Promise.resolve(statsCatalog()));
    const { container } = renderWorkbench();
    await flush();
    fireEvent.click(within(recipePanel()).getByRole('button', { name: '회귀' }));
    checkbox(/신체부담기여도/);
    checkbox(/^나이/);
    fireEvent.change(screen.getByRole('combobox', { name: '결과변수' }), { target: { value: KEY.relatedness } });
    calls.splice(0);

    const badRecipe = Object.assign(new Error('잘못된 요청'), { status: 400, data: { code: 'INVALID_RECIPE', message: '잘못된 레시피' } });
    answers.preview.push(() => Promise.reject(badRecipe));
    await flush(600);
    out['1 미리보기 실패'] = snapshot(container);

    const regressionMethods = () => Promise.resolve(previewResponse('regression', [availableMethod('ols_linear')]));
    answers.preview.push(regressionMethods);
    fireEvent.click(screen.getByRole('checkbox', { name: /표준화/ }));
    await flush(600);
    answers.preview.push(regressionMethods);
    fireEvent.click(screen.getByRole('button', { name: /선형회귀\(OLS\)/ }));
    await flush(600);
    out['2 옵션·방법을 고른 뒤 미리보기'] = snapshot(container);

    const serverError = Object.assign(new Error('통계 엔진 오류'), { status: 503, data: { code: 'ENGINE_UNAVAILABLE', message: '엔진 응답 없음' } });
    answers.analyze.push(() => Promise.reject(serverError));
    fireEvent.click(screen.getByRole('button', { name: '분석 실행' }));
    await flush();
    out['3 실행 실패 뒤'] = snapshot(container);

    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/statistics-workbench-errors.json');
  });
});

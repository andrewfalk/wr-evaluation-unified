// @vitest-environment jsdom
//
// 결과 패널 특성화(P2-76a, Phase 2 C9 구간 B) — 결과 종류별(연속·범주 기술통계, 분포, 층화 표, 그룹 비교, 분할표, 상관,
// 상관행렬, 회귀, 예측, 억제·제한공개)로 다섯 탭의 지금 화면(DOM)을 얼린다. 분포 탭은 차트의 '데이터 보기'를 모두 연 화면도
// 얼린다. 패널 상태(결과 없음·조건 변경 배너·내보내기 중·내보내기 실패·잠금)도 따로 얼린다.
// 뒤따르는 이동·분할 PR(P2-78a-ts · P2-78b~d)의 안전망이다 — 이 골든은 그 PR들에서 바뀌면 안 된다.
// 입력은 `src/core/fixtures/statsScreenFixtures.ts`(계약 스키마를 그대로 통과하는 값 — 첫 테스트가 확인한다).
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AnalyzeResponseSchema, CatalogResponseSchema, StatsAnalysisRecipeSchema } from '@wr/contracts/stats';
import { useGoldenEnvironment } from '../../../fixtures/goldenEnv';
import { resultCases, statsCatalog } from '../../../fixtures/statsScreenFixtures';
import type { ResultCase } from '../../../fixtures/statsScreenFixtures';
import { formState, serializeDom } from '../../../../testing/renderEvaluation';
import { ResultPanel } from '../ResultPanel';

const TABS = ['요약', '분포', '연관성', '회귀', '예측'] as const;

function goldenJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

beforeEach(() => {
  useGoldenEnvironment();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface PanelProps {
  committedResult: ResultCase['response'] | null;
  committedRecipe: ResultCase['recipe'] | null;
  recipeChanged?: boolean;
  exportState?: { status: string; error?: unknown };
  actionsLocked?: boolean;
  exportUnsupported?: boolean;
  onExport?: () => void;
}

function renderPanel({
  committedResult, committedRecipe, recipeChanged = false, exportState = { status: 'idle', error: null },
  actionsLocked = false, exportUnsupported, onExport = () => {},
}: PanelProps) {
  const mode = committedRecipe?.analysisMode;
  return render(
    <ResultPanel
      catalog={statsCatalog()}
      committedRecipe={committedRecipe}
      committedResult={committedResult}
      recipeChanged={recipeChanged}
      onExport={onExport}
      exportState={exportState}
      actionsLocked={actionsLocked}
      exportUnsupported={exportUnsupported ?? (mode === 'bivariate' || mode === 'correlation_matrix')}
    />,
  );
}

function snapshot(container: Element) {
  return { dom: serializeDom(container), form: formState(container) };
}

function clickTab(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('ResultPanel 특성화 — 입력 모양', () => {
  it('픽스처는 계약 스키마를 그대로 통과한다(parse 결과가 입력과 같다)', () => {
    expect(CatalogResponseSchema.parse(statsCatalog())).toEqual(statsCatalog());
    for (const c of resultCases()) {
      expect(AnalyzeResponseSchema.parse(c.response), c.name).toEqual(c.response);
      expect(StatsAnalysisRecipeSchema.parse(c.recipe), c.name).toEqual(c.recipe);
    }
  });
});

describe('ResultPanel 특성화 — 결과 종류별 탭 화면', () => {
  it('사례마다 다섯 탭의 DOM과 분포 탭의 데이터 보기를 얼린다', async () => {
    const out: Record<string, Record<string, ReturnType<typeof snapshot>>> = {};
    for (const c of resultCases()) {
      const { container, unmount } = renderPanel({ committedResult: c.response, committedRecipe: c.recipe });
      const tabs: Record<string, ReturnType<typeof snapshot>> = {};
      for (const tab of TABS) {
        clickTab(tab);
        tabs[tab] = snapshot(container);
        if (tab === '분포') {
          const toggles = screen.queryAllByRole('button', { name: '데이터 보기' });
          if (toggles.length > 0) {
            toggles.forEach((b) => fireEvent.click(b));
            tabs['분포+데이터 보기'] = snapshot(container);
          }
        }
      }
      out[c.name] = tabs;
      unmount();
    }
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/result-panel-tabs.json');
  });
});

describe('ResultPanel 특성화 — 패널 상태', () => {
  it('결과 없음·조건 변경·내보내기 중·실패·잠금·지원 안 함과 내보내기 클릭', async () => {
    const [descriptive] = resultCases();
    const matrix = resultCases().find((c) => c.recipe.analysisMode === 'correlation_matrix') as ResultCase;
    const regression = resultCases().find((c) => c.recipe.analysisMode === 'regression') as ResultCase;
    const exportError = Object.assign(new Error('서버 오류'), { status: 500, data: { code: 'INTERNAL' } });
    const out: Record<string, unknown> = {};
    const states: Array<[string, PanelProps]> = [
      ['결과 없음', { committedResult: null, committedRecipe: null }],
      ['결과 없음 + 내보내기 실패 상태', { committedResult: null, committedRecipe: null, exportState: { status: 'error', error: exportError } }],
      ['조건 변경됨', { committedResult: descriptive.response, committedRecipe: descriptive.recipe, recipeChanged: true }],
      ['내보내는 중', { committedResult: descriptive.response, committedRecipe: descriptive.recipe, exportState: { status: 'exporting', error: null } }],
      ['내보내기 실패', { committedResult: descriptive.response, committedRecipe: descriptive.recipe, exportState: { status: 'error', error: exportError } }],
      ['기능 잠금', { committedResult: descriptive.response, committedRecipe: descriptive.recipe, actionsLocked: true }],
      ['회귀 — 내보내기 지원', { committedResult: regression.response, committedRecipe: regression.recipe }],
      ['상관행렬 — 내보내기 지원 안 함', { committedResult: matrix.response, committedRecipe: matrix.recipe }],
    ];
    for (const [name, props] of states) {
      const { container, unmount } = renderPanel(props);
      out[name] = snapshot(container);
      unmount();
    }
    const onExport = vi.fn();
    const { unmount } = renderPanel({ committedResult: descriptive.response, committedRecipe: descriptive.recipe, onExport });
    fireEvent.click(screen.getByRole('button', { name: '집계 결과 내보내기 (CSV)' }));
    out['내보내기 클릭 — onExport 호출 수'] = onExport.mock.calls.length;
    unmount();
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/result-panel-states.json');
  });
});

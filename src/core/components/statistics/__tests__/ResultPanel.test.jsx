// @vitest-environment jsdom
// [코드리뷰 2026-09-12 2차] 이변량 결과 카드 표시 회귀 테스트 — 그때까지 자동
// 테스트가 없던 두 가지: (1) η²/ε²(anova/kruskal_wallis)에는 방향성 있는
// "앞(기준)/뒤(비교)"·"평균차 방향" 설명이 붙으면 안 되고, welch_t/mann_whitney
// (부호 있는 효과크기)에만 붙어야 한다. (2) 결과 카드만 보고도 그룹/결과변수,
// 분할표 행/열이 어떤 변수인지 committedRecipe+catalog로 식별할 수 있어야 한다.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResultPanel } from '../ResultPanel.jsx';

afterEach(cleanup);

function catalogFixture() {
  return {
    variables: [
      { key: 'grp', label: '작업군', type: 'boolean' },
      { key: 'val', label: '신체부담기여도(최대)', type: 'continuous' },
      { key: 'grade', label: '부담작업등급', type: 'ordinal' },
      { key: 'rowVar', label: '진단명', type: 'boolean' },
      { key: 'colVar', label: '노출 초과 여부', type: 'boolean' },
    ],
  };
}

function baseRunManifest() {
  return {
    analysisRunId: 'run-1', snapshotAsOf: '2024-01-01T00:00:00.000Z',
    catalogVersion: 'cv1', engineVersion: 'e2',
  };
}

async function openAssociationTab(user) {
  await user.click(screen.getByRole('button', { name: '연관성' }));
}

describe('ResultPanel — 이변량 결과 카드 방향성 표시(η²/ε² vs 부호 있는 효과크기)', () => {
  it('welch_t(2그룹, 부호 있는 효과크기)는 역할·방향 설명을 보여준다', async () => {
    const user = userEvent.setup();
    const committedRecipe = { analysisMode: 'bivariate', variableKeys: ['grp', 'val'], requestedMethod: 'welch_t' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        bivariate: {
          method: 'welch_t', suppressed: false, n: 60, statistic: 2.1, df: 58, pValue: 0.04,
          effectSizes: [{ name: 'mean_difference', value: 1.5, ci: [0.1, 2.9], ciUnavailableReason: null }],
          qualityFlags: [], excludedCaseCount: 0, exclusions: [],
          groupBreakdown: [{ label: false, n: 30 }, { label: true, n: 30 }],
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    await openAssociationTab(user);

    expect(screen.getByText('역할')).toBeTruthy();
    expect(screen.getByText('앞(기준)')).toBeTruthy();
    expect(screen.getByText('뒤(비교)')).toBeTruthy();
    expect(screen.getByText(/평균차·효과크기 방향 = true − false/)).toBeTruthy();
  });

  it('anova(3그룹, η²)는 역할·방향 설명 없이 그룹명·n만 보여준다', async () => {
    const user = userEvent.setup();
    const committedRecipe = { analysisMode: 'bivariate', variableKeys: ['grade', 'val'], requestedMethod: 'anova' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        bivariate: {
          method: 'anova', suppressed: false, n: 90, statistic: 5.4, df: { numerator: 2, denominator: 40.2 }, pValue: 0.01,
          effectSizes: [{ name: 'eta_squared', value: 0.3, ci: null, ciUnavailableReason: 'not_supported_v1' }],
          qualityFlags: [], excludedCaseCount: 0, exclusions: [],
          groupBreakdown: [{ label: '경도', n: 30 }, { label: '중등도', n: 30 }, { label: '고도', n: 30 }],
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    await openAssociationTab(user);

    expect(screen.queryByText('역할')).toBeNull();
    expect(screen.queryByText('앞(기준)')).toBeNull();
    expect(screen.queryByText(/평균차·효과크기 방향/)).toBeNull();
    expect(screen.getByText('경도')).toBeTruthy();
    expect(screen.getByText('중등도')).toBeTruthy();
    expect(screen.getByText('고도')).toBeTruthy();
  });

  it('mann_whitney(2그룹, rank_biserial)도 역할·방향 설명을 보여준다', async () => {
    const user = userEvent.setup();
    const committedRecipe = { analysisMode: 'bivariate', variableKeys: ['grp', 'val'], requestedMethod: 'mann_whitney' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        bivariate: {
          method: 'mann_whitney', suppressed: false, n: 60, statistic: 500, df: null, pValue: 0.02,
          effectSizes: [{ name: 'rank_biserial', value: 0.4, ci: null, ciUnavailableReason: 'not_supported_v1' }],
          qualityFlags: [], excludedCaseCount: 0, exclusions: [],
          groupBreakdown: [{ label: false, n: 30 }, { label: true, n: 30 }],
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    await openAssociationTab(user);

    expect(screen.getByText('역할')).toBeTruthy();
    expect(screen.getByText(/평균차·효과크기 방향 = true − false/)).toBeTruthy();
  });

  it('kruskal_wallis(ε²)도 역할·방향 설명이 없다', async () => {
    const user = userEvent.setup();
    const committedRecipe = { analysisMode: 'bivariate', variableKeys: ['grade', 'val'], requestedMethod: 'kruskal_wallis' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        bivariate: {
          method: 'kruskal_wallis', suppressed: false, n: 90, statistic: 7.2, df: null, pValue: 0.03,
          effectSizes: [{ name: 'epsilon_squared', value: 0.2, ci: null, ciUnavailableReason: 'not_supported_v1' }],
          qualityFlags: [], excludedCaseCount: 0, exclusions: [],
          groupBreakdown: [{ label: '경도', n: 30 }, { label: '중등도', n: 30 }],
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    await openAssociationTab(user);

    expect(screen.queryByText('역할')).toBeNull();
    expect(screen.queryByText(/평균차·효과크기 방향/)).toBeNull();
  });
});

describe('ResultPanel — 이변량 결과 카드 변수 식별(committedRecipe+catalog)', () => {
  it('그룹 비교 카드는 결과변수·그룹변수 실제 라벨을 보여준다(선택 순서와 무관 — 타입으로 역할 판정)', async () => {
    const user = userEvent.setup();
    // variableKeys[0]='val'(continuous)이 먼저 와도(선택 순서), 그룹은 타입으로
    // 판정되므로 grp가 그룹변수여야 한다 — RecipePanel의 선택 순서 의존 없음 확인.
    const committedRecipe = { analysisMode: 'bivariate', variableKeys: ['val', 'grp'], requestedMethod: 'welch_t' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        bivariate: {
          method: 'welch_t', suppressed: false, n: 60, statistic: 2.1, df: 58, pValue: 0.04,
          effectSizes: [{ name: 'mean_difference', value: 1.5, ci: [0.1, 2.9], ciUnavailableReason: null }],
          qualityFlags: [], excludedCaseCount: 0, exclusions: [],
          groupBreakdown: [{ label: false, n: 30 }, { label: true, n: 30 }],
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    await openAssociationTab(user);

    expect(screen.getByText(/결과변수: 신체부담기여도\(최대\)/)).toBeTruthy();
    expect(screen.getByText(/그룹변수: 작업군/)).toBeTruthy();
  });

  it('분할표 카드는 x=행/y=열 실제 변수 라벨을 헤더에 보여준다(같은 범주명이어도 구분 가능)', async () => {
    const user = userEvent.setup();
    const committedRecipe = { analysisMode: 'bivariate', variableKeys: ['rowVar', 'colVar'], requestedMethod: 'chi_square' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        bivariate: {
          method: 'chi_square', suppressed: false, n: 100, statistic: 4.2, df: 1, pValue: 0.04,
          effectSizes: [], qualityFlags: [], excludedCaseCount: 0, exclusions: [],
          extra: { cramersV: { name: 'cramers_v', value: 0.2, ci: null, ciUnavailableReason: 'not_supported_v1' } },
          contingencyTable: {
            rowLabels: [false, true], colLabels: [false, true],
            cells: [[20, 30], [15, 35]],
          },
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    await openAssociationTab(user);

    expect(screen.getByText(/행: 진단명/)).toBeTruthy();
    expect(screen.getByText(/열: 노출 초과 여부/)).toBeTruthy();
    expect(screen.getByText('진단명 (행)')).toBeTruthy();
    expect(screen.getByText('노출 초과 여부 (열)')).toBeTruthy();
  });

  it('억제된(suppressed) 이변량 결과에는 변수 식별·방향 텍스트가 전혀 없다', async () => {
    const user = userEvent.setup();
    const committedRecipe = { analysisMode: 'bivariate', variableKeys: ['grp', 'val'], requestedMethod: 'welch_t' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: { bivariate: { method: 'welch_t', suppressed: true } },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    await openAssociationTab(user);

    expect(screen.getByText(/공개 정책에 따라 결과가 표시되지 않음/)).toBeTruthy();
    expect(screen.queryByText(/그룹변수/)).toBeNull();
    expect(screen.queryByText(/작업군/)).toBeNull();
  });
});

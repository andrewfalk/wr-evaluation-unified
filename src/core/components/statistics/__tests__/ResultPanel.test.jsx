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
    // PR3-B — 그룹별 박스플롯 캡션이 표 셀과 별개로 그룹명을 한 번 더 보여준다
    // (계획서 §5) — 그래서 각 그룹명이 최소 1곳(표) 이상 존재하는지만 확인한다.
    expect(screen.getAllByText('경도').length).toBeGreaterThan(0);
    expect(screen.getAllByText('중등도').length).toBeGreaterThan(0);
    expect(screen.getAllByText('고도').length).toBeGreaterThan(0);
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

describe('ResultPanel — PR3-B 상관행렬 결과 카드', () => {
  it('연관성 탭에 히트맵과 변수 라벨이 표시된다', async () => {
    const user = userEvent.setup();
    const committedRecipe = {
      analysisMode: 'correlation_matrix',
      variableKeys: ['val', 'grade'],
      requestedMethod: 'pearson_correlation',
    };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        correlationMatrix: {
          method: 'pearson_correlation',
          variableKeys: ['val', 'grade'],
          cells: [{ suppressed: false, xKey: 'val', yKey: 'grade', n: 50, r: 0.4, pValue: 0.01, adjustedP: 0.02 }],
          adjustedPWithheld: false,
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    await openAssociationTab(user);

    expect(screen.getByText(/상관행렬 — Pearson 상관/)).toBeTruthy();
    // 변수 라벨은 부제(subtitle)와 히트맵 축 라벨 양쪽에 나온다.
    expect(screen.getAllByText(/신체부담기여도\(최대\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/부담작업등급/).length).toBeGreaterThan(0);
  });

  it('adjustedPWithheld면 보정값 비공개 안내 문구를 보여준다', async () => {
    const user = userEvent.setup();
    const committedRecipe = { analysisMode: 'correlation_matrix', variableKeys: ['val', 'grade', 'grp'], requestedMethod: 'pearson_correlation' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        correlationMatrix: {
          method: 'pearson_correlation',
          variableKeys: ['val', 'grade', 'grp'],
          cells: [
            { suppressed: false, xKey: 'val', yKey: 'grade', n: 50, r: 0.4, pValue: 0.01, adjustedP: null },
            { suppressed: true, xKey: 'val', yKey: 'grp' },
            { suppressed: true, xKey: 'grade', yKey: 'grp' },
          ],
          adjustedPWithheld: true,
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    await openAssociationTab(user);

    expect(screen.getByText(/다중검정 보정값\(BH-FDR\)은 행렬 전체에서 비공개 처리됩니다/)).toBeTruthy();
  });

  it('상관행렬 결과는 CSV 내보내기 버튼 대신 안내 문구를 보여준다', () => {
    const committedRecipe = { analysisMode: 'correlation_matrix', variableKeys: ['val', 'grade', 'grp'], requestedMethod: 'pearson_correlation' };
    const committedResult = {
      runManifest: baseRunManifest(),
      result: { correlationMatrix: { method: 'pearson_correlation', variableKeys: ['val', 'grade', 'grp'], cells: [], adjustedPWithheld: false } },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={committedRecipe} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    expect(screen.getByText(/상관행렬 결과는 아직 CSV 내보내기를 지원하지 않습니다/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /집계 결과 내보내기/ })).toBeNull();
  });
});

// PR4-A1 §5 — 회귀 결과 카드. estimation 4상태(suppressed 포함)가 각각 다르게
// 그려지는지, isDescriptiveRun/isRegressionRun 판정이 요약·분포 탭을 깨지 않는지
// (계획서 §5 "실제 버그 위험 지점"), 추론 보류 시 계수는 보이고 p·CI 자리만
// 비는지(se는 남는다는 계약 불변식을 화면에서도 확인).
describe('ResultPanel — PR4-A1 회귀 결과 카드', () => {
  function regressionRecipe(overrides = {}) {
    return { analysisMode: 'regression', variableKeys: ['val', 'grp'], regression: { outcomeKey: 'val' }, requestedMethod: 'ols_linear', ...overrides };
  }
  async function openRegressionTab(user) {
    await user.click(screen.getByRole('button', { name: '회귀' }));
  }

  it('estimation:"ok"이면 계수표에 계수·SE·p값·CI가 전부 표시된다', async () => {
    const user = userEvent.setup();
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        regression: {
          suppressed: false, estimation: 'ok', method: 'ols_linear', outcomeKey: 'val', eventLevel: null,
          referenceLevelsUsed: {}, covariance: 'hc3', inferenceDistribution: 't', inferenceDf: 38,
          residualDf: 38, n: 40, personCount: 40, clusterCount: null, maxClusterShare: null,
          terms: [
            { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: 1.0, se: 0.2, statistic: 5, pValue: 0.0001, ciLower: 0.6, ciUpper: 1.4, exponentiated: null },
            { name: 'grp', label: '작업군', variableKey: 'grp', level: null, estimate: 1.5, se: 0.3, statistic: 5, pValue: 0.001, ciLower: 0.9, ciUpper: 2.1, exponentiated: null },
          ],
          fit: { r2: 0.4, adjR2: 0.38, logLik: null, aic: null, pseudoR2: null },
          nonEstimableReason: null, inferenceWithheldReason: null, excludedRowCount: 0, qualityFlags: [],
          analysisUnitNote: '행 단위 해석 주의',
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={regressionRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    await openRegressionTab(user);

    expect(screen.getByText('선형회귀(OLS)')).toBeTruthy();
    expect(screen.getByText('0.0010')).toBeTruthy(); // p값
    expect(screen.getByText('행 단위 해석 주의')).toBeTruthy();
  });

  it('estimation:"inference_withheld"이면 계수·SE는 보이고 p·CI 자리는 비공개로 표시된다', async () => {
    const user = userEvent.setup();
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        regression: {
          suppressed: false, estimation: 'inference_withheld', method: 'ols_linear', outcomeKey: 'val', eventLevel: null,
          referenceLevelsUsed: {}, covariance: 'person_cluster_cr1', inferenceDistribution: null, inferenceDf: null,
          residualDf: 78, n: 80, personCount: 15, clusterCount: 15, maxClusterShare: 0.1,
          terms: [
            { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: 1.0, se: 0.2, statistic: null, pValue: null, ciLower: null, ciUpper: null, exponentiated: null },
            { name: 'grp', label: '작업군', variableKey: 'grp', level: null, estimate: 1.5, se: 0.35, statistic: null, pValue: null, ciLower: null, ciUpper: null, exponentiated: null },
          ],
          fit: { r2: 0.3, adjR2: 0.25, logLik: null, aic: null, pseudoR2: null },
          nonEstimableReason: null, inferenceWithheldReason: 'TOO_FEW_CLUSTERS', excludedRowCount: 2, qualityFlags: [],
          analysisUnitNote: '행 단위 해석 주의',
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={regressionRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    await openRegressionTab(user);

    expect(screen.getByText(/표본 구조상.*p값·신뢰구간을 표시하지 않습니다/)).toBeTruthy();
    // 계수(0.35)는 보이지만 p·CI 열은 "(비공개)"/"—"로 채워진다.
    expect(screen.getByText('0.350')).toBeTruthy(); // se
    expect(screen.getAllByText('(비공개)').length).toBeGreaterThan(0);
  });

  it('estimation:"non_estimable"이면 계수표 없이 사유 문구만 보여준다', async () => {
    const user = userEvent.setup();
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        regression: {
          suppressed: false, estimation: 'non_estimable', method: 'binary_logistic', outcomeKey: 'grp', eventLevel: null,
          referenceLevelsUsed: {}, covariance: 'hc3', inferenceDistribution: null, inferenceDf: null,
          residualDf: 0, n: 0, personCount: 0, clusterCount: null, maxClusterShare: null,
          terms: [], fit: null, nonEstimableReason: 'SEPARATION_DETECTED', inferenceWithheldReason: null,
          excludedRowCount: 0, qualityFlags: [], analysisUnitNote: '',
        },
      },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={regressionRecipe({ analysisMode: 'regression', variableKeys: ['grp', 'val'], regression: { outcomeKey: 'grp' } })} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    await openRegressionTab(user);

    expect(screen.getByText('결과변수가 설명변수로 완전히 구분돼 계산할 수 없습니다.')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  it('suppressed:true이면 공개통제 억제 문구를 보여준다', async () => {
    const user = userEvent.setup();
    const committedResult = {
      runManifest: baseRunManifest(),
      result: { regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' } },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={regressionRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    await openRegressionTab(user);
    expect(screen.getByText(/공개 정책에 따라 결과가 표시되지 않음/)).toBeTruthy();
  });

  it('회귀 실행 결과에서는 요약/분포 탭이 continuous/discrete를 읽지 않고 안내 문구만 보여준다(isDescriptiveRun 오판 방지)', () => {
    const committedResult = {
      runManifest: baseRunManifest(),
      result: { regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' } },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={regressionRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    // 기본 탭은 "요약" — descriptive 전용 라벨("연속형"/"이산형")이 아니라 회귀 안내가 떠야 한다.
    expect(screen.getByText('회귀 분석 결과는 "회귀" 탭에서 확인하세요.')).toBeTruthy();
    expect(screen.queryByText('연속형')).toBeNull();
    expect(screen.queryByText('이산형')).toBeNull();
  });

  it('회귀 결과는 CSV 내보내기 버튼 대신 안내 문구를 보여준다', () => {
    const committedResult = {
      runManifest: baseRunManifest(),
      result: { regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' } },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={regressionRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported
      />,
    );
    expect(screen.getByText(/회귀 결과는 아직 CSV 내보내기를 지원하지 않습니다/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /집계 결과 내보내기/ })).toBeNull();
  });
});

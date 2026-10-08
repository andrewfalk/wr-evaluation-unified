// @vitest-environment jsdom
// [코드리뷰 2026-09-12 2차] 이변량 결과 카드 표시 회귀 테스트 — 그때까지 자동
// 테스트가 없던 두 가지: (1) η²/ε²(anova/kruskal_wallis)에는 방향성 있는
// "앞(기준)/뒤(비교)"·"평균차 방향" 설명이 붙으면 안 되고, welch_t/mann_whitney
// (부호 있는 효과크기)에만 붙어야 한다. (2) 결과 카드만 보고도 그룹/결과변수,
// 분할표 행/열이 어떤 변수인지 committedRecipe+catalog로 식별할 수 있어야 한다.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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

// 범주형 소수 범주 "기타" 병합 — 요약·분포 탭이 other/rawLevels를 어떻게 보여주는지.
describe('ResultPanel — 범주형 "기타" 병합·권한자 원본(rawLevels)', () => {
  const jobCatalog = {
    variables: [
      { key: 'job', label: '대표 직종명', type: 'high_cardinality' },
      { key: 'grade', label: '부담작업등급', type: 'ordinal' },
      { key: 'len', label: '근속기간', type: 'continuous' },
    ],
  };
  const lv = (level, count, total = 76) => ({ level, count, proportion: count / total });
  const publicRow = {
    variableKey: 'job', kind: 'discrete', suppressed: false, n: 76, missingCount: 0, missingPatterns: [],
    levels: [lv('용접공', 40), lv('목수', 20)], other: { count: 16, proportion: 16 / 76 }, mode: '용접공',
  };

  function renderPanel(row, { recipe = { analysisMode: 'descriptive', variableKeys: ['job'] }, catalog = jobCatalog } = {}) {
    render(
      <ResultPanel
        catalog={catalog} committedRecipe={recipe}
        committedResult={{ runManifest: baseRunManifest(), result: { continuous: [], discrete: [row] } }}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
  }

  it('요약 탭: other가 있으면 표에 "기타 (공개 기준에 따라 병합한 범주 합계)" 줄과 안내 문구가 뜬다', () => {
    renderPanel(publicRow);
    expect(screen.getByText('기타 (공개 기준에 따라 병합한 범주 합계)')).toBeTruthy();
    expect(screen.getByText("인원이 10명 미만인 범주와, 합친 값을 10명 이상으로 맞추려고 함께 합친 범주는 '기타'로 묶어 표시했습니다.")).toBeTruthy();
    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows.reduce((s, tr) => s + Number(tr.children[1].textContent), 0)).toBe(76);
  });

  it('분포 탭: 차트에 합계 막대(점선)가 그려지고 "데이터 보기" 표에는 기타 줄이 있다', async () => {
    const user = userEvent.setup();
    renderPanel(publicRow);
    await user.click(screen.getByRole('button', { name: '분포' }));
    expect(document.querySelectorAll('rect.chart-bar-merged')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getAllByText('기타 (공개 기준에 따라 병합한 범주 합계)').length).toBeGreaterThan(0);
  });

  it('rawLevels가 있으면 원본을 표시하고(중복 집계 없이 합 = n) 권한 안내가 뜨며 기타 안내는 없다', () => {
    const raw = [lv('용접공', 40), lv('목수', 20), lv('간호사', 12), lv('잠수부', 1), lv('조종사', 3)];
    renderPanel({ ...publicRow, rawLevels: raw });
    expect(screen.getByText('잠수부')).toBeTruthy();
    expect(screen.getByText('제한 데이터 권한으로 소수 인원 범주까지 표시합니다. 화면을 외부에 공유할 때 주의하세요.')).toBeTruthy();
    expect(screen.queryByText(/합쳐 표시했습니다/)).toBeFalsy();
    expect(screen.queryByText('기타 (공개 기준에 따라 병합한 범주 합계)')).toBeFalsy();
    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows.reduce((s, tr) => s + Number(tr.children[1].textContent), 0)).toBe(76);
  });

  it('원본 표시 시 최빈값도 원본 기준이다 — 반복 기록으로 소수 범주가 가장 큰 경우 공개 row.mode(A)가 아니라 D', () => {
    // D는 고유 5명이지만 100건, A는 40건. 공개 결과는 D를 "기타"에 합쳤으므로 row.mode는 A다.
    const raw = [lv('A', 40, 160), lv('B', 12, 160), lv('D', 100, 160), lv('E', 8, 160)];
    renderPanel({
      ...publicRow, n: 160, levels: [lv('A', 40, 160), lv('B', 12, 160)], other: { count: 108, proportion: 108 / 160 },
      mode: 'A', rawLevels: raw,
    });
    expect(screen.getByText(/최빈값=D/)).toBeTruthy();
    expect(screen.queryByText(/최빈값=A/)).toBeFalsy();
  });

  it('원본이 아니면 최빈값은 서버가 준 공개 row.mode 그대로다', () => {
    renderPanel(publicRow);
    expect(screen.getByText(/최빈값=용접공/)).toBeTruthy();
  });

  it('"기타" 안내가 10명 미만 범주만이 아니라 함께 합친 범주도 포함될 수 있음을 밝힌다(리뷰 지적: 1+3명에 12명을 끌어와 16명)', () => {
    renderPanel(publicRow);
    const note = screen.getByText(/함께 합친 범주는 '기타'로 묶어 표시했습니다/);
    expect(note.textContent).toContain('10명 미만인 범주와');
    expect(screen.queryByText(/10명 미만 범주 합계/)).toBeFalsy();
  });

  it('억제된 변수도 rawLevels가 있으면 원본을 보여준다(공개 정책 문구 대신)', () => {
    renderPanel({ variableKey: 'job', kind: 'discrete', suppressed: true, rawLevels: [lv('용접공', 40), lv('잠수부', 1)] });
    expect(screen.queryByText('공개 정책에 따라 표시되지 않음')).toBeFalsy();
    expect(screen.getByText('잠수부')).toBeTruthy();
    expect(screen.getByText(/n=41/)).toBeTruthy();
  });

  it('변수가 2개 이상인 실행에서 범주형이 억제되면 단독 분석 안내가 뜬다', () => {
    renderPanel(
      { variableKey: 'job', kind: 'discrete', suppressed: true },
      { recipe: { analysisMode: 'descriptive', variableKeys: ['job', 'len'] } },
    );
    expect(screen.getByText('공개 정책에 따라 표시되지 않음')).toBeTruthy();
    expect(screen.getByText(/범주형 변수 하나만 분석하면 소수 범주를 '기타'로 합쳐 볼 수 있는 경우가 있습니다/)).toBeTruthy();
  });

  it('변수가 1개이거나 순서형이면 단독 분석 안내가 없다', () => {
    renderPanel({ variableKey: 'job', kind: 'discrete', suppressed: true });
    expect(screen.queryByText(/하나만 분석하면/)).toBeFalsy();
    cleanup();
    renderPanel(
      { variableKey: 'grade', kind: 'discrete', suppressed: true },
      { recipe: { analysisMode: 'descriptive', variableKeys: ['grade', 'len'] } },
    );
    expect(screen.queryByText(/하나만 분석하면/)).toBeFalsy();
  });

  it('구버전 결과(other·rawLevels 없음)는 기존과 똑같이 렌더된다', () => {
    const { other, ...legacy } = publicRow;
    renderPanel({ ...legacy, levels: [lv('용접공', 40, 60), lv('목수', 20, 60)], n: 60 });
    expect(screen.queryByText(/기타/)).toBeFalsy();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});

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

  it('범주형 항은 "변수: 수준"을 한 번만 표시하고, VIF 표는 내부 키 대신 라벨을 쓰며, 숫자는 유효숫자로 정리된다', async () => {
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
            { name: 'grp:male', label: '작업군: male', variableKey: 'grp', level: 'male', estimate: -0.09309751621743677, se: 0.3, statistic: 5, pValue: 1.4422231634147625e-20, ciLower: 0.9, ciUpper: 2.1, exponentiated: null },
          ],
          fit: { r2: 0.4, adjR2: 0.38, logLik: null, aic: null, pseudoR2: null },
          nonEstimableReason: null, inferenceWithheldReason: null, excludedRowCount: 0, qualityFlags: [],
          analysisUnitNote: '행 단위 해석 주의',
          diagnostics: {
            conditionNumber: 12.3, vif: [{ termName: 'val', vif: 1.5 }, { termName: 'grp:male', vif: 2.5 }],
            pointDiagnosticsStatus: 'unsupported', pointDiagnosticsUnsupportedReason: null,
            pointDiagnostics: [], displayedPointCount: 0, totalPointCount: 0,
          },
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

    expect(screen.getAllByText('작업군: male').length).toBeGreaterThan(0);
    expect(screen.queryByText(/male: male/)).toBeNull();
    // 16자리 원값 대신 유효숫자 4자리, p는 <0.0001.
    expect(screen.getByText('-0.09310')).toBeTruthy();
    expect(screen.getAllByText('<0.0001').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\d\.\d{8,}/);
    // VIF 표: 항 이름(grp:male) 대신 라벨, 연속형은 카탈로그 라벨.
    const vif = within(screen.getByRole('table', { name: 'VIF' }));
    expect(vif.queryByText('grp:male')).toBeNull();
    expect(vif.getByText('작업군: male')).toBeTruthy();
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
    expect(screen.getByText('0.3500')).toBeTruthy(); // se
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

  it('PR4-A2 — 회귀 결과도 집계 CSV 내보내기 버튼을 보여준다(exportUnsupported=false)', () => {
    const committedResult = {
      runManifest: baseRunManifest(),
      result: { regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' } },
    };
    render(
      <ResultPanel
        catalog={catalogFixture()} committedRecipe={regressionRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    expect(screen.getByRole('button', { name: /집계 결과 내보내기/ })).toBeTruthy();
    expect(screen.queryByText(/회귀 결과는 아직 CSV 내보내기를 지원하지 않습니다/)).toBeNull();
  });
});

// Table1 스트라티피케이션 — 화면 회귀 버그 2건(외부 리뷰 지적) 고정.
describe('ResultPanel — Table1 그룹별 비교(descriptiveStratified) 렌더링 버그 수정', () => {
  function stratifyCatalog() {
    return { variables: [{ key: 'sex', label: '성별', type: 'categorical' }] };
  }
  function stratifyRecipe() {
    return { analysisMode: 'descriptive', variableKeys: ['sex'], descriptive: { stratifyByKey: 'case.staff.assignedDoctorUserId' } };
  }

  it('total이 강제 억제돼도, 서로 다른 그룹에만 있는 레벨(M/F)이 모두 표에 나타난다(합집합 버그 수정)', () => {
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        continuous: [], discrete: [],
        descriptiveStratified: {
          suppressed: false,
          stratifyByKey: 'case.staff.assignedDoctorUserId',
          groups: [
            { groupId: 'total', kind: 'total', level: null },
            { groupId: 'g0', kind: 'level', level: '김민준' },
            { groupId: 'g1', kind: 'level', level: '이서연' },
          ],
          byGroup: [
            // total은 g0/g1 중 하나가 억제된 게 아니라도 이 시나리오에서 강제
            // 억제됐다고 가정(서버 §4 규칙) — 첫 번째로 순회되는 그룹이 억제
            // 상태일 때 옛 코드가 그 뒤 그룹들의 레벨을 아예 못 봤다.
            { groupId: 'total', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: true }] },
            { groupId: 'g0', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 15, missingCount: 0, levels: [{ level: 'M', count: 15, proportion: 1 }], mode: 'M' }] },
            { groupId: 'g1', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 15, missingCount: 0, levels: [{ level: 'F', count: 15, proportion: 1 }], mode: 'F' }] },
          ],
        },
      },
    };
    render(
      <ResultPanel
        catalog={stratifyCatalog()} committedRecipe={stratifyRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    expect(screen.getByText('성별: M')).toBeTruthy();
    expect(screen.getByText('성별: F')).toBeTruthy(); // 버그였다면 이 행 자체가 없었다
  });

  it('그룹 안에서 변수가 전부 결측(n=0)이면, 다른 그룹의 레벨과 만나도 "0 (0.0%)"가 아니라 "—"를 보여준다', () => {
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        continuous: [], discrete: [],
        descriptiveStratified: {
          suppressed: false,
          stratifyByKey: 'case.staff.assignedDoctorUserId',
          groups: [
            { groupId: 'total', kind: 'total', level: null },
            { groupId: 'g0', kind: 'level', level: '김민준' },
            { groupId: 'g1', kind: 'level', level: '이서연' },
          ],
          byGroup: [
            { groupId: 'total', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 15, missingCount: 0, levels: [{ level: 'M', count: 15, proportion: 1 }], mode: 'M' }] },
            // g0은 이 변수가 전부 결측(계산 불가) — levels가 비어있고 n=0.
            { groupId: 'g0', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 0, missingCount: 15, levels: [], mode: null }] },
            { groupId: 'g1', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 15, missingCount: 0, levels: [{ level: 'M', count: 15, proportion: 1 }], mode: 'M' }] },
          ],
        },
      },
    };
    render(
      <ResultPanel
        catalog={stratifyCatalog()} committedRecipe={stratifyRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    const row = screen.getByText('성별: M').closest('tr');
    const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);
    // 열 순서: 전체, 김민준(g0, 계산 불가), 이서연(g1, M 15명 100%)
    expect(cells[1]).toBe('—'); // g0 — 계산 불가, "0 (0.0%)"이면 버그
    expect(cells[2]).toContain('15');
  });

  it('표시명이 겹치는 그룹(담당의 표시명 조회 실패로 전부 "(알 수 없음)")은 열 제목에 순번이 붙는다', () => {
    // 3차 리뷰 지적 — groupId/CSV엔 구분값이 있어도 화면 열 제목이 전부 같으면
    // 사용자가 서로 다른 그룹임을 구분할 수 없다. UUID는 여전히 노출하지 않는다.
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        continuous: [], discrete: [],
        descriptiveStratified: {
          suppressed: false,
          stratifyByKey: 'case.staff.assignedDoctorUserId',
          groups: [
            { groupId: 'total', kind: 'total', level: null },
            { groupId: 'g0', kind: 'level', level: '(알 수 없음)' },
            { groupId: 'g1', kind: 'level', level: '(알 수 없음)' },
          ],
          byGroup: [
            { groupId: 'total', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 30, missingCount: 0, levels: [{ level: 'M', count: 30, proportion: 1 }], mode: 'M' }] },
            { groupId: 'g0', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 15, missingCount: 0, levels: [{ level: 'M', count: 15, proportion: 1 }], mode: 'M' }] },
            { groupId: 'g1', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 15, missingCount: 0, levels: [{ level: 'M', count: 15, proportion: 1 }], mode: 'M' }] },
          ],
        },
      },
    };
    render(
      <ResultPanel
        catalog={stratifyCatalog()} committedRecipe={stratifyRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    const headers = Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['변수', '전체', '(알 수 없음) 1', '(알 수 없음) 2']);
  });

  it('이름이 같은 담당의가 둘 이상인 정상 조회에서도 열 제목에 순번이 붙는다', () => {
    const committedResult = {
      runManifest: baseRunManifest(),
      result: {
        continuous: [], discrete: [],
        descriptiveStratified: {
          suppressed: false,
          stratifyByKey: 'case.staff.assignedDoctorUserId',
          groups: [
            { groupId: 'total', kind: 'total', level: null },
            { groupId: 'g0', kind: 'level', level: '김민준' },
            { groupId: 'g1', kind: 'level', level: '김민준' },
            { groupId: 'g2', kind: 'level', level: '이서연' },
          ],
          byGroup: [
            { groupId: 'total', continuous: [], discrete: [] },
            { groupId: 'g0', continuous: [], discrete: [] },
            { groupId: 'g1', continuous: [], discrete: [] },
            { groupId: 'g2', continuous: [], discrete: [] },
          ],
        },
      },
    };
    render(
      <ResultPanel
        catalog={stratifyCatalog()} committedRecipe={stratifyRecipe()} committedResult={committedResult}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
    const headers = Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['변수', '전체', '김민준 1', '김민준 2', '이서연']); // 유일한 "이서연"은 순번 없음
  });
});

// 제한데이터 권한자 소수 셀 해제 — 서버가 응답 시점에만 붙이는 limitedDisclosure 표시.
describe('ResultPanel — 제한데이터 소수 셀 해제 표시(limitedDisclosure)', () => {
  const catalog = { variables: [{ key: 'sex', label: '성별', type: 'categorical' }] };
  const recipe = { analysisMode: 'descriptive', variableKeys: ['sex'] };
  const row = {
    variableKey: 'sex', kind: 'discrete', suppressed: false, n: 4, missingCount: 2, missingPatterns: null,
    levels: [{ level: 'M', count: 3, proportion: 0.75 }, { level: 'F', count: 1, proportion: 0.25 }], mode: 'M',
  };

  function renderResult(result, recipeOverride = recipe) {
    render(
      <ResultPanel
        catalog={catalog} committedRecipe={recipeOverride}
        committedResult={{ runManifest: baseRunManifest(), result }}
        recipeChanged={false} onExport={() => {}} exportState={{ status: 'idle' }}
        actionsLocked={false} exportUnsupported={false}
      />,
    );
  }

  it('applied면 소수 인원 보호 해제 경고 배너가 뜨고 1~9명 범주가 그대로 보인다', () => {
    renderResult({ continuous: [], discrete: [row], limitedDisclosure: 'applied' });
    expect(screen.getByRole('status').textContent).toContain('소수 인원(10명 미만) 보호가 해제된 결과');
    expect(screen.getByText(/반출·공유/)).toBeTruthy();
    expect(screen.getByText(/n=4, 결측=2/)).toBeTruthy();
  });

  it('필드가 없으면(일반 응답) 배너가 없다', () => {
    renderResult({ continuous: [], discrete: [row] });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    ['unavailable_engine_busy', '잠시 후 다시 조회'],
    ['unavailable_computation_failed', '다시 시도'],
    ['unavailable_engine_degraded', '관리자에게 문의'],
    ['unavailable_input_too_large', '필터로 범위를 줄여'],
    ['unavailable_group_limit', '그룹 수가 많아'],
    ['unavailable_source_missing', '원본이 보존되지 않았습니다'],
    ['unavailable_version_drift', '버전이 바뀌어'],
  ])('%s는 해제하지 못했다는 사유별 안내를 보여준다(해제 경고 배너가 아니다)', (status, expected) => {
    renderResult({ continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: true }], limitedDisclosure: status });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain(expected);
    expect(banner.textContent).not.toContain('보호가 해제된 결과');
  });

  it('알 수 없는 상태 값도 일반 결과 표시 안내로 안전하게 처리한다', () => {
    renderResult({ continuous: [], discrete: [row], limitedDisclosure: 'unavailable_something_new' });
    expect(screen.getByRole('status').textContent).toContain('일반(집계) 결과를 표시합니다');
  });

  describe('Table1(담당의 층화)', () => {
    const stratRecipe = { analysisMode: 'descriptive', variableKeys: ['sex'], descriptive: { stratifyByKey: 'case.staff.assignedDoctorUserId' } };
    function stratified(limitedDisclosure) {
      return {
        continuous: [], discrete: [],
        ...(limitedDisclosure ? { limitedDisclosure } : {}),
        descriptiveStratified: {
          suppressed: false,
          stratifyByKey: 'case.staff.assignedDoctorUserId',
          groups: [
            { groupId: 'total', kind: 'total', level: null },
            { groupId: 'g0', kind: 'level', level: '김호길' },
            { groupId: 'g1', kind: 'level', level: '박완' },
          ],
          byGroup: [
            { groupId: 'total', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 15, missingCount: 3, levels: [{ level: 'M', count: 15, proportion: 1 }], mode: 'M' }] },
            { groupId: 'g0', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 12, missingCount: 3, levels: [{ level: 'M', count: 12, proportion: 1 }], mode: 'M' }] },
            { groupId: 'g1', continuous: [], discrete: [{ variableKey: 'sex', kind: 'discrete', suppressed: false, n: 3, missingCount: 0, levels: [{ level: 'M', count: 3, proportion: 1 }], mode: 'M' }] },
          ],
        },
      };
    }

    it('해제 응답: 모든 그룹이 표시되고 "그룹 하나라도 비공개면 전체도 비공개" 안내와 비공개 범례가 숨겨진다', () => {
      renderResult(stratified('applied'), stratRecipe);
      expect(screen.getByRole('columnheader', { name: '박완' })).toBeTruthy();
      expect(screen.getByText(/소수 인원 보호가 해제되어 모든 그룹/)).toBeTruthy();
      expect(screen.queryByText(/전체 값도 함께 비공개로 전환/)).toBeNull();
      expect(screen.queryByText(/공개 정책에 따라 표시되지 않음\(소수 인원 보호\)/)).toBeNull();
    });

    it('일반 응답: 기존 역산 방지 안내와 비공개 범례가 그대로 있다(회귀 방지)', () => {
      renderResult(stratified(null), stratRecipe);
      expect(screen.getByText(/전체 값도 함께 비공개로 전환/)).toBeTruthy();
      expect(screen.getByText(/공개 정책에 따라 표시되지 않음\(소수 인원 보호\)/)).toBeTruthy();
      expect(screen.queryByText(/소수 인원 보호가 해제되어 모든 그룹/)).toBeNull();
    });
  });

  it('이변량 실행에는 기술통계 해제 배너가 뜨지 않는다', () => {
    renderResult(
      { continuous: [], discrete: [], bivariate: { method: 'welch_t', suppressed: true }, limitedDisclosure: 'applied' },
      { analysisMode: 'bivariate', variableKeys: ['a', 'b'] },
    );
    expect(screen.queryByText(/소수 인원\(10명 미만\) 보호가 해제된 결과/)).toBeNull();
  });
});

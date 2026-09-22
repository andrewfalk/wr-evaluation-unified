// @vitest-environment jsdom
// PR3-B 계획서 §6.8.5 — 모든 차트에 억제 문구·"데이터 보기" 표 전환이 있는지,
// §2의 폭-0(상수) 히스토그램이 크래시 없이 렌더되는지 확인한다.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Histogram } from '../Histogram';
import { BoxPlot } from '../BoxPlot';
import { HorizontalBarChart } from '../HorizontalBarChart';
import { StackedBarChart100 } from '../StackedBarChart100';
import { ScatterPlot } from '../ScatterPlot';
import { CorrelationHeatmap } from '../CorrelationHeatmap';
import { ForestPlot } from '../ForestPlot';
import { SplinePartialEffectChart } from '../SplinePartialEffectChart';
import { ChartTooltip, chooseTooltipPlacement } from '../ChartTooltip';

afterEach(cleanup);

describe('Histogram', () => {
  it('histogram이 null이면 억제 문구를 보여준다', () => {
    render(<Histogram histogram={null} />);
    expect(screen.getByText(/공개 정책에 따라 표시되지 않음/)).toBeTruthy();
  });

  it('폭 0(상수) 단일 bin도 크래시 없이 렌더된다(계획서 §2)', () => {
    render(<Histogram histogram={{ bins: [{ lower: 5, upper: 5, count: 100 }] }} />);
    expect(document.querySelector('svg')).toBeTruthy();
  });

  it('"데이터 보기"를 누르면 표로 전환된다', async () => {
    const user = userEvent.setup();
    render(<Histogram histogram={{ bins: [{ lower: 0, upper: 10, count: 5 }] }} />);
    expect(document.querySelector('table')).toBeNull();
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(document.querySelector('table')).toBeTruthy();
  });

  // B안(A안 후속) — histogram이 null인 두 가지 이유(애초에 자료 없음 vs 재분할
  // 후보를 전부 시도해도 공개 가능한 해상도가 없음)를 서로 다른 문구로 구분한다.
  it('histogramReasonCode가 INSUFFICIENT_DISCLOSABLE_RESOLUTION이면 전용 문구를 보여준다', () => {
    render(<Histogram histogram={null} histogramReasonCode="INSUFFICIENT_DISCLOSABLE_RESOLUTION" />);
    expect(screen.getByText('분포를 표시하기에는 공개 가능한 구간이 부족합니다.')).toBeTruthy();
    expect(screen.queryByText(/표본 크기 등/)).toBeFalsy();
  });

  it('histogramReasonCode가 없으면(구버전 결과 등) 기존 기본 문구를 그대로 유지한다(회귀 방지)', () => {
    render(<Histogram histogram={null} />);
    expect(screen.getByText(/공개 정책에 따라 표시되지 않음\(표본 크기 등\)/)).toBeTruthy();
  });

  it('merged가 true면 구간 수를 줄여 표시했다는 안내가 뜬다', () => {
    render(<Histogram histogram={{ bins: [{ lower: 0, upper: 10, count: 5 }], merged: true }} />);
    expect(screen.getByText('공개 기준에 맞춰 구간 수를 줄여 표시했습니다.')).toBeTruthy();
  });

  it('merged 필드가 아예 없어도(구버전 캐시 결과) 안내 없이 크래시 없이 렌더된다', () => {
    render(<Histogram histogram={{ bins: [{ lower: 0, upper: 10, count: 5 }] }} />);
    expect(screen.queryByText(/구간 수를 줄여/)).toBeFalsy();
    expect(document.querySelector('svg')).toBeTruthy();
  });

  it('"데이터 보기" 표의 행 수는 항상 histogram.bins.length와 일치한다(그래프·표 해상도 불일치 방지)', async () => {
    const user = userEvent.setup();
    const bins = [
      { lower: 0, upper: 10, count: 5 },
      { lower: 10, upper: 20, count: 8 },
      { lower: 20, upper: 30, count: 12 },
    ];
    render(<Histogram histogram={{ bins, merged: true }} />);
    expect(document.querySelectorAll('rect').length).toBe(bins.length);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(document.querySelectorAll('tbody tr').length).toBe(bins.length);
  });
});

describe('BoxPlot', () => {
  it('boxplot이 null이면 억제 문구를 보여준다', () => {
    render(<BoxPlot boxplot={null} />);
    expect(screen.getByText(/공개 정책에 따라 표시되지 않음/)).toBeTruthy();
  });

  it('outlierCount가 없으면 표에서 "(비공개)"로 표기된다', async () => {
    const user = userEvent.setup();
    render(<BoxPlot boxplot={{ q1: 1, median: 2, q3: 3, lowerWhisker: 0, upperWhisker: 4 }} />);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getByText('(비공개)')).toBeTruthy();
  });

  it('outlierValues가 있으면 표에 그대로 노출된다', async () => {
    const user = userEvent.setup();
    render(<BoxPlot boxplot={{ q1: 1, median: 2, q3: 3, lowerWhisker: 0, upperWhisker: 4, outlierCount: 1, outlierValues: [100] }} />);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getByText(/100/)).toBeTruthy();
  });
});

describe('HorizontalBarChart', () => {
  it('levels가 비어있으면 "자료 없음"을 보여준다', () => {
    render(<HorizontalBarChart levels={[]} />);
    expect(screen.getByText('자료 없음')).toBeTruthy();
  });

  it('level별 빈도/비율이 표에 나온다', async () => {
    const user = userEvent.setup();
    render(<HorizontalBarChart levels={[{ level: 'a', count: 10, proportion: 0.5 }, { level: 'b', count: 10, proportion: 0.5 }]} />);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getAllByText('10')).toHaveLength(2);
  });
});

describe('StackedBarChart100', () => {
  it('table이 null이면 억제 문구를 보여준다(개별 칸 수치 비공개)', () => {
    render(<StackedBarChart100 table={null} />);
    expect(screen.getByText(/개별 칸\(셀\) 수치는 표시하지 않습니다/)).toBeTruthy();
  });

  it('table이 있으면 범례와 표를 보여준다', async () => {
    const user = userEvent.setup();
    render(<StackedBarChart100 table={{ rowLabels: ['r1'], colLabels: ['c1', 'c2'], cells: [[3, 7]] }} />);
    expect(screen.getByLabelText('범례')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });
});

describe('ScatterPlot', () => {
  it('scatter가 없으면 억제 문구를 보여준다', () => {
    render(<ScatterPlot scatter={null} />);
    expect(screen.getByText(/공개 정책에 따라 표시되지 않음/)).toBeTruthy();
  });

  it('points가 있으면 "표시 중 n / 전체 n"을 보여준다', () => {
    render(<ScatterPlot scatter={{ displayedCount: 50, totalCount: 100, points: [[1, 2], [3, 4]] }} />);
    expect(screen.getByText(/표시 중 50 \/ 전체 100/)).toBeTruthy();
  });

  it('points 없이 grid만 있어도 렌더된다(권한 없는 사용자 — 그리드 대체)', () => {
    render(<ScatterPlot scatter={{
      displayedCount: 100, totalCount: 100,
      grid: { xEdges: [0, 1, 2], yEdges: [0, 1, 2], cells: [{ i: 0, j: 0, count: 50 }, { i: 1, j: 1, count: 50 }] },
    }} />);
    expect(document.querySelector('svg')).toBeTruthy();
  });

  // 코드리뷰 수정 — 축에 숫자 눈금이 없어 어느 값 범위에 관측치가 몰렸는지 알 수
  // 없었다. x/y 축 눈금 라벨(chart-axis-label)이 실제로 렌더되는지 확인한다.
  it('숫자 축 눈금이 렌더된다(x/y 둘 다)', () => {
    render(<ScatterPlot scatter={{ displayedCount: 3, totalCount: 3, points: [[0, 0], [50, 100], [100, 200]] }} />);
    const labels = document.querySelectorAll('.chart-axis-label');
    expect(labels.length).toBeGreaterThan(0);
  });

  // 코드리뷰 수정 — 그리드 "데이터 보기" 표가 bin 번호(i/j)만 보여줘 실제 x/y 값
  // 구간을 알 수 없었다. 이제 xEdges/yEdges로 실제 구간을 표시해야 한다.
  it('그리드 데이터 보기 표가 bin 번호가 아니라 실제 x/y 값 구간을 보여준다', async () => {
    const user = userEvent.setup();
    render(<ScatterPlot scatter={{
      displayedCount: 100, totalCount: 100,
      grid: { xEdges: [0, 10, 20], yEdges: [100, 200, 300], cells: [{ i: 0, j: 1, count: 42 }] },
    }} />);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getByText(/0 ~ 10/)).toBeTruthy();
    expect(screen.getByText(/200 ~ 300/)).toBeTruthy();
    expect(screen.queryByText(/^0$/)).toBeFalsy(); // 순수 bin 인덱스 "0"만 단독으로는 더 이상 안 나옴
  });

  // 코드리뷰 수정 — grid만 있을 때(원시좌표 미제공)는 표본추출이 아니라 전체를
  // 요약한 것이므로 points의 "표시 중 X / 전체 Y"와 다른 문구를 써야 한다.
  it('grid만 있을 때는 표본추출 문구("표시 중")가 아니라 요약 문구를 보여준다', () => {
    render(<ScatterPlot scatter={{
      displayedCount: 100, totalCount: 100,
      grid: { xEdges: [0, 1], yEdges: [0, 1], cells: [{ i: 0, j: 0, count: 100 }] },
    }} />);
    expect(screen.queryByText(/표시 중/)).toBeFalsy();
    expect(screen.getByText(/전체 100건을 그리드로 요약 표시/)).toBeTruthy();
  });
});

describe('CorrelationHeatmap', () => {
  it('suppressed 셀은 "×"로, 공개 셀은 r값으로 표시된다', async () => {
    const user = userEvent.setup();
    const cells = [
      { suppressed: false, xKey: 'a', yKey: 'b', n: 50, r: 0.5, pValue: 0.01, adjustedP: 0.02 },
      { suppressed: true, xKey: 'a', yKey: 'c' },
      { suppressed: true, xKey: 'b', yKey: 'c' },
    ];
    render(<CorrelationHeatmap variableKeys={['a', 'b', 'c']} cells={cells} labelOf={(k) => k} />);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getByText('0.500')).toBeTruthy();
    expect(screen.getAllByText('(비공개)').length).toBeGreaterThan(0);
  });
});

// PR4-A1 §5 — forest plot. 절편 제외, CI 유무에 따른 렌더 분기, OR 로그축에서
// 비유한/음수 OR이 축을 깨지 않는지.
describe('ForestPlot', () => {
  const baseTerms = [
    { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: 1.0, se: 0.2, statistic: 5, pValue: 0.001, ciLower: 0.6, ciUpper: 1.4, exponentiated: null },
    { name: 'x1', label: 'x1 변수', variableKey: 'x1', level: null, estimate: 1.5, se: 0.3, statistic: 5, pValue: 0.001, ciLower: 0.9, ciUpper: 2.1, exponentiated: null },
    { name: 'x2', label: 'x2 변수', variableKey: 'x2', level: null, estimate: -0.8, se: 0.4, statistic: -2, pValue: 0.04, ciLower: -1.6, ciUpper: 0.0, exponentiated: null },
  ];

  it('terms가 없으면 억제 문구를 보여준다', () => {
    render(<ForestPlot terms={[]} />);
    expect(screen.getByText(/공개 정책에 따라 표시되지 않음/)).toBeTruthy();
  });

  it('절편은 그래프 행에서 제외된다(표에도 없음 — 호출자가 계수표에서 별도로 보여줌)', () => {
    render(<ForestPlot terms={baseTerms} />);
    // predictor 2개(x1, x2)만 축 라벨로 그려진다.
    expect(screen.getByText('x1 변수')).toBeTruthy();
    expect(screen.getByText('x2 변수')).toBeTruthy();
    expect(screen.queryByText('절편')).toBeFalsy();
  });

  it('"데이터 보기"를 누르면 표로 전환되고 행 수가 predictor 수(절편 제외)와 일치한다', async () => {
    const user = userEvent.setup();
    render(<ForestPlot terms={baseTerms} />);
    expect(document.querySelector('table')).toBeNull();
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    const table = document.querySelector('table');
    expect(table).toBeTruthy();
    expect(table.querySelectorAll('tbody tr').length).toBe(2); // x1, x2(절편 제외)
  });

  it('CI가 null(추론 보류)이면 점추정만 찍고 비공개 문구를 표에 낸다', async () => {
    const user = userEvent.setup();
    const withheldTerms = baseTerms.map((t) => (
      t.variableKey === null ? t : { ...t, statistic: null, pValue: null, ciLower: null, ciUpper: null }
    ));
    render(<ForestPlot terms={withheldTerms} />);
    // 점(circle)은 여전히 그려진다.
    expect(document.querySelectorAll('circle').length).toBe(2);
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getAllByText('(비공개)').length).toBe(2);
  });

  it('exponentiated=true면 OR을 로그축에 그리고, 비유한/0 이하 OR은 축·표에서 "—"로 처리한다', async () => {
    const user = userEvent.setup();
    const logisticTerms = [
      { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: 0.1, se: 0.1, statistic: 1, pValue: 0.3, ciLower: -0.1, ciUpper: 0.3, exponentiated: { estimate: 1.1, ciLower: 0.9, ciUpper: 1.3 } },
      { name: 'x1', label: 'x1 변수', variableKey: 'x1', level: null, estimate: 0.7, se: 0.2, statistic: 3.5, pValue: 0.001, ciLower: 0.3, ciUpper: 1.1, exponentiated: { estimate: 2.0, ciLower: 1.35, ciUpper: 3.0 } },
      // exponentiated가 null(overflow guard로 계산 안 됨) — 축 계산에서 빠지고 "축 범위 초과"로 표시.
      { name: 'x2', label: 'x2 변수', variableKey: 'x2', level: null, estimate: 750, se: 10, statistic: 75, pValue: 0.0001, ciLower: 730, ciUpper: 770, exponentiated: null },
    ];
    render(<ForestPlot terms={logisticTerms} exponentiated />);
    expect(screen.getByText('축 범위 초과')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    const table = document.querySelector('table');
    expect(table.querySelectorAll('tbody tr').length).toBe(2);
    expect(screen.getByText('2')).toBeTruthy(); // x1의 OR(formatNumber가 trailing zero를 없앤다)
    expect(screen.getByText('—')).toBeTruthy(); // x2는 overflow라 OR 없음
  });

  it('predictor는 있지만 점추정이 비유한이면 그 행에 "축 범위 초과"를 보여준다(전체 억제가 아님)', () => {
    const allMissing = [
      { name: 'x1', label: 'x1', variableKey: 'x1', level: null, estimate: NaN, se: null, statistic: null, pValue: null, ciLower: null, ciUpper: null, exponentiated: null },
    ];
    render(<ForestPlot terms={allMissing} />);
    expect(screen.getByText('축 범위 초과')).toBeTruthy();
    expect(screen.getByText('x1')).toBeTruthy(); // 행 라벨 자체는 유지
  });

  it('predictor 자체가 하나도 없으면(절편만) 억제 문구를 보여준다', () => {
    const interceptOnly = [
      { name: 'intercept', label: '절편', variableKey: null, level: null, estimate: 1.0, se: 0.2, statistic: 5, pValue: 0.001, ciLower: 0.6, ciUpper: 1.4, exponentiated: null },
    ];
    render(<ForestPlot terms={interceptOnly} />);
    expect(screen.getByText(/공개 정책에 따라 표시되지 않음/)).toBeTruthy();
  });

  // PR4-A2(리뷰 지적) — 표준화된 predictor는 "1 SD당" 효과라 원 단위 계수와
  // 단위가 다른데, 화면에 구분 표시가 없어 결과만 보고는 판단할 수 없었다.
  it('standardizedPredictorKeys에 포함된 variableKey는 라벨에 "(표준화, 1 SD당)"이 붙는다', async () => {
    const user = userEvent.setup();
    render(<ForestPlot terms={baseTerms} standardizedPredictorKeys={['x1']} />);
    expect(screen.getByText('x1 변수 (표준화, 1 SD당)')).toBeTruthy();
    expect(screen.getByText('x2 변수')).toBeTruthy(); // x2는 표준화 안 됨 — 접미사 없음
    await user.click(screen.getByRole('button', { name: '데이터 보기' }));
    expect(screen.getByText('x1 변수 (표준화, 1 SD당)')).toBeTruthy();
  });

  // PR4-A2(2차 리뷰 지적) — β₁z₁+β₂z₂+β₁₂z₁z₂에서 z₁의 한계효과는 β₁+β₁₂z₂이지
  // β₁₂ 단독이 아니다. 참여 변수 중 하나라도 표준화됐다고 interaction 전체에
  // "(표준화, 1 SD당)"을 붙이면 해석이 틀린다 — 각 변수의 척도(z-score/원 단위)를
  // 개별 표시해야 한다.
  it('interaction 항은 참여 변수 각각의 척도(z-score/원 단위)를 개별 표시한다(단일 suffix 금지)', () => {
    const interactionTerm = {
      name: 'x1:x2', label: 'x1 변수 × x2 변수', variableKey: null, level: null, termType: 'interaction',
      interactionOf: ['x1', 'x2'], estimate: 0.3, se: 0.1, statistic: 3, pValue: 0.01, ciLower: 0.1, ciUpper: 0.5, exponentiated: null,
    };
    render(
      <ForestPlot
        terms={[...baseTerms, interactionTerm]}
        standardizedPredictorKeys={['x2']}
        variableLabelOf={(k) => ({ x1: 'x1 변수', x2: 'x2 변수' }[k] || k)}
      />,
    );
    // x1은 원 단위, x2는 표준화 — 전체 접미사가 아니라 변수별로 따로 표시된다.
    expect(screen.getByText('x1 변수 × x2 변수 — x1 변수(원 단위) × x2 변수(z-score)')).toBeTruthy();
    expect(screen.queryByText('x1 변수 × x2 변수 (표준화, 1 SD당)')).toBeNull();
  });

  it('표준화가 전혀 쓰이지 않았으면 interaction 라벨에 척도 표시를 붙이지 않는다', () => {
    const interactionTerm = {
      name: 'x1:x2', label: 'x1 변수 × x2 변수', variableKey: null, level: null, termType: 'interaction',
      interactionOf: ['x1', 'x2'], estimate: 0.3, se: 0.1, statistic: 3, pValue: 0.01, ciLower: 0.1, ciUpper: 0.5, exponentiated: null,
    };
    render(<ForestPlot terms={[...baseTerms, interactionTerm]} standardizedPredictorKeys={[]} />);
    expect(screen.getByText('x1 변수 × x2 변수')).toBeTruthy();
  });
});

describe('SplinePartialEffectChart', () => {
  function point(x, delta, ci) {
    return {
      x, deltaFromBaseline: delta,
      ciLower: ci ? ci[0] : null, ciUpper: ci ? ci[1] : null,
      exponentiated: null,
    };
  }

  it('points가 없으면 억제 문구를 보여준다', () => {
    render(<SplinePartialEffectChart effect={{ variableKey: 'x1', scale: 'linear_predictor', points: [] }} label="x1" />);
    expect(screen.getByText(/공개 정책에 따라 표시되지 않음/)).toBeTruthy();
  });

  // PR4-A2(리뷰 지적) — bandPathFor()가 CI 없는 점을 걸러낸 뒤 나머지를 하나의
  // polygon으로 이었다. 5점 중 가운데(index 2) CI만 null이면, delta 자체는
  // 정상(끊기지 않는 선)이라 실제로는 band가 양옆 두 구간으로 나뉘어야 하는데
  // 버그가 있으면 band path가 1개(전체를 잇는)로 렌더된다.
  it('가운데 점만 CI가 null이면 신뢰구간 band가 2개 구간으로 분리되어 그려진다(1개로 이어붙지 않는다)', () => {
    const points = [
      point(0, 0.0, [-0.2, 0.2]),
      point(1, 0.5, [0.2, 0.8]),
      point(2, 1.0, null), // 이 점만 CI 계산 실패 — delta는 정상(선은 안 끊김)
      point(3, 1.5, [1.1, 1.9]),
      point(4, 2.0, [1.6, 2.4]),
    ];
    render(<SplinePartialEffectChart effect={{ variableKey: 'x1', scale: 'linear_predictor', points }} label="x1" />);

    // line(중심선)은 끊기지 않은 하나의 path(fill="none")여야 한다.
    const linePaths = document.querySelectorAll('path[fill="none"]');
    expect(linePaths.length).toBe(1);

    // band(신뢰구간 영역)는 fill=ACCENT로 채워진 path — 가운데 점에서 끊겨 2개여야 한다.
    const bandPaths = document.querySelectorAll('path[fill="#1d4ed8"]');
    expect(bandPaths.length).toBe(2);
  });

  it('delta 자체가 비유한(계산 실패)인 점에서는 선도 함께 끊긴다', () => {
    const points = [
      point(0, 0.0, [-0.2, 0.2]),
      point(1, null, null), // delta 자체 실패 — 선도 끊겨야 함
      point(2, 1.0, [0.6, 1.4]),
    ];
    render(<SplinePartialEffectChart effect={{ variableKey: 'x1', scale: 'linear_predictor', points }} label="x1" />);
    const linePaths = document.querySelectorAll('path[fill="none"]');
    expect(linePaths.length).toBe(2); // 끊긴 두 구간이 각각 별도 path
  });

  it('모든 점에 CI가 있으면 band가 1개의 연속된 path로 그려진다(과도한 분할 방지)', () => {
    const points = [
      point(0, 0.0, [-0.2, 0.2]),
      point(1, 0.5, [0.2, 0.8]),
      point(2, 1.0, [0.6, 1.4]),
    ];
    render(<SplinePartialEffectChart effect={{ variableKey: 'x1', scale: 'linear_predictor', points }} label="x1" />);
    const bandPaths = document.querySelectorAll('path[fill="#1d4ed8"]');
    expect(bandPaths.length).toBe(1);
  });
});

// PR3-B 계획서 §6.8.5 — 지금까지 hover(마우스)로만 뜨던 정보를 키보드 포커스로도
// 꺼낼 수 있는지. ChartTooltip 자체의 동작(단위) + 실제로 각 차트에 붙어 있는지
// (교차 스모크)를 나눠서 검증한다.
describe('ChartTooltip — 키보드 포커스로 작동하는 툴팁(§6.8.5)', () => {
  it('포커스 전에는 말풍선이 없고, Tab으로 포커스하면 나타나고, blur하면 사라진다', async () => {
    const user = userEvent.setup();
    render(
      <svg>
        <ChartTooltip label="테스트 값: 42건" anchorX={10} anchorY={10}>
          <rect width={10} height={10} />
        </ChartTooltip>
      </svg>,
    );
    // aria-label은 항상 있다(포커스 여부와 무관 — 스크린리더가 포커스 즉시 읽을 수 있어야 함).
    const target = screen.getByRole('img', { name: '테스트 값: 42건' });
    expect(target.getAttribute('tabindex')).toBe('0');
    // 포커스 전 — 화면에 보이는 말풍선(<text>)은 아직 없다.
    expect(screen.queryByText('테스트 값: 42건')).toBeFalsy();

    await user.tab();
    expect(document.activeElement).toBe(target);
    expect(screen.getByText('테스트 값: 42건')).toBeTruthy(); // 포커스 시 시각적 말풍선 등장

    await user.tab(); // 다른 곳으로 포커스 이동 → blur
    expect(document.activeElement).not.toBe(target);
    expect(screen.queryByText('테스트 값: 42건')).toBeFalsy();
  });

  it('마우스 hover로도 여전히 동일하게 동작한다(기존 <title> 방식과 공존)', async () => {
    const user = userEvent.setup();
    render(
      <svg>
        <ChartTooltip label="호버 값" anchorX={0} anchorY={0}>
          <rect width={10} height={10} />
        </ChartTooltip>
      </svg>,
    );
    const target = screen.getByRole('img', { name: '호버 값' });
    await user.hover(target);
    expect(screen.getByText('호버 값')).toBeTruthy();
    await user.unhover(target);
    expect(screen.queryByText('호버 값')).toBeFalsy();
  });

  // 교차 스모크 — 각 차트의 대표 interactive shape 하나가 실제로 Tab 이동 가능하고
  // 포커스 시 값이 화면에 보이는지(스크린리더 전용이 아니라 시각적으로도 나오는지).
  // 모든 차트가 DataTableView로 감싸여 있어 DOM상 "데이터 보기" 토글 버튼이 항상
  // 차트보다 먼저 나온다 — 그 버튼이 첫 Tab 정지점을 차지하므로 실제 차트 요소는
  // 그 다음 tab부터다(실측으로 확인, 최초 작성 시 이걸 놓쳐 tab 수가 하나씩
  // 모자랐었다). 또한 `<title>`(항상 DOM에 존재, 마우스 hover 전용)과 ChartTooltip의
  // 말풍선(active일 때만 존재)이 같은 문구를 쓰는 차트는, getByText만으로는 어느 쪽을
  // 잡았는지 구분이 안 된다 — 포커스 "전"에 아직 없다가 "후"에 나타나는지까지
  // 확인해야 진짜로 키보드 포커스가 만든 것임을 증명한다.
  function tooltipBubbleText() {
    return document.querySelector('.chart-tooltip-text')?.textContent ?? null;
  }

  it('Histogram 막대가 Tab으로 포커스되면 구간·건수가 보인다(포커스 전엔 말풍선 없음)', async () => {
    const user = userEvent.setup();
    render(<Histogram histogram={{ bins: [{ lower: 0, upper: 10, count: 7 }] }} />);
    expect(tooltipBubbleText()).toBeNull();
    await user.tab(); // 1: 데이터 보기 버튼
    await user.tab(); // 2: 막대
    expect(tooltipBubbleText()).toMatch(/0 ~ 10: 7건/);
  });

  it('BoxPlot 중앙값 라인이 Tab으로 포커스되면 값이 보인다', async () => {
    const user = userEvent.setup();
    render(<BoxPlot boxplot={{ q1: 2, median: 3.5, q3: 4.75, lowerWhisker: 1, upperWhisker: 5 }} />);
    // DOM 순서: 데이터 보기 버튼 → 하단 whisker → 상단 whisker → Q1~Q3 박스 → 중앙값.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(tooltipBubbleText()).toMatch(/중앙값: 3.5/);
  });

  it('StackedBarChart100 칸이 Tab으로 포커스되면 라벨·건수가 보인다', async () => {
    const user = userEvent.setup();
    render(<StackedBarChart100 table={{ rowLabels: ['행1'], colLabels: ['열A', '열B'], cells: [[3, 7]] }} />);
    expect(tooltipBubbleText()).toBeNull();
    await user.tab(); // 1: 데이터 보기 버튼
    await user.tab(); // 2: 첫 칸
    expect(tooltipBubbleText()).toMatch(/열A: 3/);
  });

  it('CorrelationHeatmap 비대각 칸이 Tab으로 포커스되면 r/p값이 보인다', async () => {
    const user = userEvent.setup();
    const cells = [{ suppressed: false, xKey: 'a', yKey: 'b', n: 50, r: 0.5, pValue: 0.01, adjustedP: 0.02 }];
    render(<CorrelationHeatmap variableKeys={['a', 'b']} cells={cells} labelOf={(k) => k} />);
    expect(screen.queryByText(/r=0.500/)).toBeFalsy();
    await user.tab(); // 1: 데이터 보기 버튼
    await user.tab(); // 2: (0,0) 대각선은 포커스 불가라 건너뛰고 첫 비대각 칸
    expect(screen.getByText(/r=0.500/)).toBeTruthy();
  });

  it('ScatterPlot 그리드 셀이 Tab으로 포커스되면 x/y 구간·건수가 보인다', async () => {
    const user = userEvent.setup();
    render(<ScatterPlot scatter={{
      displayedCount: 50, totalCount: 50,
      grid: { xEdges: [0, 10], yEdges: [100, 200], cells: [{ i: 0, j: 0, count: 50 }] },
    }} />);
    expect(tooltipBubbleText()).toBeNull();
    await user.tab(); // 1: 데이터 보기 버튼
    await user.tab(); // 2: 첫 그리드 셀
    expect(tooltipBubbleText()).toMatch(/x: 0 ~ 10, y: 100 ~ 200 — 50건/);
  });
});

// 코드리뷰 수정(2026-09-12) — 말풍선을 항상 anchor 위쪽에 그리면 차트 맨 위
// 근처 요소(히스토그램 최고 막대, 누적막대 첫 행)에서 SVG viewBox 밖으로
// 잘린다(리뷰 실측: 히스토그램 최고 막대 배경 y=-14, 누적막대 첫 행 글자중심
// y=-4 — 둘 다 0보다 작아 화면 밖). DOM 존재 확인만으로는 이 잘림이 안 잡혀서
// (전에는 "말풍선 텍스트가 DOM에 있는지"만 봤음), 이번엔 렌더된 말풍선 배경
// <rect>의 실제 y 좌표(양수=아래쪽에 그려짐, 잘리지 않음)까지 확인한다.
describe('ChartTooltip 위치 — 차트 상단 근처에서 잘리지 않아야 한다(코드리뷰 수정)', () => {
  function tooltipBgY() {
    const rect = document.querySelector('.chart-tooltip-bg');
    return rect ? Number(rect.getAttribute('y')) : null;
  }

  it('chooseTooltipPlacement — margin.top+anchorY가 여유(26px) 미만이면 below, 이상이면 above', () => {
    expect(chooseTooltipPlacement(0, 12)).toBe('below'); // 12 < 26
    expect(chooseTooltipPlacement(0, 26)).toBe('above'); // 정확히 경계(26)는 안전 쪽(above)
    expect(chooseTooltipPlacement(0, 96)).toBe('above'); // 히트맵처럼 margin이 넉넉하면 항상 above
    expect(chooseTooltipPlacement(50, 12)).toBe('above'); // anchor가 이미 아래로 내려와 있으면 above
  });

  it('ChartTooltip에 placement="below"를 주면 말풍선 배경이 anchor 아래(양수 y)에 그려진다', async () => {
    const user = userEvent.setup();
    render(
      <svg>
        <ChartTooltip label="아래로 뒤집힘" anchorX={0} anchorY={0} placement="below">
          <rect width={10} height={10} />
        </ChartTooltip>
      </svg>,
    );
    await user.tab();
    const y = tooltipBgY();
    expect(y).not.toBeNull();
    expect(y).toBeGreaterThanOrEqual(0); // 잘리지 않으려면 anchor 아래(양수)여야 함
  });

  // 리뷰가 정확히 지적한 반례 — 히스토그램 최고 막대(MARGIN.top=12, yScale(count)=0
  // → 12+0=12<26)는 뒤집혀서(below) 그려져야 한다.
  it('Histogram 최고 막대는 위쪽 여유가 부족해 말풍선이 아래로 뒤집힌다(코드리뷰 반례)', async () => {
    const user = userEvent.setup();
    render(<Histogram histogram={{ bins: [{ lower: 0, upper: 10, count: 100 }] }} />);
    await user.tab(); // 데이터 보기 버튼
    await user.tab(); // 유일한(=최고) 막대
    const y = tooltipBgY();
    expect(y).not.toBeNull();
    expect(y).toBeGreaterThanOrEqual(0); // 고치기 전엔 y=-26(뷰 밖)이었음
  });

  // 리뷰가 정확히 지적한 반례 — 누적막대 첫 행(MARGIN.top=8, y=0 → 8+0=8<26)도
  // 뒤집혀야 한다.
  it('StackedBarChart100 첫 행은 위쪽 여유가 부족해 말풍선이 아래로 뒤집힌다(코드리뷰 반례)', async () => {
    const user = userEvent.setup();
    render(<StackedBarChart100 table={{ rowLabels: ['행1'], colLabels: ['열A'], cells: [[5]] }} />);
    await user.tab(); // 데이터 보기 버튼
    await user.tab(); // 첫(유일한) 칸
    const y = tooltipBgY();
    expect(y).not.toBeNull();
    expect(y).toBeGreaterThanOrEqual(0); // 고치기 전엔 y=-26(뷰 밖)이었음
  });

  it('CorrelationHeatmap은 margin.top이 넉넉해(96) 항상 above로 유지된다(회귀 방지)', async () => {
    const user = userEvent.setup();
    const cells = [{ suppressed: false, xKey: 'a', yKey: 'b', n: 50, r: 0.5, pValue: 0.01, adjustedP: 0.02 }];
    render(<CorrelationHeatmap variableKeys={['a', 'b']} cells={cells} labelOf={(k) => k} />);
    await user.tab();
    await user.tab();
    const y = tooltipBgY();
    expect(y).toBeLessThan(0); // above 그대로(음수) — margin이 넉넉해 잘릴 위험이 없었음
  });
});

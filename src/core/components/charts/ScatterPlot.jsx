import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { ACCENT } from './palette';
import { formatNumber } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const HEIGHT = 280;
const MARGIN = { top: 12, right: 16, bottom: 24, left: 48 };

// PR3-B 계획서 §2/§6.8.1/§6.8.4 — points(원시좌표, limited_row)가 있으면 그대로,
// 없으면 grid(2D 집계, aggregate)로 대체 렌더링한다. 회귀선·r·p값은 항상 전체
// 유효 pairwise-complete 집합 기준 — 표시가 샘플/그리드로 축소돼도 통계량은
// 축소되지 않는다는 것을 "표시 중 n / 전체 n"으로 명시한다.
export function ScatterPlot({ scatter, regressionLine }) {
  if (!scatter || (!scatter.points && !scatter.grid)) {
    return <SuppressionNotice />;
  }

  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  let xDomain;
  let yDomain;
  if (scatter.points) {
    const xs = scatter.points.map((p) => p[0]);
    const ys = scatter.points.map((p) => p[1]);
    xDomain = [Math.min(...xs), Math.max(...xs)];
    yDomain = [Math.min(...ys), Math.max(...ys)];
  } else {
    const { xEdges, yEdges } = scatter.grid;
    xDomain = [xEdges[0], xEdges[xEdges.length - 1]];
    yDomain = [yEdges[0], yEdges[yEdges.length - 1]];
  }
  const xScale = createLinearScale(xDomain, [0, innerWidth]);
  const yScale = createLinearScale(yDomain, [innerHeight, 0]);

  let content;
  let tableRows;
  if (scatter.points) {
    // 키보드 접근성(§6.8.5) — 원시점은 최대 2,000개까지 있을 수 있어(§7 샘플
    // 상한) 전부 개별 Tab 정지점으로 만들면 키보드 탐색 자체가 못 쓸 정도로
    // 길어진다(포커스 트랩에 가까운 UX). 이 경우엔 "데이터 보기" 표(모든 점을
    // 이미 접근 가능한 HTML 표로 제공)가 실질적인 키보드/스크린리더 대안이고,
    // 그리드(아래 분기, 항상 훨씬 적은 셀 수)에만 개별 포커스형 툴팁을 붙인다.
    content = scatter.points.map((p, i) => (
      <circle key={i} cx={xScale(p[0])} cy={yScale(p[1])} r={3} fill={ACCENT} fillOpacity={0.55} />
    ));
    tableRows = scatter.points.map((p, i) => <tr key={i}><td>{formatNumber(p[0])}</td><td>{formatNumber(p[1])}</td></tr>);
  } else {
    const { xEdges, yEdges, cells } = scatter.grid;
    const maxCount = Math.max(...cells.map((c) => c.count), 1);
    content = cells.map((c, i) => {
      const x0 = xScale(xEdges[c.i]);
      const x1 = xScale(xEdges[c.i + 1]);
      const y0 = yScale(yEdges[c.j]);
      const y1 = yScale(yEdges[c.j + 1]);
      const label = `x: ${formatNumber(xEdges[c.i])} ~ ${formatNumber(xEdges[c.i + 1])}, y: ${formatNumber(yEdges[c.j])} ~ ${formatNumber(yEdges[c.j + 1])} — ${c.count}건`;
      const cellTop = Math.min(y0, y1);
      // 코드리뷰 수정 — y값이 큰(차트 위쪽) 셀은 위쪽에 말풍선을 그리면 잘린다.
      const placement = chooseTooltipPlacement(cellTop, MARGIN.top);
      return (
        <ChartTooltip key={i} label={label} anchorX={(x0 + x1) / 2} anchorY={cellTop} placement={placement}>
          <rect
            x={Math.min(x0, x1)} y={Math.min(y0, y1)}
            width={Math.max(Math.abs(x1 - x0), 1)} height={Math.max(Math.abs(y1 - y0), 1)}
            fill={ACCENT} fillOpacity={0.15 + 0.75 * (c.count / maxCount)}
          >
            <title>{label}</title>
          </rect>
        </ChartTooltip>
      );
    });
    // 코드리뷰 수정 — 이전엔 bin 번호(c.i/c.j)만 표시해 어느 값 구간에 관측치가
    // 몰렸는지 데이터 보기 표만으로는 알 수 없었다(히스토그램은 처음부터 lower~upper
    // 실값을 보여줬는데 산점도 그리드만 예외였음). 실제 x/y 구간 값으로 바꾼다.
    tableRows = cells.map((c, i) => (
      <tr key={i}>
        <td>{formatNumber(xEdges[c.i])} ~ {formatNumber(xEdges[c.i + 1])}</td>
        <td>{formatNumber(yEdges[c.j])} ~ {formatNumber(yEdges[c.j + 1])}</td>
        <td>{c.count}</td>
      </tr>
    ));
  }

  // 코드리뷰 수정 — 축 선만 있고 숫자 눈금이 없어 어느 값 범위에 점/셀이 있는지
  // 시각적으로 읽을 수 없었다(Histogram.jsx는 처음부터 y축 눈금이 있었는데 산점도만
  // 빠져 있었음). x/y 둘 다 "nice number" 눈금(scales.js, 다른 차트와 동일 알고리즘)을
  // 그린다 — 도메인이 한 점(min===max)이면 눈금 하나만 나온다(computeNiceTicks 자체 처리).
  const xTicks = computeNiceTicks(xDomain[0], xDomain[1], 5).filter((t) => t >= xDomain[0] && t <= xDomain[1]);
  const yTicks = computeNiceTicks(yDomain[0], yDomain[1], 5).filter((t) => t >= yDomain[0] && t <= yDomain[1]);

  const fitLine = regressionLine ? (
    <line
      x1={0} x2={innerWidth}
      y1={yScale(regressionLine.slope * xDomain[0] + regressionLine.intercept)}
      y2={yScale(regressionLine.slope * xDomain[1] + regressionLine.intercept)}
      className="chart-box-median"
    />
  ) : null;

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel="산점도">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
              {formatNumber(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x-${t}`} x={xScale(t)} y={innerHeight + 16} textAnchor="middle" className="chart-axis-label">
            {formatNumber(t)}
          </text>
        ))}
        <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} className="chart-axis-line" />
        <line x1={0} x2={0} y1={0} y2={innerHeight} className="chart-axis-line" />
        {content}
        {fitLine}
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead>
        <tr>{scatter.points ? <><th>x</th><th>y</th></> : <><th>x bin</th><th>y bin</th><th>건수</th></>}</tr>
      </thead>
      <tbody>{tableRows}</tbody>
    </>
  );

  // 코드리뷰 수정 — "표시 중 X / 전체 Y"는 원시 좌표를 최대 2,000쌍까지 샘플링해
  // "일부만 표시"할 때만 의미가 있는 문구다(§7). grid만 있을 땐 샘플링이 아니라
  // 전체를 요약(aggregate)해서 보여주는 것이므로 같은 문구를 쓰면 "축소 표시"로
  // 오인할 수 있다 — 두 경우를 다른 문구로 구분한다.
  const countCaption = scatter.points
    ? `표시 중 ${scatter.displayedCount} / 전체 ${scatter.totalCount}건`
    : `전체 ${scatter.totalCount}건을 그리드로 요약 표시`;

  return (
    <div>
      <p className="swb-suppressed-note">{countCaption}</p>
      <DataTableView chart={chart} table={table} tableCaption="산점도 데이터" />
    </div>
  );
}

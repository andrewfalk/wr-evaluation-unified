import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { STATUS_COLORS } from './palette';
import { formatNumber } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const HEIGHT = 200;
const MARGIN = { top: 16, right: 24, bottom: 12, left: 52 };
const BOX_HALF_WIDTH = 60;
const WHISKER_CAP_HALF = 16;

// PR3-B 계획서 §1/§3 — q1/median/q3/lowerWhisker/upperWhisker는 boxplot 자체가
// 있으면 항상 값이 있다. outlierCount/outlierValues는 별개의 독립 게이트를 통과
// 해야만 존재(§1) — outlierValues는 limited_row 권한이 있을 때만 응답시점에
// 추가로 붙는다(§9). 셋 다 없을 수 있고, 그 경우 "(비공개)"로 표기한다.
export function BoxPlot({ boxplot }) {
  if (!boxplot) return <SuppressionNotice />;
  const { q1, median, q3, lowerWhisker, upperWhisker, outlierCount, outlierValues } = boxplot;

  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const allValues = [lowerWhisker, upperWhisker, ...(outlierValues || [])];
  const domainMin = Math.min(...allValues);
  const domainMax = Math.max(...allValues);
  const yScale = createLinearScale([domainMin, domainMax], [innerHeight, 0]);
  const yTicks = computeNiceTicks(domainMin, domainMax, 4);
  const centerX = innerWidth / 2;

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel="박스플롯">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
              {formatNumber(t, 1)}
            </text>
          </g>
        ))}
        {/* 코드리뷰 수정 — 값이 클수록 yScale이 0에 가까워져(차트 위쪽) 위쪽에
            말풍선을 그리면 잘릴 수 있다(특히 상단 whisker·Q3·상단 이상치).
            요소마다 실제 위치로 판정한다(전체를 한 번에 정하지 않음). */}
        <ChartTooltip label={`하단 whisker: ${formatNumber(lowerWhisker)}`} anchorX={centerX} anchorY={yScale(lowerWhisker)} placement={chooseTooltipPlacement(yScale(lowerWhisker), MARGIN.top)}>
          <line x1={centerX - WHISKER_CAP_HALF} x2={centerX + WHISKER_CAP_HALF} y1={yScale(lowerWhisker)} y2={yScale(lowerWhisker)} className="chart-axis-line" />
        </ChartTooltip>
        <ChartTooltip label={`상단 whisker: ${formatNumber(upperWhisker)}`} anchorX={centerX} anchorY={yScale(upperWhisker)} placement={chooseTooltipPlacement(yScale(upperWhisker), MARGIN.top)}>
          <line x1={centerX - WHISKER_CAP_HALF} x2={centerX + WHISKER_CAP_HALF} y1={yScale(upperWhisker)} y2={yScale(upperWhisker)} className="chart-axis-line" />
        </ChartTooltip>
        <line x1={centerX} x2={centerX} y1={yScale(lowerWhisker)} y2={yScale(upperWhisker)} className="chart-axis-line" />
        <ChartTooltip label={`Q1~Q3: ${formatNumber(q1)} ~ ${formatNumber(q3)}`} anchorX={centerX} anchorY={yScale(q3)} placement={chooseTooltipPlacement(yScale(q3), MARGIN.top)}>
          <rect
            x={centerX - BOX_HALF_WIDTH} y={yScale(q3)}
            width={BOX_HALF_WIDTH * 2} height={Math.max(yScale(q1) - yScale(q3), 1)}
            className="chart-box-fill"
          />
        </ChartTooltip>
        <ChartTooltip label={`중앙값: ${formatNumber(median)}`} anchorX={centerX} anchorY={yScale(median)} placement={chooseTooltipPlacement(yScale(median), MARGIN.top)}>
          <line x1={centerX - BOX_HALF_WIDTH} x2={centerX + BOX_HALF_WIDTH} y1={yScale(median)} y2={yScale(median)} className="chart-box-median" />
        </ChartTooltip>
        {(outlierValues || []).map((v, i) => (
          <ChartTooltip key={i} label={`이상치: ${formatNumber(v)}`} anchorX={centerX} anchorY={yScale(v)} placement={chooseTooltipPlacement(yScale(v), MARGIN.top)}>
            <circle cx={centerX} cy={yScale(v)} r={4} fill="none" stroke={STATUS_COLORS.danger} strokeWidth={1.5} />
          </ChartTooltip>
        ))}
      </g>
    </ChartContainer>
  );

  const outlierText = outlierCount === undefined
    ? '(비공개)'
    : `${outlierCount}건${outlierValues ? ` [${outlierValues.map((v) => formatNumber(v)).join(', ')}]` : ''}`;

  const table = (
    <>
      <thead><tr><th>항목</th><th>값</th></tr></thead>
      <tbody>
        <tr><td>Q1</td><td>{formatNumber(q1)}</td></tr>
        <tr><td>중앙값</td><td>{formatNumber(median)}</td></tr>
        <tr><td>Q3</td><td>{formatNumber(q3)}</td></tr>
        <tr><td>하단 whisker</td><td>{formatNumber(lowerWhisker)}</td></tr>
        <tr><td>상단 whisker</td><td>{formatNumber(upperWhisker)}</td></tr>
        <tr><td>이상치</td><td>{outlierText}</td></tr>
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="박스플롯 데이터" />;
}

import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { ACCENT } from './palette';
import { formatInt, formatNumber } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const HEIGHT = 220;
const MARGIN = { top: 12, right: 16, bottom: 12, left: 44 };

// PR3-B 계획서 §2 — histogram이 null이면(person 단위 전체연결억제) 억제 문구만
// 보여준다. 경계 포함규칙은 서버(numpy.histogram)와 동일 — 마지막 bin만 양끝 포함.
export function Histogram({ histogram }) {
  if (!histogram) return <SuppressionNotice />;
  const { bins } = histogram;
  if (bins.length === 0) return <p className="swb-suppressed-note">자료 없음</p>;

  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const isSingleConstant = bins.length === 1 && bins[0].lower === bins[0].upper;
  const xScale = createLinearScale(
    isSingleConstant ? [0, 1] : [bins[0].lower, bins[bins.length - 1].upper],
    [0, innerWidth],
  );
  const yScale = createLinearScale([0, maxCount], [innerHeight, 0]);
  const yTicks = computeNiceTicks(0, maxCount, 4);

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel="히스토그램">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
              {formatInt(t)}
            </text>
          </g>
        ))}
        {bins.map((b, i) => {
          const x0 = isSingleConstant ? 0 : xScale(b.lower);
          const x1 = isSingleConstant ? innerWidth : xScale(b.upper);
          const barWidth = Math.max(x1 - x0 - 1, 1);
          const barHeight = Math.max(innerHeight - yScale(b.count), 0);
          const label = `${formatNumber(b.lower)} ~ ${formatNumber(b.upper)}: ${b.count}건`;
          // 코드리뷰 수정 — 최고 막대(yScale(count)===0)는 차트 맨 위와 맞닿아
          // 있어 말풍선을 위쪽에 그리면 SVG viewBox 밖으로 잘린다(실측 확인:
          // MARGIN.top=12+0<26). 그럴 땐 아래로 뒤집는다.
          const placement = chooseTooltipPlacement(yScale(b.count), MARGIN.top);
          return (
            <ChartTooltip key={i} label={label} anchorX={x0 + barWidth / 2} anchorY={yScale(b.count)} placement={placement}>
              <rect x={x0} y={yScale(b.count)} width={barWidth} height={barHeight} fill={ACCENT}>
                <title>{label}</title>
              </rect>
            </ChartTooltip>
          );
        })}
        <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} className="chart-axis-line" />
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>구간</th><th>건수</th></tr></thead>
      <tbody>
        {bins.map((b, i) => (
          <tr key={i}>
            <td>{formatNumber(b.lower)} ~ {formatNumber(b.upper)}{i === bins.length - 1 ? '(포함)' : ' 미만'}</td>
            <td>{b.count}</td>
          </tr>
        ))}
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="히스토그램 데이터" />;
}

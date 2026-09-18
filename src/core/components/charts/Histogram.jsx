import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { ACCENT } from './palette';
import { formatInt, formatNumber } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const HEIGHT = 220;
const MARGIN = { top: 12, right: 16, bottom: 12, left: 44 };

// B안(A안 후속) — histogram이 null이어도 이유가 두 가지로 나뉜다: n=0 등 애초에
// 히스토그램이 없던 경우(기존 기본 문구)와, 적응형 해상도 축소가 후보를 전부
// 시도해도 공개 가능한 해상도를 못 찾은 경우(histogramReasonCode==='INSUFFICIENT_
// DISCLOSABLE_RESOLUTION', 전용 문구). histogram이 있고 merged===true면 원본보다
// 구간 수를 줄여 재분할했다는 안내를 차트 아래에 덧붙인다(정확한 원본 개수는
// 일부러 밝히지 않음 — server/src/statsChartDisclosure.ts 주석 참고). 경계
// 포함규칙은 서버(numpy.histogram)와 동일 — 마지막 bin만 양끝 포함.
export function Histogram({ histogram, histogramReasonCode }) {
  if (!histogram) {
    return histogramReasonCode === 'INSUFFICIENT_DISCLOSABLE_RESOLUTION'
      ? <SuppressionNotice>분포를 표시하기에는 공개 가능한 구간이 부족합니다.</SuppressionNotice>
      : <SuppressionNotice />;
  }
  const { bins, merged } = histogram;
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

  return (
    <>
      <DataTableView chart={chart} table={table} tableCaption="히스토그램 데이터" />
      {merged && <p className="swb-suppressed-note">공개 기준에 맞춰 구간 수를 줄여 표시했습니다.</p>}
    </>
  );
}

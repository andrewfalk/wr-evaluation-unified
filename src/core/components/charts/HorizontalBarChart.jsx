import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale } from './scales';
import { ACCENT } from './palette';
import { DataTableView } from './DataTableView';

const BAR_HEIGHT = 24;
const BAR_GAP = 10;
const MARGIN = { top: 8, right: 72, bottom: 8, left: 128 };

// PR3-B 계획서 §6.8.2 — 범주형 기술통계 기본 그래프. §6.8.5(키보드 툴팁)를 여기엔
// 안 붙인다 — 이 차트는 값(개수·비율)을 처음부터 막대 옆에 항상 보이는 텍스트로
// 그린다(hover/focus로만 드러나는 숨은 정보가 없음). ChartTooltip은 "hover 전에는
// 안 보이던 정보"를 키보드로도 꺼낼 수 있게 하려는 것이라 여긴 대상이 없다.
export function HorizontalBarChart({ levels }) {
  if (!levels || levels.length === 0) return <p className="swb-suppressed-note">자료 없음</p>;

  const height = MARGIN.top + MARGIN.bottom + levels.length * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const maxCount = Math.max(...levels.map((l) => l.count), 1);
  const xScale = createLinearScale([0, maxCount], [0, innerWidth]);

  const chart = (
    <ChartContainer height={height} ariaLabel="가로막대 차트">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {levels.map((l, i) => {
          const y = i * (BAR_HEIGHT + BAR_GAP);
          const barWidth = Math.max(xScale(l.count), 1);
          return (
            <g key={String(l.level)}>
              <text x={-8} y={y + BAR_HEIGHT / 2} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
                {String(l.level)}
              </text>
              <rect x={0} y={y} width={barWidth} height={BAR_HEIGHT} fill={ACCENT} />
              <text x={barWidth + 6} y={y + BAR_HEIGHT / 2} dominantBaseline="middle" className="chart-value-label">
                {l.count} ({(l.proportion * 100).toFixed(1)}%)
              </text>
            </g>
          );
        })}
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>수준</th><th>빈도</th><th>비율</th></tr></thead>
      <tbody>
        {levels.map((l, i) => (
          <tr key={i}><td>{String(l.level)}</td><td>{l.count}</td><td>{(l.proportion * 100).toFixed(1)}%</td></tr>
        ))}
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="가로막대 데이터" />;
}

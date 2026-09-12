import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { categoricalColor } from './palette';
import { DataTableView } from './DataTableView';
import { Legend } from './Legend';
import { SuppressionNotice } from './SuppressionNotice';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const BAR_HEIGHT = 28;
const BAR_GAP = 14;
const MARGIN = { top: 8, right: 16, bottom: 8, left: 100 };

// PR3-B 계획서 §6.8.2 — 범주×범주 기본 그래프. table이 없으면(§5 "분할표 전체연결
// 억제") 개별 칸 수치는 절대 만들지 않는다 — 집계 통계량만 있는 상태와 동일하게
// 그래프도 억제한다.
export function StackedBarChart100({ table }) {
  if (!table) {
    return <SuppressionNotice>개별 칸(셀) 수치는 표시하지 않습니다 — 집계 통계량만 공개됩니다.</SuppressionNotice>;
  }
  const { rowLabels, colLabels, cells } = table;
  const height = MARGIN.top + MARGIN.bottom + rowLabels.length * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;

  const chart = (
    <ChartContainer height={height} ariaLabel="100% 누적 막대 차트">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {rowLabels.map((rowLabel, i) => {
          const row = cells[i];
          const total = row.reduce((s, c) => s + c, 0);
          let cursor = 0;
          const y = i * (BAR_HEIGHT + BAR_GAP);
          return (
            <g key={String(rowLabel)}>
              <text x={-8} y={y + BAR_HEIGHT / 2} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
                {String(rowLabel)}
              </text>
              {row.map((count, j) => {
                const segmentWidth = total > 0 ? (count / total) * innerWidth : 0;
                const x = cursor;
                cursor += segmentWidth;
                if (count === 0) return null;
                const label = `${String(colLabels[j])}: ${count}`;
                // 코드리뷰 수정 — 첫 행(y=0)은 차트 맨 위와 맞닿아 있어 말풍선을
                // 위쪽에 그리면 잘린다(실측 확인: MARGIN.top=8+0<26).
                const placement = chooseTooltipPlacement(y, MARGIN.top);
                return (
                  <ChartTooltip key={j} label={label} anchorX={x + segmentWidth / 2} anchorY={y} placement={placement}>
                    <rect x={x} y={y} width={segmentWidth} height={BAR_HEIGHT} fill={categoricalColor(j)}>
                      <title>{label}</title>
                    </rect>
                  </ChartTooltip>
                );
              })}
            </g>
          );
        })}
      </g>
    </ChartContainer>
  );

  const legendItems = colLabels.map((c, j) => ({ label: String(c), color: categoricalColor(j) }));

  const tableEl = (
    <>
      <thead><tr><th /><th colSpan={colLabels.length}>{colLabels.map(String).join(' / ')}</th></tr></thead>
      <tbody>
        {rowLabels.map((r, i) => (
          <tr key={String(r)}><th>{String(r)}</th>{cells[i].map((c, j) => <td key={j}>{c}</td>)}</tr>
        ))}
      </tbody>
    </>
  );

  return (
    <div>
      <Legend items={legendItems} />
      <DataTableView chart={chart} table={tableEl} tableCaption="분할표 데이터" />
    </div>
  );
}

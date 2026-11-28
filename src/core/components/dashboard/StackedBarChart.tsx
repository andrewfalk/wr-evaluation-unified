// 대시보드 화면 조각(P2-85a, Phase 2 C9 구간 A) — Dashboard.tsx에서 선언 본문 그대로 옮겼다(바뀐 것은 export와 import뿐).
// 평가 결과 누적 막대 차트(높음·낮음·미평가)와 그 색.
import type { CSSProperties, ReactNode } from 'react';

export const SEG_COLORS = {
  high: 'var(--color-safe)',
  low: '#f59e0b',
  unassessed: 'var(--text-muted)',
};

export interface StackedBarDatum {
  key: string;
  label: string;
  highCount: number;
  lowCount: number;
  unassessedCount: number;
}

export interface StackedBarChartProps {
  data: StackedBarDatum[];
  title: ReactNode;
  caption?: ReactNode;
}

export const StackedBarChart = ({ data, title, caption = '' }: StackedBarChartProps) => {
  const maxTotal = Math.max(...data.map(d => d.highCount + d.lowCount + d.unassessedCount), 5);
  const gridSteps = 5;
  const stepValue = Math.ceil(maxTotal / gridSteps);
  const yMax = stepValue * gridSteps;

  return (
    <div className="dashboard-section pattern-surface">
      <div className="dashboard-section-heading">
        <div>
          <div className="dashboard-section-title">{title}</div>
          <div className="stacked-legend">
            <span className="stacked-legend-item"><span className="stacked-legend-dot" style={{ background: SEG_COLORS.high }} />높음</span>
            <span className="stacked-legend-item"><span className="stacked-legend-dot" style={{ background: SEG_COLORS.low }} />낮음</span>
            <span className="stacked-legend-item"><span className="stacked-legend-dot" style={{ background: SEG_COLORS.unassessed }} />미평가</span>
          </div>
        </div>
        <div className="dashboard-section-caption">{caption}</div>
      </div>
      <div className="dashboard-chart-area">
        <div className="dashboard-y-axis">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <span className="dashboard-y-label" key={i}>{yMax - i * stepValue}</span>
          ))}
        </div>
        <div className="dashboard-chart-body">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <div className="dashboard-grid-line" key={i} style={{ '--line-top': `${(i / gridSteps) * 100}%` } as CSSProperties} />
          ))}
          <div className="dashboard-bars">
            {data.map(d => {
              const total = d.highCount + d.lowCount + d.unassessedCount;
              return (
                <div className="dashboard-bar-wrapper" key={d.key}>
                  {d.highCount > 0 && <span className="stacked-bar-high-label">{d.highCount}</span>}
                  {d.lowCount > 0 && <span className="stacked-bar-low-label">{d.lowCount}</span>}
                  <div className="stacked-bar" style={{ '--bar-height': `${(total / yMax) * 100}%` } as CSSProperties}>
                    {d.unassessedCount > 0 && <div className="stacked-segment" style={{ flex: d.unassessedCount, background: SEG_COLORS.unassessed }} />}
                    {d.lowCount > 0 && <div className="stacked-segment" style={{ flex: d.lowCount, background: SEG_COLORS.low }} />}
                    {d.highCount > 0 && <div className="stacked-segment" style={{ flex: d.highCount, background: SEG_COLORS.high }} />}
                    {total > 0 && (
                      <div className="stacked-bar-tooltip">
                        <div>높음 {d.highCount}건</div>
                        <div>낮음 {d.lowCount}건</div>
                        <div>미평가 {d.unassessedCount}건</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="dashboard-x-labels">
        {data.map(d => <span className="dashboard-x-label" key={d.key}>{d.label}</span>)}
      </div>
    </div>
  );
};

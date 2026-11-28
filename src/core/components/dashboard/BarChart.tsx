// 대시보드 화면 조각(P2-85a, Phase 2 C9 구간 A) — Dashboard.tsx에서 선언 본문 그대로 옮겼다(바뀐 것은 export와 import뿐).
// 수제 막대 차트(등록·평가 환자 수).
import type { CSSProperties, ReactNode } from 'react';

export interface BarDatum {
  key: string;
  label: string;
  count: number;
}

export interface BarChartProps {
  data: BarDatum[];
  color: string;
  title: ReactNode;
  caption: ReactNode;
}

export const BarChart = ({ data, color, title, caption }: BarChartProps) => {
  const gridSteps = 5;
  const yMax = Math.ceil(Math.max(...data.map(m => m.count), 5) / gridSteps) * gridSteps;
  const step = yMax / gridSteps;

  return (
    <div className="dashboard-section pattern-surface">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-title">{title}</div>
        <div className="dashboard-section-caption">{caption}</div>
      </div>
      <div className="dashboard-chart-area">
        <div className="dashboard-y-axis">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <span className="dashboard-y-label" key={i}>{yMax - i * step}</span>
          ))}
        </div>
        <div className="dashboard-chart-body">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <div className="dashboard-grid-line" key={i} style={{ '--line-top': `${(i / gridSteps) * 100}%` } as CSSProperties} />
          ))}
          <div className="dashboard-bars">
            {data.map(m => (
              <div className="dashboard-bar-wrapper" key={m.key}>
                {m.count > 0 && <span className="dashboard-bar-label">{m.count}</span>}
                <div className="dashboard-bar" style={{ '--bar-height': `${(m.count / yMax) * 100}%`, '--bar-color': color } as CSSProperties}>
                  {m.count > 0 && <span className="dashboard-bar-tooltip">{m.count}건</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="dashboard-x-labels">
        {data.map(m => <span className="dashboard-x-label" key={m.key}>{m.label}</span>)}
      </div>
    </div>
  );
};

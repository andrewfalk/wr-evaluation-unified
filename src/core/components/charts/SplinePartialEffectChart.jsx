import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { ACCENT } from './palette';
import { formatNumber } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';

const HEIGHT = 240;
const MARGIN = { top: 16, right: 20, bottom: 28, left: 52 };

// PR4-A2 §5 "SplinePartialEffectChart.jsx" — line + CI band. ScatterPlot의
// fitLine(직선 전용)은 재사용할 수 없어(§계획 근거) 신규 primitive로 만든다.
// scales.js의 순수 함수만 재사용한다("순수 함수 원칙" 유지). CI가 없는 점(추론
// 보류 등)은 그 점만 band에서 빠진다 — delta 자체가 null인 점은 곡선에서도
// 끊긴다(개별 실패 격리 원칙).
export function SplinePartialEffectChart({ effect, label, exponentiated = false }) {
  if (!effect || !effect.points || effect.points.length === 0) return <SuppressionNotice />;

  const valueOf = (p) => (exponentiated ? p.exponentiated?.estimate : p.deltaFromBaseline);
  const ciOf = (p) => {
    if (exponentiated) {
      if (!p.exponentiated) return null;
      const { ciLower, ciUpper } = p.exponentiated;
      return ciLower !== null && ciUpper !== null ? [ciLower, ciUpper] : null;
    }
    return p.ciLower !== null && p.ciUpper !== null ? [p.ciLower, p.ciUpper] : null;
  };

  const plottable = effect.points.filter((p) => Number.isFinite(valueOf(p)));
  if (plottable.length === 0) return <SuppressionNotice />;

  const xs = effect.points.map((p) => p.x);
  const values = plottable.map(valueOf);
  const ciValues = plottable.flatMap((p) => ciOf(p) || []);
  const allY = [...values, ...ciValues, exponentiated ? 1 : 0]; // 기준선 포함
  const xDomain = [Math.min(...xs), Math.max(...xs)];
  const yDomain = [Math.min(...allY), Math.max(...allY)];

  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const xScale = createLinearScale(xDomain, [0, innerWidth]);
  const yScale = createLinearScale(yDomain, [innerHeight, 0]);
  const xTicks = computeNiceTicks(xDomain[0], xDomain[1], 5);
  const yTicks = computeNiceTicks(yDomain[0], yDomain[1], 4);
  const digits = exponentiated ? 2 : 3;

  // 연속 구간(끊김 없는 부분)별로 line/band path를 따로 만든다 — null(계산
  // 실패) 점에서 끊는다.
  const segments = [];
  let current = [];
  for (const p of effect.points) {
    const v = valueOf(p);
    if (Number.isFinite(v)) current.push(p);
    else if (current.length > 0) { segments.push(current); current = []; }
  }
  if (current.length > 0) segments.push(current);

  const linePathFor = (seg) => seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.x)},${yScale(valueOf(p))}`).join(' ');
  // CI가 없는 점을 건너뛰고 남은 점끼리 잇는 것이 아니라, CI가 연속으로 존재하는
  // 구간(run)만 각각 따로 band로 그린다 — 그렇지 않으면 CI가 끊긴 구간까지
  // 신뢰구간이 이어진 것처럼 보인다(리뷰 지적, 예: 5점 중 가운데 CI만 null이면
  // band가 양옆 2구간으로 나뉘어야 한다).
  const ciRunsOf = (seg) => {
    const runs = [];
    let current = [];
    for (const p of seg) {
      if (ciOf(p)) current.push(p);
      else if (current.length > 0) { runs.push(current); current = []; }
    }
    if (current.length > 0) runs.push(current);
    return runs;
  };
  const bandPathFor = (run) => {
    if (run.length < 2) return null;
    const top = run.map((p) => `${xScale(p.x)},${yScale(ciOf(p)[1])}`).join(' L');
    const bottom = [...run].reverse().map((p) => `${xScale(p.x)},${yScale(ciOf(p)[0])}`).join(' L');
    return `M${top} L${bottom} Z`;
  };

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel={`${label} 부분효과 곡선`}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
              {formatNumber(t, digits)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x-${t}`} x={xScale(t)} y={innerHeight + 20} textAnchor="middle" className="chart-axis-label">
            {formatNumber(t, 1)}
          </text>
        ))}
        <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} className="chart-axis-line" />
        <line x1={0} x2={0} y1={0} y2={innerHeight} className="chart-axis-line" />
        {/* 기준선(baseline 대비 0, 또는 OR=1) */}
        <line x1={0} x2={innerWidth} y1={yScale(exponentiated ? 1 : 0)} y2={yScale(exponentiated ? 1 : 0)} className="chart-axis-line" strokeDasharray="4 3" />
        {segments.map((seg, i) => (
          <g key={i}>
            {ciRunsOf(seg).map((run, j) => {
              const bandPath = bandPathFor(run);
              return bandPath ? <path key={j} d={bandPath} fill={ACCENT} fillOpacity={0.15} stroke="none" /> : null;
            })}
            <path d={linePathFor(seg)} fill="none" stroke={ACCENT} strokeWidth={2} />
          </g>
        ))}
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>x</th><th>{exponentiated ? 'OR' : 'baseline 대비 값'}</th><th>95% CI</th></tr></thead>
      <tbody>
        {effect.points.map((p, i) => {
          const v = valueOf(p);
          const ci = ciOf(p);
          return (
            <tr key={i}>
              <td>{formatNumber(p.x, 2)}</td>
              <td>{Number.isFinite(v) ? formatNumber(v, digits) : '—'}</td>
              <td>{ci ? `[${formatNumber(ci[0], digits)}, ${formatNumber(ci[1], digits)}]` : '(비공개 또는 계산 불가)'}</td>
            </tr>
          );
        })}
      </tbody>
    </>
  );

  return (
    <div>
      <p className="swb-card-subtitle">{label}{exponentiated ? ' — baseline 대비 OR' : ' — baseline 대비 선형예측자 변화'}</p>
      <DataTableView chart={chart} table={table} tableCaption={`${label} 부분효과 데이터`} />
    </div>
  );
}

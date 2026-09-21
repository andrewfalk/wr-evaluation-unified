import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { ACCENT } from './palette';
import { formatNumber } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const ROW_HEIGHT = 24;
const ROW_GAP = 12;
const MARGIN = { top: 24, right: 40, bottom: 8, left: 140 };
const WHISKER_CAP_HALF = 6;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// PR4-A1 §5 "ForestPlot.jsx" — HorizontalBarChart의 좌측 라벨 거터 + 행 반복
// 구조에, 막대 대신 BoxPlot의 whisker 캡(CI) + 점추정 circle을 얹는다.
// exponentiated(OR)는 로그축으로 그린다 — scales.js에 createLogScale을
// 추가하는 대신(scales.js는 "순수 함수" 원칙 유지) 호출부에서 Math.log()한
// 도메인을 createLinearScale에 넘기고 tick 라벨만 Math.exp()로 되돌린다.
// 축 도메인에는 유한한 값만 넣는다 — OR이 0·∞·null이거나 CI가 보류된 항은
// 축 계산에서 빼고 점추정만 찍거나(CI 없음) 표에서만 보인다(오버플로 초과).
// 유의성을 색으로 표시하지 않는다(palette.js — 상태색은 계열 색으로 재사용 금지).
export function ForestPlot({ terms, exponentiated = false }) {
  // 절편은 forest plot 관례상 제외한다(계수표에는 그대로 남는다 — 호출자 책임).
  const rows = (terms || []).filter((t) => t.variableKey !== null);
  if (rows.length === 0) return <SuppressionNotice />;

  const toScale = (v) => (exponentiated ? Math.log(v) : v);
  const fromScale = (v) => (exponentiated ? Math.exp(v) : v);

  function pointOf(t) {
    const v = exponentiated ? t.exponentiated?.estimate : t.estimate;
    return isFiniteNum(v) && (!exponentiated || v > 0) ? v : null;
  }
  function ciOf(t) {
    const lo = exponentiated ? t.exponentiated?.ciLower : t.ciLower;
    const hi = exponentiated ? t.exponentiated?.ciUpper : t.ciUpper;
    if (!isFiniteNum(lo) || !isFiniteNum(hi)) return null;
    if (exponentiated && (lo <= 0 || hi <= 0)) return null;
    return [lo, hi];
  }

  const domainValues = [0]; // 기준선(β=0 / OR=1, 로그공간에서 log(1)=0)을 항상 포함
  for (const t of rows) {
    const point = pointOf(t);
    if (point !== null) domainValues.push(toScale(point));
    const ci = ciOf(t);
    if (ci) { domainValues.push(toScale(ci[0])); domainValues.push(toScale(ci[1])); }
  }
  const hasAnyPlottable = domainValues.length > 1;
  const domainMin = Math.min(...domainValues);
  const domainMax = Math.max(...domainValues);

  const rowsHeight = rows.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP;
  const height = MARGIN.top + MARGIN.bottom + rowsHeight;
  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const xScale = createLinearScale([domainMin, domainMax], [0, innerWidth]);
  const ticks = hasAnyPlottable ? computeNiceTicks(domainMin, domainMax, 4) : [];
  const digits = exponentiated ? 2 : 3;

  const chart = (
    <ChartContainer height={height} ariaLabel="forest plot">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={xScale(t)} x2={xScale(t)} y1={-8} y2={rowsHeight} className="chart-gridline" />
            <text x={xScale(t)} y={-12} textAnchor="middle" className="chart-axis-label">
              {formatNumber(fromScale(t), digits)}
            </text>
          </g>
        ))}
        {hasAnyPlottable && (
          <line x1={xScale(0)} x2={xScale(0)} y1={0} y2={rowsHeight} className="chart-axis-line" />
        )}
        {rows.map((t, i) => {
          const y = i * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
          const point = pointOf(t);
          const ci = ciOf(t);
          const rowLabel = t.level ? `${t.label}: ${t.level}` : t.label;
          return (
            <g key={t.name}>
              <text x={-8} y={y} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
                {rowLabel}
              </text>
              {point === null && (
                <text x={4} y={y} dominantBaseline="middle" className="chart-value-label">축 범위 초과</text>
              )}
              {point !== null && ci && (
                <ChartTooltip
                  label={`${rowLabel}: ${formatNumber(point, digits)} [${formatNumber(ci[0], digits)}, ${formatNumber(ci[1], digits)}]`}
                  anchorX={xScale(toScale(point))} anchorY={y}
                  placement={chooseTooltipPlacement(y, MARGIN.top)}
                >
                  <g>
                    <line x1={xScale(toScale(ci[0]))} x2={xScale(toScale(ci[0]))} y1={y - WHISKER_CAP_HALF} y2={y + WHISKER_CAP_HALF} className="chart-axis-line" />
                    <line x1={xScale(toScale(ci[1]))} x2={xScale(toScale(ci[1]))} y1={y - WHISKER_CAP_HALF} y2={y + WHISKER_CAP_HALF} className="chart-axis-line" />
                    <line x1={xScale(toScale(ci[0]))} x2={xScale(toScale(ci[1]))} y1={y} y2={y} className="chart-axis-line" />
                    <circle cx={xScale(toScale(point))} cy={y} r={4} fill={ACCENT} />
                  </g>
                </ChartTooltip>
              )}
              {point !== null && !ci && (
                <ChartTooltip
                  label={`${rowLabel}: ${formatNumber(point, digits)} (신뢰구간 비공개)`}
                  anchorX={xScale(toScale(point))} anchorY={y}
                  placement={chooseTooltipPlacement(y, MARGIN.top)}
                >
                  <circle cx={xScale(toScale(point))} cy={y} r={4} fill={ACCENT} />
                </ChartTooltip>
              )}
            </g>
          );
        })}
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>변수</th><th>{exponentiated ? 'OR' : '계수'}</th><th>95% CI</th></tr></thead>
      <tbody>
        {rows.map((t) => {
          const point = pointOf(t);
          const ci = ciOf(t);
          const rowLabel = t.level ? `${t.label}: ${t.level}` : t.label;
          return (
            <tr key={t.name}>
              <td>{rowLabel}</td>
              <td>{point === null ? '—' : formatNumber(point, digits)}</td>
              <td>{ci ? `[${formatNumber(ci[0], digits)}, ${formatNumber(ci[1], digits)}]` : '(비공개)'}</td>
            </tr>
          );
        })}
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="forest plot 데이터" />;
}

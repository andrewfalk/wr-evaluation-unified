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
// PR4-A2 — 표준화된 predictor의 주효과 계수는 "원 단위 1 증가당"이 아니라 "1 SD
// 증가당" 효과라 단위가 다르다(variableKey로 판정).
function isStandardizedMainTerm(t, standardizedKeys) {
  return Boolean(t.variableKey) && standardizedKeys.length > 0 && standardizedKeys.includes(t.variableKey);
}

// PR4-A2(리뷰 후 수정) — interaction 계수(β₁₂)는 "1 SD당 효과"로 해석할 수 없다
// (β₁z₁+β₂z₂+β₁₂z₁z₂에서 z₁의 한계효과는 β₁+β₁₂z₂이지 β₁₂ 단독이 아니다). 그래서
// 이전처럼 참여 변수 중 하나라도 표준화됐다고 전체에 "(표준화, 1 SD당)"을 붙이면
// 해석이 틀린다(리뷰 지적) — 대신 각 변수가 어떤 척도로 곱해졌는지(z-score vs 원
// 단위)만 병기한다. 표준화가 전혀 쓰이지 않은 모형(standardizedKeys 빈 배열)에서는
// 굳이 표시하지 않는다.
function interactionScaleNote(interactionOf, standardizedKeys, labelOf) {
  if (!interactionOf || standardizedKeys.length === 0) return null;
  const describe = (key) => `${labelOf(key)}(${standardizedKeys.includes(key) ? 'z-score' : '원 단위'})`;
  return `${describe(interactionOf[0])} × ${describe(interactionOf[1])}`;
}

export function ForestPlot({ terms, exponentiated = false, standardizedPredictorKeys = [], variableLabelOf = (k) => k }) {
  // 절편은 forest plot 관례상 제외한다(계수표에는 그대로 남는다 — 호출자 책임).
  // PR4-A2 — spline 기저 항(β_ns1..β_ns4)도 제외한다(SplinePartialEffectChart로
  // 대체 표시 — 의미 없는 계수 나열은 해석 불가능하다). interaction 항은
  // variableKey가 null이지만(두 predictor에 걸침, interactionOf 참고) 제외
  // 대상이 아니므로 "절편 이름"으로 걸러야 한다 — variableKey!==null 기준은
  // interaction 항까지 함께 잘라낸다.
  const rows = (terms || []).filter((t) => t.name !== 'intercept' && t.termType !== 'spline_basis');
  if (rows.length === 0) return <SuppressionNotice />;

  const rowLabelOf = (t) => {
    const base = t.level ? `${t.label}: ${t.level}` : t.label;
    if (t.termType === 'interaction') {
      const note = interactionScaleNote(t.interactionOf, standardizedPredictorKeys, variableLabelOf);
      return note ? `${base} — ${note}` : base;
    }
    return isStandardizedMainTerm(t, standardizedPredictorKeys) ? `${base} (표준화, 1 SD당)` : base;
  };

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
          const rowLabel = rowLabelOf(t);
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
          const rowLabel = rowLabelOf(t);
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

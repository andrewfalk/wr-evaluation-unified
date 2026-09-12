// PR3-B 계획서 §6.8.6 — 반응형 SVG: viewBox 고정 + width="100%"로 CSS가 실제 렌더
// 크기를 결정한다(ResizeObserver·JS 리사이즈 측정 불필요 — Win7 호환).
export const CHART_VIEW_WIDTH = 560;

export function ChartContainer({ height, children, ariaLabel }) {
  return (
    <div className="chart-container">
      <svg
        viewBox={`0 0 ${CHART_VIEW_WIDTH} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
      >
        {children}
      </svg>
    </div>
  );
}

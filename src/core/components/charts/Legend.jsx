// PR3-B 계획서 §6.8.5 — 2계열 이상이면 범례 필수.
export function Legend({ items }) {
  if (!items || items.length < 2) return null;
  return (
    <ul className="chart-legend" aria-label="범례">
      {items.map((item) => (
        <li key={item.label} className="chart-legend-item">
          <span className="chart-legend-swatch" style={{ backgroundColor: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

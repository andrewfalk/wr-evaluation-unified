// 대시보드 화면 조각(P2-85a, Phase 2 C9 구간 A) — Dashboard.tsx에서 선언 본문 그대로 옮겼다(바뀐 것은 export와 import뿐).
// 성별 비율 도넛(SVG).
export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export const GenderDonut = ({ segments }: { segments: DonutSegment[] }) => {
  const size = 130;
  const stroke = 26;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  const cx = size / 2;
  const cy = size / 2;
  const midRadius = radius;
  const pad = 8;
  const vbSize = size + pad * 2;

  return (
    <div className="gender-donut">
      <svg
        width={vbSize} height={vbSize}
        viewBox={`${-pad} ${-pad} ${vbSize} ${vbSize}`}
        style={{ overflow: 'visible' }}
        role="img" aria-label="성별 비율"
      >
        <circle
          cx={cx} cy={cy} r={radius}
          fill="none" stroke="var(--bg-secondary, #f5f5f5)" strokeWidth={stroke}
        />
        {total > 0 && segments.map(s => {
          if (s.value <= 0) return null;
          const length = (s.value / total) * circumference;
          const dash = `${length} ${circumference - length}`;
          const dashOffset = -offset;
          offset += length;
          return (
            <circle
              key={s.key}
              cx={cx} cy={cy} r={radius}
              fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={dash} strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
        {total > 0 && (() => {
          let segStart = 0;
          return segments.map(s => {
            if (s.value <= 0) return null;
            const angleSpan = (s.value / total) * 2 * Math.PI;
            const midAngle = -Math.PI / 2 + segStart + angleSpan / 2;
            segStart += angleSpan;
            const lx = cx + Math.cos(midAngle) * midRadius;
            const ly = cy + Math.sin(midAngle) * midRadius;
            const pct = Math.round((s.value / total) * 100);
            return (
              <text
                key={s.key}
                x={lx} y={ly}
                textAnchor="middle" dominantBaseline="central"
                className="gender-donut-seg-label"
              >
                {s.label} {pct}%
              </text>
            );
          });
        })()}
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
              className="gender-donut-center">{total}</text>
      </svg>
    </div>
  );
};

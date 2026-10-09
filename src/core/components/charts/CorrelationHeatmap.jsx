import { divergingColor } from './palette';
import { formatPValue, formatStat } from './numberFormat';
import { DataTableView } from './DataTableView';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const CELL_SIZE = 48;
const MARGIN = { top: 96, right: 16, bottom: 16, left: 150 };

function pairKey(a, b) {
  return `${a}::${b}`;
}

// 제한데이터 권한자 해제본에만 오는 억제 셀 사유(cell.reasonCode) — 소수 인원 보호가 풀린 뒤에도 셀이 비어 있는 통계적 이유.
// 일반 응답의 억제 셀에는 reasonCode가 없다(소수 인원 때문인지 통계 불가인지 구분되지 않아야 한다).
const UNAVAILABLE_REASON_LABELS = {
  REPEATED_MEASURES_NOT_ALIGNED: '반복측정(한 사람이 여러 사례)이라 일반 상관검정을 쓸 수 없음',
  NOT_COMPUTABLE: '표본 부족·값이 모두 같음 등으로 계산할 수 없음',
};

// PR3-B 계획서 §4/§6.8.2/§6.8.3 — 상관행렬 히트맵(발산형). suppressed 셀은 값
// 대신 "×"만 표시(불투명 억제, 일반 응답에는 사유 노출 없음).
export function CorrelationHeatmap({ variableKeys, cells, labelOf }) {
  const n = variableKeys.length;
  const cellByPair = new Map(cells.map((c) => [pairKey(c.xKey, c.yKey), c]));
  const size = n * CELL_SIZE;
  const width = MARGIN.left + size + MARGIN.right;
  const height = MARGIN.top + size + MARGIN.bottom;

  function cellFor(i, j) {
    if (i === j) return null;
    const a = variableKeys[Math.min(i, j)];
    const b = variableKeys[Math.max(i, j)];
    return cellByPair.get(pairKey(a, b));
  }

  const chart = (
    <div className="chart-container">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%" height={height}
        preserveAspectRatio="xMidYMid meet"
        role="img" aria-label="상관행렬 히트맵"
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {variableKeys.map((key, i) => (
            <text
              key={`col-${key}`}
              x={i * CELL_SIZE + CELL_SIZE / 2} y={-8}
              textAnchor="start"
              transform={`rotate(-40 ${i * CELL_SIZE + CELL_SIZE / 2} -8)`}
              className="chart-axis-label"
            >
              {labelOf(key)}
            </text>
          ))}
          {variableKeys.map((key, j) => (
            <text
              key={`row-${key}`}
              x={-8} y={j * CELL_SIZE + CELL_SIZE / 2}
              textAnchor="end" dominantBaseline="middle"
              className="chart-axis-label"
            >
              {labelOf(key)}
            </text>
          ))}
          {variableKeys.map((_, i) => variableKeys.map((__, j) => {
            const cell = cellFor(i, j);
            const isDiagonal = i === j;
            const fill = isDiagonal ? 'var(--chart-diagonal-fill)' : (cell && !cell.suppressed ? divergingColor(cell.r) : 'var(--chart-suppressed-fill)');
            const cx = i * CELL_SIZE + CELL_SIZE / 2;
            const cy = j * CELL_SIZE + CELL_SIZE / 2;
            const cellBody = (
              <g>
                <rect x={i * CELL_SIZE} y={j * CELL_SIZE} width={CELL_SIZE - 2} height={CELL_SIZE - 2} fill={fill} />
                {!isDiagonal && cell && !cell.suppressed && (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" className="chart-heatmap-value">
                    {cell.r.toFixed(2)}
                  </text>
                )}
                {!isDiagonal && (!cell || cell.suppressed) && (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" className="chart-heatmap-suppressed">
                    ×
                  </text>
                )}
              </g>
            );
            if (isDiagonal) return <g key={`${i}-${j}`}>{cellBody}</g>;
            const label = cell && !cell.suppressed
              ? `${labelOf(cell.xKey)} × ${labelOf(cell.yKey)} — r=${formatStat(cell.r)}, p=${formatPValue(cell.pValue)}${cell.adjustedP === null ? '' : `, 보정p=${formatPValue(cell.adjustedP)}`}`
              : `${labelOf((cell || {}).xKey ?? variableKeys[Math.min(i, j)])} × ${labelOf((cell || {}).yKey ?? variableKeys[Math.max(i, j)])} — ${
                cell && UNAVAILABLE_REASON_LABELS[cell.reasonCode]
                  ? `소수 인원 보호는 해제됐지만 ${UNAVAILABLE_REASON_LABELS[cell.reasonCode]}`
                  : '공개 정책에 따라 표시되지 않음'
              }`;
            // MARGIN.top(96)이 항상 여유(26px)보다 훨씬 커서 실제로 뒤집힐 일은
            // 없지만, 다른 차트와 같은 방식으로 통일해 margin이 나중에 바뀌어도
            // 안전하게 만든다(코드리뷰가 지적한 클래스의 버그를 전 차트에서 동일 처리).
            const placement = chooseTooltipPlacement(j * CELL_SIZE, MARGIN.top);
            return (
              <ChartTooltip key={`${i}-${j}`} label={label} anchorX={cx} anchorY={j * CELL_SIZE} placement={placement}>
                {cellBody}
              </ChartTooltip>
            );
          }))}
        </g>
      </svg>
    </div>
  );

  const table = (
    <>
      <thead><tr><th>변수1</th><th>변수2</th><th>r</th><th>p값</th><th>보정 p값</th></tr></thead>
      <tbody>
        {cells.map((c) => (
          <tr key={pairKey(c.xKey, c.yKey)}>
            <td>{labelOf(c.xKey)}</td>
            <td>{labelOf(c.yKey)}</td>
            <td>{c.suppressed ? (c.reasonCode ? '(계산 불가)' : '(비공개)') : formatStat(c.r)}</td>
            <td>{c.suppressed ? (c.reasonCode ? '(계산 불가)' : '(비공개)') : formatPValue(c.pValue)}</td>
            <td>{c.suppressed ? (c.reasonCode ? '(계산 불가)' : '(비공개)') : (c.adjustedP === null ? '(비공개)' : formatPValue(c.adjustedP))}</td>
          </tr>
        ))}
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="상관행렬 데이터" />;
}

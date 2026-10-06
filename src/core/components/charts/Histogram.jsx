import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { ACCENT } from './palette';
import { formatInt, formatNumber } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';
import { ChartTooltip, chooseTooltipPlacement } from './ChartTooltip';

const HEIGHT = 220;
// 세로축 제목("구간별 관측 건수")을 회전해 넣을 자리만큼 왼쪽 여백을 넓혔다(44→56).
const MARGIN = { top: 12, right: 16, bottom: 26, left: 56 };

const TAIL_MERGED_NOTE = '인원이 적은 양 끝 구간은 인접 구간과 합쳐 표시했습니다(구간 폭이 다름).';
const RAW_HISTOGRAM_NOTE = '제한 데이터 권한으로 소수 인원 구간까지 표시합니다. 화면을 외부에 공유할 때 주의하세요.';

function binLabel(b) {
  const range = `${formatNumber(b.lower)} ~ ${formatNumber(b.upper)}`;
  const merged = b.tailMerged ? ` (병합 구간, 폭 ${formatNumber(b.upper - b.lower)})` : '';
  return `${range}${merged}: ${b.count}건`;
}

// B안(A안 후속) — histogram이 null이어도 이유가 두 가지로 나뉜다: n=0 등 애초에
// 히스토그램이 없던 경우(기존 기본 문구)와, 적응형 해상도 축소가 후보를 전부
// 시도해도 공개 가능한 해상도를 못 찾은 경우(histogramReasonCode==='INSUFFICIENT_
// DISCLOSABLE_RESOLUTION', 전용 문구). histogram이 있고 merged===true면 원본보다
// 구간 수를 줄여 재분할했다는 안내를 차트 아래에 덧붙인다(정확한 원본 개수는
// 일부러 밝히지 않음 — server/src/statsChartDisclosure.ts 주석 참고). 경계
// 포함규칙은 서버(buildOriginalHistogram, numpy.histogram과 동일)와 같다 — 마지막 bin만 양끝 포함.
//
// 끝 구간 병합 — bin.tailMerged인 막대는 옅은 면+점선 테두리로 구분하고, 막대
// 높이는 다른 막대와 같은 "구간별 관측 건수"다(폭이 넓어 면적이 커 보일 수 있어
// 세로축 제목·툴팁·표에 폭을 밝힌다). rawHistogram(제한 데이터 권한자에게만 오는
// 원본)이 있으면 그것을 우선 쓰고, 그래프·표·툴팁 모두 같은 선택값을 쓴다.
export function Histogram({ histogram, rawHistogram, histogramReasonCode }) {
  const shown = rawHistogram ?? histogram;
  const isRaw = !!rawHistogram;
  if (!shown) {
    return histogramReasonCode === 'INSUFFICIENT_DISCLOSABLE_RESOLUTION'
      ? <SuppressionNotice>분포를 표시하기에는 공개 가능한 구간이 부족합니다.</SuppressionNotice>
      : <SuppressionNotice />;
  }
  const { bins, merged } = shown;
  if (bins.length === 0) return <p className="swb-suppressed-note">자료 없음</p>;
  const anyTailMerged = bins.some((b) => b.tailMerged);

  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const isSingleConstant = bins.length === 1 && bins[0].lower === bins[0].upper;
  const xScale = createLinearScale(
    isSingleConstant ? [0, 1] : [bins[0].lower, bins[bins.length - 1].upper],
    [0, innerWidth],
  );
  const yScale = createLinearScale([0, maxCount], [innerHeight, 0]);
  const yTicks = computeNiceTicks(0, maxCount, 4);
  // 가독성 개선 — 다른 차트(ScatterPlot 등)는 x축 숫자 눈금이 있는데 히스토그램만
  // 없어서, 구간 경계를 마우스오버 툴팁 없이는 전혀 읽을 수 없었다. 단일값(bin이
  // 하나뿐이고 lower===upper)은 실제 도메인이 [0,1] placeholder라 계산눈금이 의미
  // 없으므로, 그 실제 값 하나만 중앙에 표시한다.
  const xTicks = isSingleConstant
    ? [{ pos: innerWidth / 2, label: formatNumber(bins[0].lower) }]
    : computeNiceTicks(bins[0].lower, bins[bins.length - 1].upper, 5)
        .filter((t) => t >= bins[0].lower && t <= bins[bins.length - 1].upper)
        .map((t) => ({ pos: xScale(t), label: formatNumber(t) }));

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel="히스토그램">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        <text
          transform={`translate(${-MARGIN.left + 10},${innerHeight / 2}) rotate(-90)`}
          textAnchor="middle"
          className="chart-axis-title"
        >
          구간별 관측 건수
        </text>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">
              {formatInt(t)}
            </text>
          </g>
        ))}
        {bins.map((b, i) => {
          const x0 = isSingleConstant ? 0 : xScale(b.lower);
          const x1 = isSingleConstant ? innerWidth : xScale(b.upper);
          const barWidth = Math.max(x1 - x0 - 1, 1);
          const barHeight = Math.max(innerHeight - yScale(b.count), 0);
          const label = binLabel(b);
          // 코드리뷰 수정 — 최고 막대(yScale(count)===0)는 차트 맨 위와 맞닿아
          // 있어 말풍선을 위쪽에 그리면 SVG viewBox 밖으로 잘린다(실측 확인:
          // MARGIN.top=12+0<26). 그럴 땐 아래로 뒤집는다.
          const placement = chooseTooltipPlacement(yScale(b.count), MARGIN.top);
          return (
            <ChartTooltip key={i} label={label} anchorX={x0 + barWidth / 2} anchorY={yScale(b.count)} placement={placement}>
              {b.tailMerged ? (
                <rect x={x0} y={yScale(b.count)} width={barWidth} height={barHeight} className="chart-bar-merged">
                  <title>{label}</title>
                </rect>
              ) : (
                <rect x={x0} y={yScale(b.count)} width={barWidth} height={barHeight} fill={ACCENT}>
                  <title>{label}</title>
                </rect>
              )}
            </ChartTooltip>
          );
        })}
        <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} className="chart-axis-line" />
        {xTicks.map((t, i) => (
          <text key={`x-${i}`} x={t.pos} y={innerHeight + 16} textAnchor="middle" className="chart-axis-label">
            {t.label}
          </text>
        ))}
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>구간</th><th>관측 건수</th></tr></thead>
      <tbody>
        {bins.map((b, i) => (
          <tr key={i}>
            <td>
              {formatNumber(b.lower)} ~ {formatNumber(b.upper)}{i === bins.length - 1 ? '(포함)' : ' 미만'}
              {b.tailMerged && <span className="swb-hist-merged-tag">병합 · 폭 {formatNumber(b.upper - b.lower)}</span>}
            </td>
            <td>{b.count}</td>
          </tr>
        ))}
      </tbody>
    </>
  );

  return (
    <>
      <DataTableView chart={chart} table={table} tableCaption="히스토그램 데이터" />
      {isRaw && <p className="swb-suppressed-note">{RAW_HISTOGRAM_NOTE}</p>}
      {!isRaw && merged && <p className="swb-suppressed-note">공개 기준에 맞춰 구간 수를 줄여 표시했습니다.</p>}
      {!isRaw && anyTailMerged && <p className="swb-suppressed-note">{TAIL_MERGED_NOTE}</p>}
    </>
  );
}

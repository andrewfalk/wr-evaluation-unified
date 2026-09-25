import { ChartContainer, CHART_VIEW_WIDTH } from './ChartContainer';
import { createLinearScale, computeNiceTicks } from './scales';
import { ACCENT } from './palette';
import { formatNumber, formatInt } from './numberFormat';
import { DataTableView } from './DataTableView';
import { SuppressionNotice } from './SuppressionNotice';

const HEIGHT = 240;
const MARGIN = { top: 16, right: 20, bottom: 28, left: 44 };
const UNIT_DOMAIN = [0, 1];
const UNIT_TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1];

// PR4-B2 §6단계 "charts/CurveChart.jsx" — SplinePartialEffectChart.jsx 패턴을
// 그대로 따른다(ChartContainer+scales.js 순수함수+DataTableView). curves.bins는
// 계획서 §5단계 "곡선 공개통제"가 만든 공개 가능 구간만 담는다 — person 단위
// 수치는 절대 없다({upperThreshold, rows, positiveRows, meanPredicted,
// observedRate}뿐). ROC는 이 구간별 합계(rows/positiveRows)를 임계값 내림차순
// 누적해 만든 계단형 근사다 — bins 자체가 이미 구간화됐으므로 반복 1 AUC(지표
// 표에 별도로 나온다)와 이 곡선의 면적이 다를 수 있다(계획서 §5 화면 문구).
function buildRocPoints(bins) {
  const totalPositives = bins.reduce((acc, b) => acc + b.positiveRows, 0);
  const totalNegatives = bins.reduce((acc, b) => acc + (b.rows - b.positiveRows), 0);
  if (totalPositives === 0 || totalNegatives === 0) return null;

  // 임계값 내림차순 — p가 높은 구간부터 "양성으로 분류"에 포함시켜 나간다.
  const sorted = [...bins].sort((a, b) => b.upperThreshold - a.upperThreshold);
  let cumPositives = 0;
  let cumNegatives = 0;
  const points = [{ fpr: 0, tpr: 0 }];
  for (const bin of sorted) {
    cumPositives += bin.positiveRows;
    cumNegatives += bin.rows - bin.positiveRows;
    points.push({ fpr: cumNegatives / totalNegatives, tpr: cumPositives / totalPositives });
  }
  return points;
}

function RocCurve({ bins }) {
  const points = buildRocPoints(bins);
  if (!points) {
    return <SuppressionNotice>이 구간 구성으로는 ROC 곡선을 계산할 수 없습니다(한쪽 사건만 존재).</SuppressionNotice>;
  }

  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const xScale = createLinearScale(UNIT_DOMAIN, [0, innerWidth]);
  const yScale = createLinearScale(UNIT_DOMAIN, [innerHeight, 0]);
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.fpr)},${yScale(p.tpr)}`).join(' ');

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel="ROC 곡선(구간화 근사)">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {UNIT_TICKS.map((t) => (
          <g key={`y-${t}`}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">{formatNumber(t, 1)}</text>
          </g>
        ))}
        {UNIT_TICKS.map((t) => (
          <text key={`x-${t}`} x={xScale(t)} y={innerHeight + 20} textAnchor="middle" className="chart-axis-label">{formatNumber(t, 1)}</text>
        ))}
        <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} className="chart-axis-line" />
        <line x1={0} x2={0} y1={0} y2={innerHeight} className="chart-axis-line" />
        {/* 무작위 분류 기준선(대각선). */}
        <line x1={xScale(0)} x2={xScale(1)} y1={yScale(0)} y2={yScale(1)} className="chart-axis-line" strokeDasharray="4 3" />
        <path d={linePath} fill="none" stroke={ACCENT} strokeWidth={2} />
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>FPR(1−특이도)</th><th>TPR(민감도)</th></tr></thead>
      <tbody>
        {points.map((p, i) => (
          <tr key={i}><td>{formatNumber(p.fpr, 3)}</td><td>{formatNumber(p.tpr, 3)}</td></tr>
        ))}
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="ROC 곡선 데이터(구간 누적)" />;
}

// 코드리뷰(2026-09-25) — 계획서 결정 #8 "ROC·PR·calibration은 하나의 공통 구간
// 분할을 공유한다"인데 PR 곡선 자체가 누락돼 있었다. ROC와 같은 누적 방식(임계값
// 내림차순)이지만 축이 다르다 — recall=TP/전체양성, precision=TP/(TP+FP).
// 코드리뷰 2차(2026-09-25) — (recall=0, precision=1) 시작점 관례를 빠뜨려서,
// 완전분리(고신뢰 구간에 양성이 전부 몰림)처럼 첫 누적점이 이미 recall=1인
// 경우 recall<1 구간 전체가 안 그려지는 반례가 재현됐다(양성 20행이 최상위
// 구간에 전부 있고 나머지 두 구간은 음성만이면 세 점이 전부 recall=1이라
// 세로선 하나만 남는다). ROC가 (0,0)을 앞에 붙이는 것과 동일한 원칙으로
// (0,1)을 항상 첫 점으로 붙인다. prevalence 기준선은 무작위 분류기의 기대
// 정밀도다.
function buildPrPoints(bins) {
  const totalPositives = bins.reduce((acc, b) => acc + b.positiveRows, 0);
  const totalRows = bins.reduce((acc, b) => acc + b.rows, 0);
  if (totalPositives === 0 || totalRows === 0) return null;

  const sorted = [...bins].sort((a, b) => b.upperThreshold - a.upperThreshold);
  let cumPositives = 0;
  let cumRows = 0;
  const points = [{ recall: 0, precision: 1 }];
  for (const bin of sorted) {
    cumPositives += bin.positiveRows;
    cumRows += bin.rows;
    points.push({ recall: cumPositives / totalPositives, precision: cumPositives / cumRows });
  }
  return { points, prevalence: totalPositives / totalRows };
}

function PrCurve({ bins }) {
  const result = buildPrPoints(bins);
  if (!result) {
    return <SuppressionNotice>이 구간 구성으로는 PR 곡선을 계산할 수 없습니다(사건 행이 없음).</SuppressionNotice>;
  }
  const { points, prevalence } = result;

  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const xScale = createLinearScale(UNIT_DOMAIN, [0, innerWidth]);
  const yScale = createLinearScale(UNIT_DOMAIN, [innerHeight, 0]);
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.recall)},${yScale(p.precision)}`).join(' ');

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel="PR 곡선(구간화 근사)">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {UNIT_TICKS.map((t) => (
          <g key={`y-${t}`}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">{formatNumber(t, 1)}</text>
          </g>
        ))}
        {UNIT_TICKS.map((t) => (
          <text key={`x-${t}`} x={xScale(t)} y={innerHeight + 20} textAnchor="middle" className="chart-axis-label">{formatNumber(t, 1)}</text>
        ))}
        <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} className="chart-axis-line" />
        <line x1={0} x2={0} y1={0} y2={innerHeight} className="chart-axis-line" />
        {/* 무작위 분류기 기준선(prevalence, 수평). */}
        <line x1={0} x2={innerWidth} y1={yScale(prevalence)} y2={yScale(prevalence)} className="chart-axis-line" strokeDasharray="4 3" />
        <path d={linePath} fill="none" stroke={ACCENT} strokeWidth={2} />
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>Recall</th><th>Precision</th></tr></thead>
      <tbody>
        {points.map((p, i) => (
          <tr key={i}><td>{formatNumber(p.recall, 3)}</td><td>{formatNumber(p.precision, 3)}</td></tr>
        ))}
        <tr><td>prevalence 기준선</td><td>{formatNumber(prevalence, 3)}</td></tr>
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="PR 곡선 데이터(구간 누적)" />;
}

// calibration 점 크기는 행 수 기준이다(계획서 §6단계) — 반지름을 rows의 제곱근에
// 비례시켜 면적이 행 수에 비례하도록 한다(원 넓이 = πr², 선형 반지름은 크기를
// 과장한다).
function calibrationRadius(rows, maxRows) {
  if (maxRows <= 0) return 3;
  return 3 + 7 * Math.sqrt(rows / maxRows);
}

function CalibrationCurve({ bins }) {
  const maxRows = Math.max(...bins.map((b) => b.rows));
  const innerWidth = CHART_VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const xScale = createLinearScale(UNIT_DOMAIN, [0, innerWidth]);
  const yScale = createLinearScale(UNIT_DOMAIN, [innerHeight, 0]);

  const chart = (
    <ChartContainer height={HEIGHT} ariaLabel="Calibration 곡선(예측확률 대 관찰비율)">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {UNIT_TICKS.map((t) => (
          <g key={`y-${t}`}>
            <line x1={0} x2={innerWidth} y1={yScale(t)} y2={yScale(t)} className="chart-gridline" />
            <text x={-8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">{formatNumber(t, 1)}</text>
          </g>
        ))}
        {UNIT_TICKS.map((t) => (
          <text key={`x-${t}`} x={xScale(t)} y={innerHeight + 20} textAnchor="middle" className="chart-axis-label">{formatNumber(t, 1)}</text>
        ))}
        <line x1={0} x2={innerWidth} y1={innerHeight} y2={innerHeight} className="chart-axis-line" />
        <line x1={0} x2={0} y1={0} y2={innerHeight} className="chart-axis-line" />
        {/* 완전 보정 기준선(y=x). */}
        <line x1={xScale(0)} x2={xScale(1)} y1={yScale(0)} y2={yScale(1)} className="chart-axis-line" strokeDasharray="4 3" />
        <path
          d={bins.map((b, i) => `${i === 0 ? 'M' : 'L'}${xScale(b.meanPredicted)},${yScale(b.observedRate)}`).join(' ')}
          fill="none" stroke={ACCENT} strokeWidth={1} strokeOpacity={0.5}
        />
        {bins.map((b, i) => (
          <circle
            key={i}
            cx={xScale(b.meanPredicted)}
            cy={yScale(b.observedRate)}
            r={calibrationRadius(b.rows, maxRows)}
            fill={ACCENT}
            fillOpacity={0.55}
          />
        ))}
      </g>
    </ChartContainer>
  );

  const table = (
    <>
      <thead><tr><th>구간 상한(p)</th><th>행 수</th><th>양성 행</th><th>평균 예측확률</th><th>관찰비율</th></tr></thead>
      <tbody>
        {bins.map((b, i) => (
          <tr key={i}>
            <td>{formatNumber(b.upperThreshold, 3)}</td>
            <td>{formatInt(b.rows)}</td>
            <td>{formatInt(b.positiveRows)}</td>
            <td>{formatNumber(b.meanPredicted, 3)}</td>
            <td>{formatNumber(b.observedRate, 3)}</td>
          </tr>
        ))}
      </tbody>
    </>
  );

  return <DataTableView chart={chart} table={table} tableCaption="Calibration 곡선 데이터" />;
}

// PR4-B2 — curves===null 또는 bins===null(억제)이면 SuppressionNotice. kind로
// ROC/PR/calibration 중 무엇을 그릴지 고른다 — 계획서 §5단계 "세 곡선(ROC·PR·
// calibration)이 공통 구간을 공유한다"의 공통 구간이 이 bins다.
export function CurveChart({ curves, kind }) {
  if (!curves || !curves.bins || curves.bins.length === 0) {
    return (
      <SuppressionNotice>
        {curves?.suppressedReason === 'MIN_DISCLOSABLE_BINS_NOT_MET'
          ? '공개 가능한 구간 수가 부족해 곡선을 표시하지 않습니다.'
          : '공개 정책에 따라 표시되지 않음(표본 크기 등).'}
      </SuppressionNotice>
    );
  }
  if (kind === 'calibration') return <CalibrationCurve bins={curves.bins} />;
  if (kind === 'pr') return <PrCurve bins={curves.bins} />;
  return <RocCurve bins={curves.bins} />;
}

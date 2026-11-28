// 기술통계 결과 카드(요약 탭 표 카드 · 분포 탭 차트 카드) — P2-78c에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다.
import { Histogram } from '../../charts/Histogram';
import { BoxPlot } from '../../charts/BoxPlot';
import { HorizontalBarChart } from '../../charts/HorizontalBarChart';
import { buildDiscreteDisplay } from '../../charts/discreteLevels';
import { formatStat } from '../../charts/numberFormat';
import { NULL_REASON_LABELS } from './labels';
import type { AnalyzeMissingPatternEntry, AnalyzeDiscreteLevel } from '@wr/contracts/stats';
import type { CatalogByKey, ContinuousRow, DiscreteRow, DiscreteDisplay } from './types';
import { variableLabel, missingPatternsText, num, fmt } from './format';

export function ContinuousCard({ catalogByKey, row }: { catalogByKey: CatalogByKey; row: ContinuousRow }) {
  if (row.suppressed) {
    return (
      <div className="swb-card">
        <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
        <p className="swb-suppressed-note">공개 정책에 따라 표시되지 않음</p>
      </div>
    );
  }
  // 5차 리뷰가 잡은 누락 — nullReasons(어떤 통계량이 왜 null인지)를 안 읽으면 "계산 불가"와
  // "값이 0"을 구분할 방법이 없다(§4.2 계약: null은 계산 불능, 값 0은 실제 0).
  const nullReasonEntries = Object.entries(row.nullReasons || {});
  return (
    <div className="swb-card">
      <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
      <table className="swb-table">
        <tbody>
          <tr><th>n</th><td>{row.n}</td><th>결측</th><td>{row.missingCount} {missingPatternsText(row.missingPatterns as AnalyzeMissingPatternEntry[] | null)}</td></tr>
          <tr><th>평균</th><td>{num(row.mean, 2)}</td><th>SD</th><td>{num(row.sd, 2)}</td></tr>
          <tr><th>중앙값</th><td>{num(row.median, 2)}</td><th>IQR</th><td>{num(row.iqr, 2)}</td></tr>
          <tr><th>Q1</th><td>{num(row.q1, 2)}</td><th>Q3</th><td>{num(row.q3, 2)}</td></tr>
          <tr><th>왜도</th><td>{formatStat(row.skewness)}</td><th>첨도</th><td>{formatStat(row.kurtosis)}</td></tr>
          <tr><th>최소</th><td>{num(row.min, 2)}</td><th>최대</th><td>{num(row.max, 2)}</td></tr>
        </tbody>
      </table>
      {nullReasonEntries.length > 0 && (
        <p className="swb-suppressed-note">
          계산 불가: {nullReasonEntries.map(([field, reason]) => `${field}(${NULL_REASON_LABELS[reason] || reason})`).join(', ')}
        </p>
      )}
    </div>
  );
}

// 범주형 소수 범주 "기타" 병합 안내 — 서버는 그 변수 하나만 요청했을 때만 합쳐 준다(다른 변수와
// 함께면 값·결측으로 "기타" 안을 쪼개 역산할 수 있어서). 그래서 변수가 2개 이상인 실행에서
// 억제된 범주형에는 "단독으로 분석하면 보일 수 있다"는 안내를 띄운다. 서버 정보는 쓰지 않고
// 레시피 변수 개수와 카탈로그 타입만 본다(순서형은 단독이어도 합치지 않으므로 제외).
// "기타"에는 10명 미만 범주뿐 아니라, 합친 값을 10명 이상으로 맞추려고 함께 합친 범주도 들어갈
// 수 있다(서버 planSmallLevelMerge) — 문구가 그 사실을 숨기지 않게 한다.
const OTHER_MERGE_NOTE = "인원이 10명 미만인 범주와, 합친 값을 10명 이상으로 맞추려고 함께 합친 범주는 '기타'로 묶어 표시했습니다.";
const RAW_LEVELS_NOTE = '제한 데이터 권한으로 소수 인원 범주까지 표시합니다. 화면을 외부에 공유할 때 주의하세요.';
const SINGLE_VARIABLE_HINT = "범주형 변수 하나만 분석하면 소수 범주를 '기타'로 합쳐 볼 수 있는 경우가 있습니다.";

function suppressedHint(catalogByKey: CatalogByKey, row: DiscreteRow, variableCount: number): string | null {
  const isOrdinal = catalogByKey.get(row.variableKey)?.type === 'ordinal';
  return variableCount > 1 && !isOrdinal ? SINGLE_VARIABLE_HINT : null;
}

export function DiscreteCard({ catalogByKey, row, variableCount }: { catalogByKey: CatalogByKey; row: DiscreteRow; variableCount: number }) {
  const isOrdinal = catalogByKey.get(row.variableKey)?.type === 'ordinal';
  const display = buildDiscreteDisplay({ levels: row.levels, other: row.other, rawLevels: row.rawLevels, isOrdinal });
  if (row.suppressed && !display.isRaw) {
    const hint = suppressedHint(catalogByKey, row, variableCount);
    return (
      <div className="swb-card">
        <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
        <p className="swb-suppressed-note">공개 정책에 따라 표시되지 않음</p>
        {hint && <p className="swb-suppressed-note">{hint}</p>}
      </div>
    );
  }
  const rawTotal = display.isRaw ? (row.rawLevels as AnalyzeDiscreteLevel[]).reduce((s, l) => s + l.count, 0) : null;
  // 원본을 표시하는 동안에는 최빈값도 원본 기준이다 — row.mode는 "기타"로 합쳐진 공개 범주 기준이라
  // 반복 기록으로 소수 범주의 건수가 더 큰 경우 표와 어긋난다(외부 리뷰 지적).
  const modeValue = display.isRaw ? (display as DiscreteDisplay).rawMode : row.mode;
  return (
    <div className="swb-card">
      <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
      {row.suppressed
        ? <p>n={rawTotal}, 최빈값={fmt(modeValue)} <span className="swb-suppressed-note">(공개 정책상 일반 사용자에게는 표시되지 않는 변수)</span></p>
        : <p>n={row.n}, 결측={row.missingCount} {missingPatternsText(row.missingPatterns as AnalyzeMissingPatternEntry[] | null)}, 최빈값={fmt(modeValue)}</p>}
      <table className="swb-table">
        <thead><tr><th>수준</th><th>빈도</th><th>비율</th></tr></thead>
        <tbody>
          {display.tableRows.map((l) => (
            <tr key={l.key} className={l.merged ? 'swb-row-merged' : undefined}>
              <td>{l.label}</td><td>{l.count}</td><td>{(l.proportion * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {display.isRaw && <p className="swb-suppressed-note">{RAW_LEVELS_NOTE}</p>}
      {display.hasOther && <p className="swb-suppressed-note">{OTHER_MERGE_NOTE}</p>}
    </div>
  );
}

// PR3-B — "분포" 탭 전용 차트 카드. summary 탭의 표 카드(ContinuousCard/
// DiscreteCard)와 데이터 원본은 같지만 표시 형식만 다르다(계획서 §6.8 "모든
// 분석 결과는 표와 그래프를 함께 낸다").
export function ContinuousDistributionCard({ catalogByKey, row }: { catalogByKey: CatalogByKey; row: ContinuousRow }) {
  if (row.suppressed) {
    return (
      <div className="swb-card">
        <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
        <p className="swb-suppressed-note">공개 정책에 따라 표시되지 않음</p>
      </div>
    );
  }
  return (
    <div className="swb-card">
      <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
      <div className="swb-section-label">히스토그램</div>
      <Histogram histogram={row.histogram} rawHistogram={row.rawHistogram} histogramReasonCode={row.histogramReasonCode} />
      <div className="swb-section-label">박스플롯</div>
      <BoxPlot boxplot={row.boxplot} />
    </div>
  );
}

export function DiscreteDistributionCard({ catalogByKey, row, variableCount }: { catalogByKey: CatalogByKey; row: DiscreteRow; variableCount: number }) {
  const isOrdinal = catalogByKey.get(row.variableKey)?.type === 'ordinal';
  const display = buildDiscreteDisplay({ levels: row.levels, other: row.other, rawLevels: row.rawLevels, isOrdinal });
  if (row.suppressed && !display.isRaw) {
    const hint = suppressedHint(catalogByKey, row, variableCount);
    return (
      <div className="swb-card">
        <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
        <p className="swb-suppressed-note">공개 정책에 따라 표시되지 않음</p>
        {hint && <p className="swb-suppressed-note">{hint}</p>}
      </div>
    );
  }
  return (
    <div className="swb-card">
      <strong>{variableLabel(catalogByKey, row.variableKey)}</strong>
      <HorizontalBarChart levels={display.chartRows} tableLevels={display.tableRows} />
      {display.isRaw && <p className="swb-suppressed-note">{RAW_LEVELS_NOTE}</p>}
      {display.hasOther && <p className="swb-suppressed-note">{OTHER_MERGE_NOTE}</p>}
    </div>
  );
}

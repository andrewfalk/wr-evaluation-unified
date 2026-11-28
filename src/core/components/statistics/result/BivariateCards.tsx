// 이변량 결과 카드(억제 · 그룹 비교 · 분할표 · 상관) — P2-78d에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다.
import { describeMethodReasonCode } from '../describeMethodReasonCode';
import { BoxPlot } from '../../charts/BoxPlot';
import { StackedBarChart100 } from '../../charts/StackedBarChart100';
import { ScatterPlot } from '../../charts/ScatterPlot';
import { formatPValue, formatStat } from '../../charts/numberFormat';
import { METHOD_LABELS } from '../labels';
import { QUALITY_FLAG_LABELS, DIRECTIONAL_GROUP_METHODS, CONTINGENCY_METHODS, GROUP_COMPARISON_METHODS } from './labels';
import type { StatsMethodId } from '@wr/contracts/stats';
import type { BivariateView, BivariateRevealed, CatalogByKey, ResultRecipeView } from './types';
import { resolveBivariateVariableLabels, fmtDf, fmtCi } from './format';

// PR3-A — 이변량 결과 카드 공통 부분(억제·제외건수·품질플래그·다중검정 라벨).
// method별로 다른 부분(GroupComparisonCard/ContingencyCard/CorrelationCard)만
// 갈라서 렌더링한다 — 응답 shape 자체는 셋 다 동일하다(statistic/df/pValue/
// effectSizes/extra), 어떤 필드를 어떻게 강조해 보여줄지만 다르다.
function BivariateSuppressedCard({ bivariate }: { bivariate: BivariateView }) {
  // 제한데이터 권한자 해제 응답에서만 unavailableReason이 온다 — 소수 인원 보호는 풀렸지만 통계적으로 계산할 수 없다는 뜻.
  const unavailable = describeMethodReasonCode(bivariate.unavailableReason);
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      {unavailable ? (
        <p className="swb-suppressed-note">소수 인원 보호가 해제됐지만 결과를 계산할 수 없습니다 — {unavailable}</p>
      ) : (
        <p className="swb-suppressed-note">공개 정책에 따라 결과가 표시되지 않음(표본 크기 등).</p>
      )}
    </div>
  );
}

function BivariateFooter({ bivariate }: { bivariate: BivariateRevealed }) {
  return (
    <>
      {bivariate.qualityFlags.length > 0 && (
        <p className="swb-status-warn">
          {bivariate.qualityFlags.map((f) => QUALITY_FLAG_LABELS[f] || f).join(' ')}
        </p>
      )}
      <p className="swb-suppressed-note">
        제외 {bivariate.excludedCaseCount}건
        {bivariate.exclusions === null
          ? '(사유별 상세는 비공개)'
          : bivariate.exclusions.length > 0
            ? `(${bivariate.exclusions.map((e) => `${e.reasonCode}:${e.count}`).join(', ')})`
            : ''}
      </p>
      {/* 계획서 §"BH-FDR/Holm 범위 정직화" — m=1 recipe라 항상 "단일 검정"으로
          정직하게 표기한다. "다중검정 보정 지원"이라고 단정하지 않는다. */}
      <p className="swb-suppressed-note">
        단일 검정(보정 없음) — raw p = adjusted p ({formatPValue(bivariate.pValue)})
      </p>
    </>
  );
}

// [코드리뷰 2026-09-12] 그룹 라벨·그룹별 n이 있어야 평균차/효과크기의 부호를
// 해석할 수 있다(계획서 §방향규칙: 차이 = 뒤 그룹 − 앞 그룹, groupBreakdown은
// 그 순서 그대로 옴). 응답에 도달했다는 것 자체가 이미 소수셀 사전검사를 통과한
// 상태라 그룹별 n을 공개해도 안전하다.
// [코드리뷰 2026-09-12 2차] "앞(기준)/뒤(비교)" 역할·방향 설명은 부호 있는
// 효과크기(mean_difference/rank_biserial)를 쓰는 2-그룹 검정에만 의미가 있다 —
// anova/kruskal_wallis(η²/ε²)는 그룹이 3개 이상일 수 있고 효과크기에 방향이
// 없으므로 그룹명·n만 보여준다.
function GroupBreakdownTable({ groupBreakdown, method }: { groupBreakdown: BivariateRevealed['groupBreakdown']; method: StatsMethodId }) {
  if (!groupBreakdown || groupBreakdown.length === 0) return null;
  const directional = DIRECTIONAL_GROUP_METHODS.has(method) && groupBreakdown.length === 2;
  return (
    <>
      <table className="swb-table">
        <thead>
          <tr>
            {directional && <th>역할</th>}
            <th>그룹</th><th>n</th>
          </tr>
        </thead>
        <tbody>
          {groupBreakdown.map((g, i) => (
            <tr key={String(g.label)}>
              {directional && <td>{i === 0 ? '앞(기준)' : '뒤(비교)'}</td>}
              <td>{String(g.label)}</td>
              <td>{g.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {directional && (
        <p className="swb-suppressed-note">
          평균차·효과크기 방향 = {String(groupBreakdown[1].label)} − {String(groupBreakdown[0].label)}
        </p>
      )}
      {/* PR3-B 계획서 §5/§6.8.2 — 연속×범주 기본 그래프(그룹별 박스플롯). boxplot이
          없는 그룹(§1 게이트 실패 등)은 각자 억제 문구만 보여준다. */}
      <div className="swb-group-boxplots">
        {groupBreakdown.map((g) => (
          <div key={String(g.label)} className="swb-group-boxplot">
            <p className="swb-card-subtitle">{String(g.label)}</p>
            <BoxPlot boxplot={g.boxplot} />
          </div>
        ))}
      </div>
    </>
  );
}

function GroupComparisonCard({ bivariate, catalogByKey, committedRecipe }: { bivariate: BivariateRevealed; catalogByKey: CatalogByKey; committedRecipe: ResultRecipeView | null }) {
  const { groupLabel, valueLabel } = resolveBivariateVariableLabels(catalogByKey, committedRecipe);
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      {(groupLabel || valueLabel) && (
        <p className="swb-card-subtitle">
          결과변수: {valueLabel || '—'} · 그룹변수: {groupLabel || '—'}
        </p>
      )}
      <GroupBreakdownTable groupBreakdown={bivariate.groupBreakdown} method={bivariate.method} />
      <table className="swb-table">
        <tbody>
          <tr><th>n</th><td>{bivariate.n}</td><th>통계량</th><td>{formatStat(bivariate.statistic)}</td></tr>
          <tr>
            <th>자유도</th>
            <td colSpan={3}>
              {typeof bivariate.df === 'object' && bivariate.df !== null
                ? `${fmtDf(bivariate.df.numerator)}, ${fmtDf(bivariate.df.denominator)}`
                : fmtDf(bivariate.df as number | null)}
            </td>
          </tr>
          <tr><th>p값</th><td colSpan={3}>{formatPValue(bivariate.pValue)}</td></tr>
          {bivariate.effectSizes.map((es) => (
            <tr key={es.name}>
              <th>{es.name}</th><td>{formatStat(es.value)}</td>
              <th>95% CI</th><td>{es.ci ? fmtCi(es.ci) : (es.ciUnavailableReason || '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <BivariateFooter bivariate={bivariate} />
    </div>
  );
}

// [코드리뷰 2026-09-12] 억제(suppressed=false) 응답에 도달했다는 것 자체가 모든
// 셀이 0 또는 ≥MINIMUM_COHORT라는 뜻이라(B-1 사전검사 통과), 실제 셀 값을 표로
// 보여줘도 안전하다 — "개별 칸 수치는 표시하지 않는다"는 1차 구현의 실수였다
// (계획서 §5 "분할표 전체연결억제"는 억제 아니면 표까지 공개하는 게 원래 설계).
// [코드리뷰 2026-09-12 2차] "x (행)"/"y (열)"만으로는 두 변수가 같은 범주명을
// 쓸 때 어느 변수의 행/열인지 구분할 수 없다 — 실제 변수 라벨(xLabel/yLabel,
// Node의 x=행/y=열 규칙 그대로)을 헤더에 넣는다.
function ContingencyTable({ table, xLabel, yLabel }: { table: BivariateRevealed['contingencyTable']; xLabel: string | null; yLabel: string | null }) {
  if (!table) return null;
  const { rowLabels, colLabels, cells } = table;
  return (
    <table className="swb-table">
      <thead>
        <tr><th /><th colSpan={colLabels.length}>{yLabel || 'y'} (열)</th></tr>
        <tr><th>{xLabel || 'x'} (행)</th>{colLabels.map((c) => <th key={String(c)}>{String(c)}</th>)}</tr>
      </thead>
      <tbody>
        {rowLabels.map((r, i) => (
          <tr key={String(r)}>
            <th>{String(r)}</th>
            {cells[i].map((cell, j) => <td key={j}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContingencyCard({ bivariate, catalogByKey, committedRecipe }: { bivariate: BivariateRevealed; catalogByKey: CatalogByKey; committedRecipe: ResultRecipeView | null }) {
  const cramersV = bivariate.extra?.cramersV;
  const { xLabel, yLabel } = resolveBivariateVariableLabels(catalogByKey, committedRecipe);
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      {(xLabel || yLabel) && (
        <p className="swb-card-subtitle">행: {xLabel || '—'} · 열: {yLabel || '—'}</p>
      )}
      <ContingencyTable table={bivariate.contingencyTable} xLabel={xLabel} yLabel={yLabel} />
      {/* PR3-B 계획서 §6.8.2 — 범주×범주 기본 그래프. */}
      <StackedBarChart100 table={bivariate.contingencyTable} />
      <table className="swb-table">
        <tbody>
          <tr><th>n</th><td>{bivariate.n}</td><th>통계량</th><td>{formatStat(bivariate.statistic)}</td></tr>
          <tr><th>자유도</th><td>{fmtDf(bivariate.df as number | null)}</td><th>p값</th><td>{formatPValue(bivariate.pValue)}</td></tr>
          {cramersV && (
            <tr><th>Cramér&apos;s V</th><td colSpan={3}>{formatStat(cramersV.value)}</td></tr>
          )}
          {bivariate.effectSizes.map((es) => (
            <tr key={es.name}>
              <th>{es.name}</th><td>{formatStat(es.value)}</td>
              <th>95% CI</th><td>{es.ci ? fmtCi(es.ci) : (es.ciUnavailableReason || '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <BivariateFooter bivariate={bivariate} />
    </div>
  );
}

function CorrelationCard({ bivariate, catalogByKey, committedRecipe }: { bivariate: BivariateRevealed; catalogByKey: CatalogByKey; committedRecipe: ResultRecipeView | null }) {
  const es = bivariate.effectSizes[0];
  const { xLabel, yLabel } = resolveBivariateVariableLabels(catalogByKey, committedRecipe);
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      {(xLabel || yLabel) && (
        <p className="swb-card-subtitle">x: {xLabel || '—'} · y: {yLabel || '—'}</p>
      )}
      {/* PR3-B 계획서 §2/§6.8.2 — 연속×연속 기본 그래프(산점도+적합선). */}
      <ScatterPlot scatter={bivariate.scatter} regressionLine={bivariate.regressionLine} />
      <table className="swb-table">
        <tbody>
          <tr><th>n</th><td>{bivariate.n}</td><th>계수</th><td>{es ? formatStat(es.value) : '—'}</td></tr>
          <tr>
            <th>95% CI</th>
            <td colSpan={3}>
              {es?.ci ? `${fmtCi(es.ci)} (${bivariate.method === 'pearson_correlation' ? 'Fisher z' : 'Fisher z + Bonett-Wright'})` : (es?.ciUnavailableReason || '—')}
            </td>
          </tr>
          <tr><th>p값</th><td colSpan={3}>{formatPValue(bivariate.pValue)}</td></tr>
        </tbody>
      </table>
      <BivariateFooter bivariate={bivariate} />
    </div>
  );
}

export function BivariateResultCard({ bivariate, catalogByKey, committedRecipe }: { bivariate: BivariateView; catalogByKey: CatalogByKey; committedRecipe: ResultRecipeView | null }) {
  if (bivariate.suppressed) return <BivariateSuppressedCard bivariate={bivariate} />;
  if (CONTINGENCY_METHODS.has(bivariate.method)) {
    return <ContingencyCard bivariate={bivariate as BivariateRevealed} catalogByKey={catalogByKey} committedRecipe={committedRecipe} />;
  }
  if (GROUP_COMPARISON_METHODS.has(bivariate.method)) {
    return <GroupComparisonCard bivariate={bivariate as BivariateRevealed} catalogByKey={catalogByKey} committedRecipe={committedRecipe} />;
  }
  return <CorrelationCard bivariate={bivariate as BivariateRevealed} catalogByKey={catalogByKey} committedRecipe={committedRecipe} />;
}

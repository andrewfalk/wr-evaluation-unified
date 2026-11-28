import { useState } from 'react';
import { describeStatsApiError } from './describeStatsError';
import { describeMethodReasonCode } from './describeMethodReasonCode';
import { PREDICTION_REQUIREMENTS } from './predictionRequirements';
import { BoxPlot } from '../charts/BoxPlot';
import { StackedBarChart100 } from '../charts/StackedBarChart100';
import { ScatterPlot } from '../charts/ScatterPlot';
import { CorrelationHeatmap } from '../charts/CorrelationHeatmap';
import { ForestPlot } from '../charts/ForestPlot';
import { RegressionDiagnosticsPanel } from '../charts/RegressionDiagnosticsPanel';
import { SplinePartialEffectChart } from '../charts/SplinePartialEffectChart';
import { CurveChart } from '../charts/CurveChart';
import { formatPValue, formatStat } from '../charts/numberFormat';
import { METHOD_LABELS } from './labels';
import {
  CONTINGENCY_METHODS,
  DIRECTIONAL_GROUP_METHODS,
  GROUP_COMPARISON_METHODS,
  PREDICTION_CAVEAT_LABELS,
  PREDICTION_METRIC_LABELS,
  PREDICTION_NON_ESTIMABLE_LABELS,
  QUALITY_FLAG_LABELS,
  REGRESSION_NON_ESTIMABLE_LABELS,
  REGRESSION_QUALITY_FLAG_LABELS,
  REGRESSION_WITHHELD_LABELS,
} from './result/labels';
import type {
  AnalyzeCorrelationMatrixResult,
  AnalyzeResponse,
  CatalogVariable,
  PredictionMetric,
  RegressionTerm,
  StatsMethodId,
} from '@wr/contracts/stats';
import type { ResultRecipeView, BivariateView, BivariateRevealed, CatalogByKey, RegressionView, PredictionView, PredictionBodyLambda } from './result/types';
import { resolveBivariateVariableLabels, fmtDf, fmtCi, variableLabel, num } from './result/format';
import { LimitedDisclosureBanner } from './result/LimitedDisclosureBanner';
import { Table1Grid } from './result/Table1Grid';
import { ContinuousCard, DiscreteCard, ContinuousDistributionCard, DiscreteDistributionCard } from './result/DescriptiveCards';

export interface ResultExportState {
  status: string;
  error?: unknown;
}

export interface ResultPanelProps {
  catalog: { variables?: CatalogVariable[] } | null | undefined;
  committedRecipe: ResultRecipeView | null;
  committedResult: AnalyzeResponse | null;
  recipeChanged: boolean;
  onExport: () => void;
  exportState: ResultExportState;
  actionsLocked: boolean;
  exportUnsupported: boolean;
}

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

function BivariateResultCard({ bivariate, catalogByKey, committedRecipe }: { bivariate: BivariateView; catalogByKey: CatalogByKey; committedRecipe: ResultRecipeView | null }) {
  if (bivariate.suppressed) return <BivariateSuppressedCard bivariate={bivariate} />;
  if (CONTINGENCY_METHODS.has(bivariate.method)) {
    return <ContingencyCard bivariate={bivariate as BivariateRevealed} catalogByKey={catalogByKey} committedRecipe={committedRecipe} />;
  }
  if (GROUP_COMPARISON_METHODS.has(bivariate.method)) {
    return <GroupComparisonCard bivariate={bivariate as BivariateRevealed} catalogByKey={catalogByKey} committedRecipe={committedRecipe} />;
  }
  return <CorrelationCard bivariate={bivariate as BivariateRevealed} catalogByKey={catalogByKey} committedRecipe={committedRecipe} />;
}

// PR3-B — 상관행렬(계획서 §4) 전용 결과 카드. 히트맵의 발산형 색은 r값(§6.8.3),
// suppressed 셀은 사유 없이 불투명 처리(§4의 3단계 게이트가 이미 판정 완료).
function CorrelationMatrixResultCard({ correlationMatrix, catalogByKey }: { correlationMatrix: AnalyzeCorrelationMatrixResult; catalogByKey: CatalogByKey }) {
  const labelOf = (key: string) => variableLabel(catalogByKey, key);
  return (
    <div className="swb-card">
      <strong>상관행렬 — {METHOD_LABELS[correlationMatrix.method] || correlationMatrix.method}</strong>
      <p className="swb-card-subtitle">
        변수 {correlationMatrix.variableKeys.length}개 · {correlationMatrix.variableKeys.map(labelOf).join(', ')}
      </p>
      <CorrelationHeatmap
        variableKeys={correlationMatrix.variableKeys}
        cells={correlationMatrix.cells}
        labelOf={labelOf}
      />
      <p className="swb-suppressed-note">
        {correlationMatrix.adjustedPWithheld
          ? '일부 쌍이 억제되어 다중검정 보정값(BH-FDR)은 행렬 전체에서 비공개 처리됩니다.'
          : '다중검정 보정: BH-FDR(raw p와 보정 p 병기, 데이터 보기에서 확인)'}
      </p>
    </div>
  );
}

// PR4-A2 — 표준화된 predictor의 주효과 계수는 "원 단위 1 증가당"이 아니라 "1 SD
// 증가당" 계수라 단위가 다르다. 실행 시 저장된 standardizedPredictorKeys를
// 기준으로 표시한다(체크박스는 실행 후에도 바뀔 수 있어 그것으로는 판단할 수
// 없다 — 리뷰 지적). interaction 항에는 적용하지 않는다 — 아래 참고.
function isStandardizedMainTerm(t: RegressionTerm, standardizedKeys: string[]): boolean {
  return Boolean(t.variableKey) && standardizedKeys.length > 0 && standardizedKeys.includes(t.variableKey as string);
}

// PR4-A2(리뷰 후 수정) — interaction 계수(β₁₂)는 "1 SD당 효과"로 해석할 수 없다
// (β₁z₁+β₂z₂+β₁₂z₁z₂에서 z₁의 한계효과는 β₁+β₁₂z₂이지 β₁₂ 단독이 아니다). 참여
// 변수 중 하나라도 표준화됐다고 전체에 동일한 suffix를 붙이면 잘못된 해석을
// 유도한다(리뷰 지적) — 대신 각 변수가 어떤 척도로 곱해졌는지(z-score/원 단위)를
// 개별 병기한다.
function interactionScaleNote(interactionOf: [string, string] | null, standardizedKeys: string[], catalogByKey: CatalogByKey): string | null {
  if (!interactionOf || standardizedKeys.length === 0) return null;
  const describe = (key: string) => `${variableLabel(catalogByKey, key)}(${standardizedKeys.includes(key) ? 'z-score' : '원 단위'})`;
  return `${describe(interactionOf[0])} × ${describe(interactionOf[1])}`;
}

function regressionTermRowLabel(t: RegressionTerm, standardizedKeys: string[] = [], catalogByKey: CatalogByKey = new Map()): string {
  // 서버 label이 이미 "변수: 수준"(범주형) / "A × B"(interaction) 형태다(server/src/stats/dataset/regressionDesign.ts,
  // server/src/stats/disclosure/regressionSuppression.ts) — 수준을 다시 붙이면 "성별: male: male"이 된다.
  const base = t.label;
  if (t.termType === 'interaction') {
    const note = interactionScaleNote(t.interactionOf, standardizedKeys, catalogByKey);
    return note ? `${base} — ${note}` : base;
  }
  return isStandardizedMainTerm(t, standardizedKeys) ? `${base} (표준화, 1 SD당)` : base;
}

function RegressionCoefficientTable({ terms, exponentiated, standardizedPredictorKeys = [], catalogByKey = new Map() }: {
  terms: RegressionTerm[]; exponentiated: boolean; standardizedPredictorKeys?: string[]; catalogByKey?: CatalogByKey;
}) {
  // PR4-A2 — spline 기저 항(β_ns1..β_ns4)은 개별로는 해석 불가능하므로 계수표에서
  // 뺀다(SplinePartialEffectChart로 대체 표시 — ForestPlot과 동일 원칙).
  const rows = terms.filter((t) => t.termType !== 'spline_basis');
  const splineVariables = [...new Set(terms.filter((t) => t.termType === 'spline_basis').map((t) => t.variableKey))];
  return (
    <div className="swb-table-scroll">
      <table className="swb-table" aria-label="회귀 계수표">
        <thead>
          <tr>
            <th>변수</th><th>계수</th><th>SE</th>
            {exponentiated && <th>OR</th>}
            <th>통계량</th><th>p값</th><th>95% CI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.name}>
              <td>{regressionTermRowLabel(t, standardizedPredictorKeys, catalogByKey)}</td>
              <td>{formatStat(t.estimate)}</td>
              <td>{formatStat(t.se)}</td>
              {exponentiated && <td>{t.exponentiated ? formatStat(t.exponentiated.estimate) : '—'}</td>}
              <td>{formatStat(t.statistic)}</td>
              <td>{formatPValue(t.pValue)}</td>
              <td>{t.ciLower !== null && t.ciUpper !== null && t.ciLower !== undefined ? `[${formatStat(t.ciLower)}, ${formatStat(t.ciUpper)}]` : '(비공개)'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {splineVariables.length > 0 && (
        <p className="swb-suppressed-note">
          스플라인 변수({splineVariables.map((k) => variableLabel(catalogByKey, k as string)).join(', ')})의 개별 계수는 해석할 수 없어 생략했습니다 — 아래 부분효과 그래프를 참고하세요.
        </p>
      )}
    </div>
  );
}

function RegressionResultCard({ regression, catalogByKey }: { regression: RegressionView; catalogByKey: CatalogByKey }) {
  if (regression.suppressed) {
    return (
      <div className="swb-card">
        <strong>{METHOD_LABELS[regression.method as string] || regression.method || '회귀'}</strong>
        <p className="swb-suppressed-note">공개 정책에 따라 결과가 표시되지 않음(표본 크기 등).</p>
      </div>
    );
  }

  const methodLabel = METHOD_LABELS[regression.method as string] || regression.method;
  const outcomeLabel = variableLabel(catalogByKey, regression.outcomeKey as string);

  if (regression.estimation === 'non_estimable') {
    return (
      <div className="swb-card">
        <strong>{methodLabel}</strong>
        <p className="swb-card-subtitle">결과변수: {outcomeLabel}</p>
        <p className="swb-suppressed-note">
          {REGRESSION_NON_ESTIMABLE_LABELS[regression.nonEstimableReason as string] || '현재 데이터로 계산할 수 없습니다.'}
        </p>
      </div>
    );
  }

  const isWithheld = regression.estimation === 'inference_withheld';
  const isLogistic = regression.method === 'binary_logistic';
  // VIF 표의 termName(내부 이름)을 계수표와 같은 사람이 읽는 라벨로 바꾸기 위한 맵 — 서버 응답 변경 없이
  // regression.terms의 name → label을 쓴다.
  const termLabelByName = new Map((regression.terms || []).map((t) => [t.name, t.label]));

  return (
    <div className="swb-card">
      <strong>{methodLabel}</strong>
      <p className="swb-card-subtitle">
        결과변수: {outcomeLabel}{isLogistic && regression.eventLevel ? ` (사건=${regression.eventLevel})` : ''} ·
        {' '}n={regression.n} · 표본 {regression.personCount}명
        {regression.covariance === 'person_cluster_cr1' && regression.clusterCount != null
          ? ` · 클러스터 ${regression.clusterCount}개(최대 비중 ${((regression.maxClusterShare as number) * 100).toFixed(0)}%)`
          : ''}
      </p>

      {isWithheld && (
        <p className="swb-status-warn">
          {REGRESSION_WITHHELD_LABELS[regression.inferenceWithheldReason as string] || '일부 결과를 표시하지 않습니다.'}
        </p>
      )}

      <ForestPlot
        terms={regression.terms} exponentiated={isLogistic}
        standardizedPredictorKeys={regression.standardizedPredictorKeys as never[]}
        variableLabelOf={(k) => variableLabel(catalogByKey, k)}
      />
      <RegressionCoefficientTable
        terms={regression.terms as RegressionTerm[]} exponentiated={isLogistic}
        standardizedPredictorKeys={regression.standardizedPredictorKeys} catalogByKey={catalogByKey}
      />
      {regression.standardizedPredictorKeys && regression.standardizedPredictorKeys.length > 0 && (
        <p className="swb-suppressed-note">
          표준화 적용: {regression.standardizedPredictorKeys.map((k) => variableLabel(catalogByKey, k)).join(', ')}
          {' '}— 표준화된 변수의 <strong>주효과</strong> 계수는 해당 변수 1 표준편차 증가당
          효과입니다. interaction 항의 계수는 단일 변수의 1 SD당 효과가 아니므로(참여 변수
          중 하나의 값에 따라 달라짐) 위 계수표의 척도 표시(z-score/원 단위)를 함께 참고하세요.
        </p>
      )}

      {regression.splinePartialEffects && regression.splinePartialEffects.length > 0 && (
        <>
          <strong>스플라인 부분효과</strong>
          {regression.splinePartialEffects.map((effect) => (
            <SplinePartialEffectChart
              key={effect.variableKey}
              effect={effect}
              label={variableLabel(catalogByKey, effect.variableKey)}
              exponentiated={isLogistic}
            />
          ))}
        </>
      )}

      {regression.fit && (
        <p className="swb-suppressed-note">
          {regression.method === 'ols_linear'
            ? `R² = ${formatStat(regression.fit.r2)}, 조정 R² = ${formatStat(regression.fit.adjR2)}`
            : `로그우도 = ${num(regression.fit.logLik, 2)}, AIC = ${num(regression.fit.aic, 2)}, McFadden 의사R² = ${formatStat(regression.fit.pseudoR2)}`}
        </p>
      )}

      {(regression.qualityFlags as string[]).length > 0 && (
        <p className="swb-status-warn">{(regression.qualityFlags as string[]).map((f) => REGRESSION_QUALITY_FLAG_LABELS[f] || f).join(' ')}</p>
      )}
      <p className="swb-suppressed-note">완전사례 제외 {regression.excludedRowCount}건</p>
      <p className="swb-suppressed-note">{regression.analysisUnitNote}</p>

      <RegressionDiagnosticsPanel
        termLabelOf={(name) => termLabelByName.get(name) || catalogByKey.get(name)?.label || name}
        diagnostics={regression.diagnostics}
        method={regression.method}
        isPersonCluster={regression.covariance === 'person_cluster_cr1'}
      />
    </div>
  );
}

const PREDICTION_CV_WITHHELD_LABELS: Record<string, string> = { LOW_VALID_REPEATS: '유효 반복 수 부족' };
const PREDICTION_BOOTSTRAP_WITHHELD_LABELS: Record<string, string> = {
  APPARENT_UNAVAILABLE: 'apparent 값 없음', LOW_VALID_REPLICATES: '유효 복제 수 부족',
};

function predictionCvCell(cv: PredictionMetric['cv']): string {
  if (cv.status === 'withheld') {
    return `보류: 유효 ${cv.validRepeats}/${cv.totalRepeats}${cv.withheldReason ? ` (${PREDICTION_CV_WITHHELD_LABELS[cv.withheldReason] || cv.withheldReason})` : ''}`;
  }
  return `${formatStat(cv.mean)} [${formatStat(cv.min)}–${formatStat(cv.max)}] (유효 ${cv.validRepeats}/${cv.totalRepeats})`;
}

function predictionBootstrapCell(bootstrap: PredictionMetric['bootstrap']): string {
  if (bootstrap.status === 'withheld') {
    return `보류: 유효 ${bootstrap.validReplicates}/${bootstrap.totalReplicates}${bootstrap.withheldReason ? ` (${PREDICTION_BOOTSTRAP_WITHHELD_LABELS[bootstrap.withheldReason] || bootstrap.withheldReason})` : ''}`;
  }
  const warn = bootstrap.correctedOutOfRange ? ' ⚠ 범위 밖' : '';
  return `${formatStat(bootstrap.corrected)} (유효 ${bootstrap.validReplicates}/${bootstrap.totalReplicates})${warn}`;
}

// PR4-B2 §6단계 "ResultPanel.jsx — PredictionResultCard": 1)억제·추정불가 2)지표표
// 3)곡선/calibration 4)계수 5)주의문 순서. "층화 기준과 결과 카운트는 다를 수
// 있음" 도움말은 personCount(S2, 완전사례 기준 최종 분석자료)와 cohortDigest가
// 만드는 층화 기준(기준 코호트, 예측변수와 무관) 사이의 잠재적 차이를 설명한다.
// 제한데이터 권한자 해제본 전용 — 추정 불가일 때 "완전사례 기준" 인원을 필요 기준과 함께 보여 준다. 미리보기의 사건/비사건 수는
// 결과변수만 관측된 인원이라 예측이 실제로 쓰는 자료(예측변수 값이 모두 있는 사람)와 크게 다를 수 있어, 결측이 많은 변수를 고르면
// "미리보기엔 138명인데 왜 부족하지?"처럼 혼동하기 쉽다.
function PredictionCompleteCaseCounts({ prediction }: { prediction: PredictionView }) {
  const rows = [
    { label: '전체', count: prediction.personCount as number, need: PREDICTION_REQUIREMENTS.minPersons },
    { label: '사건', count: prediction.eventPersonCount as number, need: PREDICTION_REQUIREMENTS.minEventPersons },
    { label: '비사건', count: prediction.nonEventPersonCount as number, need: PREDICTION_REQUIREMENTS.minNonEventPersons },
  ];
  return (
    <>
      <div className="swb-section-label">완전사례 기준 인원 (예측에 실제로 쓰이는 자료)</div>
      <div className="swb-table-scroll">
        <table className="swb-table" aria-label="완전사례 기준 인원">
          <thead><tr><th>구분</th><th>인원</th><th>필요 기준</th><th>판정</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.count}명</td>
                <td>{r.need}명 이상</td>
                <td>{r.count >= r.need ? '충족' : '부족'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="swb-suppressed-note">
        미리보기의 사건/비사건 수는 결과변수만 관측된 인원입니다. 예측은 선택한 예측변수 값이 모두 있는 사람만 쓰므로, 결측이 많은
        변수를 고르면 이 인원이 훨씬 줄어듭니다(완전사례 제외 {prediction.excludedRowCount}건).
      </p>
    </>
  );
}

function PredictionResultCard({ prediction, catalogByKey, limitedApplied = false }: { prediction: PredictionView; catalogByKey: CatalogByKey; limitedApplied?: boolean }) {
  if (prediction.suppressed) {
    return (
      <div className="swb-card">
        <strong>{METHOD_LABELS.l2_logistic}</strong>
        <p className="swb-suppressed-note">공개 정책에 따라 결과가 표시되지 않음(표본 크기 등).</p>
      </div>
    );
  }

  const outcomeLabel = variableLabel(catalogByKey, prediction.outcomeKey as string);

  if (prediction.estimation === 'non_estimable') {
    return (
      <div className="swb-card">
        <strong>{METHOD_LABELS.l2_logistic}</strong>
        <p className="swb-card-subtitle">결과변수: {outcomeLabel} (사건={prediction.eventLevel})</p>
        <p className="swb-suppressed-note">
          {PREDICTION_NON_ESTIMABLE_LABELS[prediction.nonEstimableReason as string] || '현재 데이터로 계산할 수 없습니다.'}
        </p>
        {limitedApplied && <PredictionCompleteCaseCounts prediction={prediction} />}
      </div>
    );
  }

  const rocAucMetric = (prediction.metrics as PredictionMetric[]).find((m) => m.metric === 'roc_auc');

  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS.l2_logistic}</strong>
      <p className="swb-card-subtitle">
        결과변수: {outcomeLabel} (사건={prediction.eventLevel}) ·
        {' '}n={prediction.n} · 표본 {prediction.personCount}명(사건 {prediction.eventPersonCount} / 비사건 {prediction.nonEventPersonCount})
      </p>
      <p className="swb-suppressed-note">
        층화 기준(기준 코호트)과 위 표본 수(최종 분석자료, 완전사례)는 서로 다를 수 있습니다 — 기준 코호트는 예측변수 선택과 무관하게 결과변수·필터만으로 정해집니다.
      </p>

      <div className="swb-table-scroll">
        <table className="swb-table" aria-label="예측 성능 지표표">
          <thead>
            <tr><th>지표</th><th>apparent</th><th>CV 평균[최소–최대] (유효 n/R)</th><th>bootstrap 보정 (유효 n/B)</th><th>반복 1</th></tr>
          </thead>
          <tbody>
            {(prediction.metrics as PredictionMetric[]).map((m) => (
              <tr key={m.metric}>
                <td>{PREDICTION_METRIC_LABELS[m.metric] || m.metric}</td>
                <td>{formatStat(m.apparent)}</td>
                <td>
                  {predictionCvCell(m.cv)}
                  {m.metric === 'roc_auc' && prediction.aucCi && (
                    <> · 95% CI {fmtCi([prediction.aucCi.lower, prediction.aucCi.upper])}</>
                  )}
                </td>
                <td>{predictionBootstrapCell(m.bootstrap)}</td>
                <td>{formatStat(m.representativeRepeat)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!prediction.aucCi && rocAucMetric?.cv.status === 'ok' && (
        <p className="swb-suppressed-note">AUC의 95% 신뢰구간은 계산되지 않았습니다.</p>
      )}

      <div className="swb-section-label">ROC 곡선</div>
      <CurveChart curves={prediction.curves} kind="roc" />
      <div className="swb-section-label">PR 곡선</div>
      <CurveChart curves={prediction.curves} kind="pr" />
      <div className="swb-section-label">Calibration 곡선</div>
      <CurveChart curves={prediction.curves} kind="calibration" />
      {prediction.curves?.bins && (
        <p className="swb-suppressed-note">
          곡선과 &apos;반복 1&apos; 지표는 같은 OOF 예측에서 계산했습니다. 곡선은 공개통제로 구간화되어, 면적은 반복 1 AUC와도 다를 수 있습니다. 표의 주 지표는 반복 평균이고 95% CI는 반복 평균 AUC에 대한 것입니다.
        </p>
      )}

      <div className="swb-section-label">계수(표준화, λ={formatStat((prediction.lambda as PredictionBodyLambda).selected)})</div>
      <div className="swb-table-scroll">
        <table className="swb-table" aria-label="예측 계수표">
          <thead><tr><th>변수</th><th>수준</th><th>표준화 계수</th></tr></thead>
          <tbody>
            <tr><td>(절편)</td><td>—</td><td>{formatStat(prediction.coefficients?.intercept)}</td></tr>
            {(prediction.coefficients?.terms || []).map((t) => (
              <tr key={t.term}>
                <td>{variableLabel(catalogByKey, t.variableKey)}</td>
                <td>{t.level ?? '—'}</td>
                <td>{formatStat(t.standardizedBeta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="swb-suppressed-note">
        ridge(L2 정칙화) 표준화 계수는 개별 변수의 유의성 검정 목적이 아니라 예측 모형 내 상대적 기여도 참고용입니다 — p값·신뢰구간을 제공하지 않습니다.
      </p>

      {(prediction.droppedColumnFoldCount as number) > 0 && (
        <p className="swb-status-warn">
          일부 교차검증 분할에서 값이 상수인 설명변수 열 {prediction.droppedColumnFoldCount}개가 제외됐습니다.
        </p>
      )}
      <p className="swb-suppressed-note">완전사례 제외 {prediction.excludedRowCount}건</p>

      <div className="swb-section-label">주의사항</div>
      <ul>
        {(prediction.caveats as string[]).map((c) => (
          <li key={c} className="swb-suppressed-note">{PREDICTION_CAVEAT_LABELS[c] || c}</li>
        ))}
      </ul>
    </div>
  );
}

const TABS = [
  { id: 'summary', label: '요약', enabled: true },
  { id: 'distribution', label: '분포', enabled: true },
  { id: 'association', label: '연관성', enabled: true },
  { id: 'regression', label: '회귀', enabled: true }, // PR4-A1
  { id: 'prediction', label: '예측', enabled: true }, // PR4-B2
];

// PR2 §6/§8 — 결과 패널. committed(마지막 실행 성공 시점의 recipe/result)만 참조하고,
// draft가 그 이후 바뀌면 배너로만 알린다(실행된 결과-조건 연결은 절대 안 바뀜, §6).
// PR3-A — 탭 상태(activeTab)를 신설해 "연관성" 탭에 이변량 결과 카드를 배선한다.
export function ResultPanel({
  catalog, committedRecipe, committedResult, recipeChanged,
  onExport, exportState, actionsLocked, exportUnsupported,
}: ResultPanelProps) {
  const catalogByKey = new Map((catalog?.variables ?? []).map((v) => [v.key, v]));
  // 범주형 "기타" 병합 안내용 — 실행에 쓰인 변수 개수(서버 응답이 아니라 레시피만 본다).
  const variableCount = committedRecipe?.variableKeys?.length ?? 0;
  const [activeTab, setActiveTab] = useState('summary');
  const isBivariateRun = committedRecipe?.analysisMode === 'bivariate';
  // PR3-B — 상관행렬도 descriptive의 continuous/discrete 표를 안 쓰므로 이변량과
  // 같은 분기 처리가 필요하다(요약 탭 메시지, export 잠금 등).
  const isCorrelationMatrixRun = committedRecipe?.analysisMode === 'correlation_matrix';
  // PR4-A1 — 회귀도 동일 원칙. isDescriptiveRun에서 빠뜨리면 회귀 실행이
  // descriptive로 오인돼 요약/분포 탭이 빈 continuous/discrete를 읽다 깨진다
  // (계획서 §5 — 실제 버그 위험 지점으로 명시됐던 곳).
  const isRegressionRun = committedRecipe?.analysisMode === 'regression';
  // PR4-B2 — 동일 원칙(위 PR4-A1 주석 참고). 빠뜨리면 예측 실행이 descriptive로
  // 오인돼 요약/분포 탭이 빈 continuous/discrete를 읽다 깨진다.
  const isPredictionRun = committedRecipe?.analysisMode === 'prediction';
  const isDescriptiveRun = !isBivariateRun && !isCorrelationMatrixRun && !isRegressionRun && !isPredictionRun;
  // Table1 — descriptiveStratified가 있으면 최상위 continuous/discrete는 항상 빈
  // 배열이다(shared/contracts/stats.ts, 진실 공급원 하나만 유지) — 이 값으로
  // 분기해서 일반 카드 스택 대신 Table1Grid를 그린다.
  const descriptiveStratified = isDescriptiveRun ? committedResult?.result?.descriptiveStratified : null;

  return (
    <section className="swb-result" aria-label="결과">
      <div className="swb-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`swb-tab${t.id === activeTab ? ' swb-tab--active' : ''}`}
            disabled={!t.enabled}
            title={t.enabled ? undefined : '현재 제공하지 않음'}
            onClick={() => t.enabled && setActiveTab(t.id)}
          >{t.label}</button>
        ))}
      </div>

      <div className="swb-result-body">
        {recipeChanged && committedResult && (
          <div className="swb-banner" style={{ marginBottom: 12 }}>조건이 변경됨 — 다시 실행 필요</div>
        )}

        {/* 서버가 소수 셀 해제를 지원하는 모드에서만 배너를 보인다 — 기술통계·회귀·이변량·상관행렬·예측 — 전 모드. */}
        {committedResult && (isDescriptiveRun || isRegressionRun || isBivariateRun || isCorrelationMatrixRun || isPredictionRun) && (
          <LimitedDisclosureBanner status={committedResult.result?.limitedDisclosure} />
        )}

        {!committedResult && <div className="swb-empty">좌측에서 변수를 선택하고 "분석 실행"을 눌러주세요.</div>}

        {committedResult && activeTab === 'summary' && (
          descriptiveStratified ? (
            <Table1Grid
              stratified={descriptiveStratified}
              catalogByKey={catalogByKey}
              limitedApplied={committedResult.result?.limitedDisclosure === 'applied'}
            />
          ) : isDescriptiveRun ? (
            <>
              <div className="swb-section-label">연속형</div>
              {committedResult.result.continuous.length === 0 && <p className="swb-suppressed-note">선택된 연속형 변수 없음</p>}
              {committedResult.result.continuous.map((row) => (
                <ContinuousCard key={row.variableKey} catalogByKey={catalogByKey} row={row} />
              ))}

              <div className="swb-section-label">이산형</div>
              {committedResult.result.discrete.length === 0 && <p className="swb-suppressed-note">선택된 이산형 변수 없음</p>}
              {committedResult.result.discrete.map((row) => (
                <DiscreteCard key={row.variableKey} catalogByKey={catalogByKey} row={row} variableCount={variableCount} />
              ))}
            </>
          ) : isRegressionRun ? (
            <p className="swb-suppressed-note">회귀 분석 결과는 "회귀" 탭에서 확인하세요.</p>
          ) : isPredictionRun ? (
            <p className="swb-suppressed-note">예측 분석 결과는 "예측" 탭에서 확인하세요.</p>
          ) : (
            <p className="swb-suppressed-note">
              {isBivariateRun ? '이변량' : '상관행렬'} 분석 결과는 "연관성" 탭에서 확인하세요.
            </p>
          )
        )}

        {committedResult && activeTab === 'distribution' && (
          descriptiveStratified ? (
            <p className="swb-suppressed-note">
              그룹별 비교(Table 1)는 요약 통계만 제공합니다 — 히스토그램/박스플롯 같은
              분포 그래프는 그룹별 보기에서 지원하지 않습니다. 분포가 필요하면 "그룹별
              비교"를 "사용 안 함"으로 바꾼 뒤 다시 실행하세요.
            </p>
          ) : isDescriptiveRun ? (
            <>
              <div className="swb-section-label">연속형 분포</div>
              {committedResult.result.continuous.length === 0 && <p className="swb-suppressed-note">선택된 연속형 변수 없음</p>}
              {committedResult.result.continuous.map((row) => (
                <ContinuousDistributionCard key={row.variableKey} catalogByKey={catalogByKey} row={row} />
              ))}

              <div className="swb-section-label">이산형 분포</div>
              {committedResult.result.discrete.length === 0 && <p className="swb-suppressed-note">선택된 이산형 변수 없음</p>}
              {committedResult.result.discrete.map((row) => (
                <DiscreteDistributionCard key={row.variableKey} catalogByKey={catalogByKey} row={row} variableCount={variableCount} />
              ))}
            </>
          ) : (
            <p className="swb-suppressed-note">기술통계(단변량) 모드로 분석을 실행하면 여기에 분포가 표시됩니다.</p>
          )
        )}

        {committedResult && activeTab === 'association' && (
          isBivariateRun && committedResult.result.bivariate ? (
            <BivariateResultCard
              bivariate={committedResult.result.bivariate}
              catalogByKey={catalogByKey}
              committedRecipe={committedRecipe}
            />
          ) : isCorrelationMatrixRun && committedResult.result.correlationMatrix ? (
            <CorrelationMatrixResultCard
              correlationMatrix={committedResult.result.correlationMatrix}
              catalogByKey={catalogByKey}
            />
          ) : (
            <p className="swb-suppressed-note">이변량 또는 상관행렬 모드로 분석을 실행하면 여기에 결과가 표시됩니다.</p>
          )
        )}

        {committedResult && activeTab === 'regression' && (
          isRegressionRun && committedResult.result.regression ? (
            <RegressionResultCard
              regression={committedResult.result.regression}
              catalogByKey={catalogByKey}
            />
          ) : (
            <p className="swb-suppressed-note">회귀 모드로 분석을 실행하면 여기에 결과가 표시됩니다.</p>
          )
        )}

        {committedResult && activeTab === 'prediction' && (
          isPredictionRun && committedResult.result.prediction ? (
            <PredictionResultCard
              prediction={committedResult.result.prediction}
              catalogByKey={catalogByKey}
              limitedApplied={committedResult.result.limitedDisclosure === 'applied'}
            />
          ) : (
            <p className="swb-suppressed-note">예측 모드로 분석을 실행하면 여기에 결과가 표시됩니다.</p>
          )
        )}

        {/* PR4-A2 — 회귀도 집계 CSV export 지원(exportUnsupported prop이 bivariate/
            correlation_matrix만 막는다 — StatisticsWorkbench.jsx 기준과 동일).
            PR4-B2 — 예측도 집계 CSV export 지원(계수는 서버가 애초에 CSV에 넣지
            않는다 — server/src/stats/export/exportHandler.ts buildPredictionCsv 주석 참고). */}
        {committedResult && (isDescriptiveRun || isRegressionRun || isPredictionRun) && (
          <button
            type="button"
            className="swb-btn"
            style={{ marginTop: 12 }}
            disabled={exportState.status === 'exporting' || actionsLocked || exportUnsupported}
            title={actionsLocked ? '기능을 사용할 수 없는 동안은 내보낼 수 없습니다.' : undefined}
            onClick={onExport}
          >
            {exportState.status === 'exporting' ? '내보내는 중…' : '집계 결과 내보내기 (CSV)'}
          </button>
        )}
        {committedResult && !isDescriptiveRun && !isRegressionRun && !isPredictionRun && (
          <p className="swb-suppressed-note" style={{ marginTop: 12 }}>
            {isBivariateRun ? '이변량' : '상관행렬'} 결과는 아직 CSV 내보내기를 지원하지 않습니다.
          </p>
        )}
        {exportState.status === 'error' && (
          <p className="swb-status-danger" style={{ whiteSpace: 'pre-wrap' }}>내보내기 실패: {describeStatsApiError(exportState.error)}</p>
        )}
      </div>

      {committedResult && (
        <div className="swb-provenance">
          run {committedResult.runManifest.analysisRunId} · snapshot {committedResult.runManifest.snapshotAsOf} ·
          catalog {committedResult.runManifest.catalogVersion} · engine {committedResult.runManifest.engineVersion}
          <br />원본 DB 변경 후 exact rerun은 보장되지 않음 — provenance/무결성 검증용.
        </div>
      )}
    </section>
  );
}

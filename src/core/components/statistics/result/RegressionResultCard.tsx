// 회귀 결과 카드(계수표 · 표준화·상호작용 표기) — P2-78d에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다.
import { ForestPlot } from '../../charts/ForestPlot';
import { RegressionDiagnosticsPanel } from '../../charts/RegressionDiagnosticsPanel';
import { SplinePartialEffectChart } from '../../charts/SplinePartialEffectChart';
import { formatStat, formatPValue } from '../../charts/numberFormat';
import { METHOD_LABELS } from '../labels';
import { REGRESSION_NON_ESTIMABLE_LABELS, REGRESSION_WITHHELD_LABELS, REGRESSION_QUALITY_FLAG_LABELS } from './labels';
import type { RegressionTerm } from '@wr/contracts/stats';
import type { CatalogByKey, RegressionView } from './types';
import { variableLabel, num } from './format';

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

export function RegressionResultCard({ regression, catalogByKey }: { regression: RegressionView; catalogByKey: CatalogByKey }) {
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

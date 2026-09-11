import { useState } from 'react';
import { describeStatsApiError } from './describeStatsError';

const NULL_REASON_LABELS = {
  insufficient_data: '자료 부족',
  undefined_zero_variance: '분산 0(정의 불가)',
  non_finite_result: '유한하지 않은 값',
  constant_variable: '값이 전부 동일(정의 불가)',
  insufficient_group_data: '그룹 자료 부족',
};

// PR3-A — StatsMethodIdSchema와 동일 목록. RecipePanel.jsx의 METHOD_LABELS와 중복이지만
// 파일을 나눈 이유(다른 컴포넌트, 서로 다른 렌더 맥락)는 기존 관례(describeStatsError.js
// vs describeMethodReasonCode.js 분리)와 같다.
const METHOD_LABELS = {
  welch_t: 'Welch t 검정', mann_whitney: 'Mann-Whitney U 검정',
  anova: '일원분산분석(Welch)', kruskal_wallis: 'Kruskal-Wallis 검정',
  chi_square: '카이제곱 검정', fisher_exact: 'Fisher 정확검정',
  pearson_correlation: 'Pearson 상관', spearman_correlation: 'Spearman 상관',
  paired_t: '대응 t 검정', wilcoxon_signed_rank: 'Wilcoxon 부호순위검정',
};
const GROUP_COMPARISON_METHODS = new Set(['welch_t', 'mann_whitney', 'anova', 'kruskal_wallis', 'paired_t', 'wilcoxon_signed_rank']);
const CONTINGENCY_METHODS = new Set(['chi_square', 'fisher_exact']);
const QUALITY_FLAG_LABELS = {
  low_expected_count: '일부 칸의 기대도수가 작아 근사의 타당성이 낮습니다.',
  haldane_anscombe_applied: '0이 포함된 셀이 있어 Haldane-Anscombe 보정(+0.5)을 적용했습니다.',
};

function variableLabel(catalogByKey, key) {
  return catalogByKey.get(key)?.label || key;
}

function missingPatternsText(patterns) {
  if (patterns === null) return '(비공개)'; // §8 — null(억제)과 []([]0건)을 다른 표기로 구분
  if (patterns.length === 0) return '(없음)';
  return patterns.map((p) => `${p.reasonCode}:${p.count}`).join(', ');
}

function fmt(n) {
  return n === null || n === undefined ? '—' : String(n);
}

function fmtCi(ci) {
  if (!ci) return '—';
  return `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`;
}

function ContinuousCard({ catalogByKey, row }) {
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
          <tr><th>n</th><td>{row.n}</td><th>결측</th><td>{row.missingCount} {missingPatternsText(row.missingPatterns)}</td></tr>
          <tr><th>평균</th><td>{fmt(row.mean)}</td><th>SD</th><td>{fmt(row.sd)}</td></tr>
          <tr><th>중앙값</th><td>{fmt(row.median)}</td><th>IQR</th><td>{fmt(row.iqr)}</td></tr>
          <tr><th>Q1</th><td>{fmt(row.q1)}</td><th>Q3</th><td>{fmt(row.q3)}</td></tr>
          <tr><th>왜도</th><td>{fmt(row.skewness)}</td><th>첨도</th><td>{fmt(row.kurtosis)}</td></tr>
          <tr><th>최소</th><td>{fmt(row.min)}</td><th>최대</th><td>{fmt(row.max)}</td></tr>
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

function DiscreteCard({ catalogByKey, row }) {
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
      <p>n={row.n}, 결측={row.missingCount} {missingPatternsText(row.missingPatterns)}, 최빈값={fmt(row.mode)}</p>
      <table className="swb-table">
        <thead><tr><th>수준</th><th>빈도</th><th>비율</th></tr></thead>
        <tbody>
          {row.levels.map((l, i) => (
            <tr key={i}><td>{String(l.level)}</td><td>{l.count}</td><td>{(l.proportion * 100).toFixed(1)}%</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// PR3-A — 이변량 결과 카드 공통 부분(억제·제외건수·품질플래그·다중검정 라벨).
// method별로 다른 부분(GroupComparisonCard/ContingencyCard/CorrelationCard)만
// 갈라서 렌더링한다 — 응답 shape 자체는 셋 다 동일하다(statistic/df/pValue/
// effectSizes/extra), 어떤 필드를 어떻게 강조해 보여줄지만 다르다.
function BivariateSuppressedCard({ bivariate }) {
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      <p className="swb-suppressed-note">공개 정책에 따라 결과가 표시되지 않음(표본 크기 등).</p>
    </div>
  );
}

function BivariateFooter({ bivariate }) {
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
        단일 검정(보정 없음) — raw p = adjusted p ({fmt(bivariate.pValue)})
      </p>
    </>
  );
}

// [코드리뷰 2026-09-12] 그룹 라벨·그룹별 n이 있어야 평균차/효과크기의 부호를
// 해석할 수 있다(계획서 §방향규칙: 차이 = 뒤 그룹 − 앞 그룹, groupBreakdown은
// 그 순서 그대로 옴). 응답에 도달했다는 것 자체가 이미 소수셀 사전검사를 통과한
// 상태라 그룹별 n을 공개해도 안전하다.
function GroupBreakdownTable({ groupBreakdown }) {
  if (!groupBreakdown || groupBreakdown.length === 0) return null;
  return (
    <>
      <table className="swb-table">
        <thead><tr><th>역할</th><th>그룹</th><th>n</th></tr></thead>
        <tbody>
          {groupBreakdown.map((g, i) => (
            <tr key={String(g.label)}>
              <td>{i === 0 ? '앞(기준)' : '뒤(비교)'}</td>
              <td>{String(g.label)}</td>
              <td>{g.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {groupBreakdown.length === 2 && (
        <p className="swb-suppressed-note">
          평균차·효과크기 방향 = {String(groupBreakdown[1].label)} − {String(groupBreakdown[0].label)}
        </p>
      )}
    </>
  );
}

function GroupComparisonCard({ bivariate }) {
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      <GroupBreakdownTable groupBreakdown={bivariate.groupBreakdown} />
      <table className="swb-table">
        <tbody>
          <tr><th>n</th><td>{bivariate.n}</td><th>통계량</th><td>{fmt(bivariate.statistic)}</td></tr>
          <tr>
            <th>자유도</th>
            <td colSpan={3}>
              {typeof bivariate.df === 'object' && bivariate.df !== null
                ? `${fmt(bivariate.df.numerator)}, ${fmt(bivariate.df.denominator)}`
                : fmt(bivariate.df)}
            </td>
          </tr>
          <tr><th>p값</th><td colSpan={3}>{fmt(bivariate.pValue)}</td></tr>
          {bivariate.effectSizes.map((es) => (
            <tr key={es.name}>
              <th>{es.name}</th><td>{fmt(es.value)}</td>
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
function ContingencyTable({ table }) {
  if (!table) return null;
  const { rowLabels, colLabels, cells } = table;
  return (
    <table className="swb-table">
      <thead>
        <tr><th /><th colSpan={colLabels.length}>y (열)</th></tr>
        <tr><th>x (행)</th>{colLabels.map((c) => <th key={String(c)}>{String(c)}</th>)}</tr>
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

function ContingencyCard({ bivariate }) {
  const cramersV = bivariate.extra?.cramersV;
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      <ContingencyTable table={bivariate.contingencyTable} />
      <table className="swb-table">
        <tbody>
          <tr><th>n</th><td>{bivariate.n}</td><th>통계량</th><td>{fmt(bivariate.statistic)}</td></tr>
          <tr><th>자유도</th><td>{fmt(bivariate.df)}</td><th>p값</th><td>{fmt(bivariate.pValue)}</td></tr>
          {cramersV && (
            <tr><th>Cramér&apos;s V</th><td colSpan={3}>{fmt(cramersV.value)}</td></tr>
          )}
          {bivariate.effectSizes.map((es) => (
            <tr key={es.name}>
              <th>{es.name}</th><td>{fmt(es.value)}</td>
              <th>95% CI</th><td>{es.ci ? fmtCi(es.ci) : (es.ciUnavailableReason || '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!bivariate.contingencyTable && (
        <p className="swb-suppressed-note">개별 칸(셀) 수치는 표시하지 않습니다 — 집계 통계량만 공개됩니다.</p>
      )}
      <BivariateFooter bivariate={bivariate} />
    </div>
  );
}

function CorrelationCard({ bivariate }) {
  const es = bivariate.effectSizes[0];
  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS[bivariate.method] || bivariate.method}</strong>
      <table className="swb-table">
        <tbody>
          <tr><th>n</th><td>{bivariate.n}</td><th>계수</th><td>{es ? fmt(es.value) : '—'}</td></tr>
          <tr>
            <th>95% CI</th>
            <td colSpan={3}>
              {es?.ci ? `${fmtCi(es.ci)} (${bivariate.method === 'pearson_correlation' ? 'Fisher z' : 'Fisher z + Bonett-Wright'})` : (es?.ciUnavailableReason || '—')}
            </td>
          </tr>
          <tr><th>p값</th><td colSpan={3}>{fmt(bivariate.pValue)}</td></tr>
        </tbody>
      </table>
      <BivariateFooter bivariate={bivariate} />
    </div>
  );
}

function BivariateResultCard({ bivariate }) {
  if (bivariate.suppressed) return <BivariateSuppressedCard bivariate={bivariate} />;
  if (CONTINGENCY_METHODS.has(bivariate.method)) return <ContingencyCard bivariate={bivariate} />;
  if (GROUP_COMPARISON_METHODS.has(bivariate.method)) return <GroupComparisonCard bivariate={bivariate} />;
  return <CorrelationCard bivariate={bivariate} />;
}

// PR3-B(차트 프리미티브)까지는 distribution 탭을 열지 않는다 — 이 계획 범위 밖.
const TABS = [
  { id: 'summary', label: '요약', enabled: true },
  { id: 'distribution', label: '분포', enabled: false },
  { id: 'association', label: '연관성', enabled: true },
  { id: 'regression', label: '회귀', enabled: false },
];

// PR2 §6/§8 — 결과 패널. committed(마지막 실행 성공 시점의 recipe/result)만 참조하고,
// draft가 그 이후 바뀌면 배너로만 알린다(실행된 결과-조건 연결은 절대 안 바뀜, §6).
// PR3-A — 탭 상태(activeTab)를 신설해 "연관성" 탭에 이변량 결과 카드를 배선한다.
export function ResultPanel({
  catalog, committedRecipe, committedResult, recipeChanged,
  onExport, exportState, actionsLocked, exportUnsupported,
}) {
  const catalogByKey = new Map((catalog?.variables ?? []).map((v) => [v.key, v]));
  const [activeTab, setActiveTab] = useState('summary');
  const isBivariateRun = committedRecipe?.analysisMode === 'bivariate';

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

        {!committedResult && <div className="swb-empty">좌측에서 변수를 선택하고 "분석 실행"을 눌러주세요.</div>}

        {committedResult && activeTab === 'summary' && (
          isBivariateRun ? (
            <p className="swb-suppressed-note">이변량 분석 결과는 "연관성" 탭에서 확인하세요.</p>
          ) : (
            <>
              <div className="swb-section-label">연속형</div>
              {committedResult.result.continuous.length === 0 && <p className="swb-suppressed-note">선택된 연속형 변수 없음</p>}
              {committedResult.result.continuous.map((row) => (
                <ContinuousCard key={row.variableKey} catalogByKey={catalogByKey} row={row} />
              ))}

              <div className="swb-section-label">이산형</div>
              {committedResult.result.discrete.length === 0 && <p className="swb-suppressed-note">선택된 이산형 변수 없음</p>}
              {committedResult.result.discrete.map((row) => (
                <DiscreteCard key={row.variableKey} catalogByKey={catalogByKey} row={row} />
              ))}
            </>
          )
        )}

        {committedResult && activeTab === 'association' && (
          isBivariateRun && committedResult.result.bivariate ? (
            <BivariateResultCard bivariate={committedResult.result.bivariate} />
          ) : (
            <p className="swb-suppressed-note">이변량 모드로 분석을 실행하면 여기에 결과가 표시됩니다.</p>
          )
        )}

        {committedResult && !isBivariateRun && (
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
        {committedResult && isBivariateRun && (
          <p className="swb-suppressed-note" style={{ marginTop: 12 }}>이변량 결과는 아직 CSV 내보내기를 지원하지 않습니다.</p>
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

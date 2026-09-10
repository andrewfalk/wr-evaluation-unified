import { describeStatsApiError } from './describeStatsError';

const NULL_REASON_LABELS = {
  insufficient_data: '자료 부족',
  undefined_zero_variance: '분산 0(정의 불가)',
  non_finite_result: '유한하지 않은 값',
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

const TABS = [
  { id: 'summary', label: '요약', enabled: true },
  { id: 'distribution', label: '분포', enabled: false },
  { id: 'association', label: '연관성', enabled: false },
  { id: 'regression', label: '회귀', enabled: false },
];

// PR2 §6/§8 — 결과 패널. committed(마지막 실행 성공 시점의 recipe/result)만 참조하고,
// draft가 그 이후 바뀌면 배너로만 알린다(실행된 결과-조건 연결은 절대 안 바뀜, §6).
export function ResultPanel({
  catalog, committedRecipe, committedResult, recipeChanged,
  onExport, exportState, actionsLocked,
}) {
  const catalogByKey = new Map((catalog?.variables ?? []).map((v) => [v.key, v]));

  return (
    <section className="swb-result" aria-label="결과">
      <div className="swb-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`swb-tab${t.id === 'summary' ? ' swb-tab--active' : ''}`}
            disabled={!t.enabled}
            title={t.enabled ? undefined : '현재 제공하지 않음'}
          >{t.label}</button>
        ))}
      </div>

      <div className="swb-result-body">
        {recipeChanged && committedResult && (
          <div className="swb-banner" style={{ marginBottom: 12 }}>조건이 변경됨 — 다시 실행 필요</div>
        )}

        {!committedResult && <div className="swb-empty">좌측에서 변수를 선택하고 "분석 실행"을 눌러주세요.</div>}

        {committedResult && (
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

            <button
              type="button"
              className="swb-btn"
              style={{ marginTop: 12 }}
              disabled={exportState.status === 'exporting' || actionsLocked}
              title={actionsLocked ? '기능을 사용할 수 없는 동안은 내보낼 수 없습니다.' : undefined}
              onClick={onExport}
            >
              {exportState.status === 'exporting' ? '내보내는 중…' : '집계 결과 내보내기 (CSV)'}
            </button>
            {exportState.status === 'error' && (
              <p className="swb-status-danger" style={{ whiteSpace: 'pre-wrap' }}>내보내기 실패: {describeStatsApiError(exportState.error)}</p>
            )}
          </>
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

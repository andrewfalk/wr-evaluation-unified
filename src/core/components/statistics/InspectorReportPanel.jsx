import { useState } from 'react';

function SuppressedVariablesList({ catalogByKey, committedResult }) {
  const rows = [
    ...(committedResult?.result?.continuous ?? []),
    ...(committedResult?.result?.discrete ?? []),
  ].filter((row) => row.suppressed);
  if (rows.length === 0) {
    return <p className="swb-suppressed-note">이번 실행에서 억제된 변수: 없음</p>;
  }
  return (
    <p className="swb-suppressed-note">
      이번 실행에서 억제된 변수: {rows.map((row) => catalogByKey.get(row.variableKey)?.label || row.variableKey).join(', ')}
    </p>
  );
}

// PR2 §5.6.3/§8 — 우측 Inspector/리포트 2탭. 둘 다 committed 실행 결과만 참조한다(draft가
// 바뀌어도 이미 실행된 결과의 provenance는 안 바뀐다, §6).
export function InspectorReportPanel({ catalog, committedRecipe, committedResult, collapsed, onToggleCollapse }) {
  const [tab, setTab] = useState('inspector');
  const catalogByKey = new Map((catalog?.variables ?? []).map((v) => [v.key, v]));

  if (collapsed) {
    return (
      <aside className="swb-panel swb-panel--collapsed swb-panel--right" aria-label="Inspector/리포트(접힘)">
        <div className="swb-panel-header">
          <button type="button" className="swb-collapse-btn" onClick={onToggleCollapse} aria-expanded={false} title="펼치기">‹</button>
        </div>
        <div className="swb-panel-rail">Inspector · 리포트</div>
      </aside>
    );
  }

  const manifest = committedResult?.runManifest;

  return (
    <aside className="swb-panel swb-panel--right" aria-label="Inspector/리포트">
      <div className="swb-panel-header">
        <div className="swb-seg">
          <button
            type="button"
            className={`swb-seg-opt${tab === 'inspector' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => setTab('inspector')}
          >Inspector</button>
          <button
            type="button"
            className={`swb-seg-opt${tab === 'report' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => setTab('report')}
          >리포트</button>
        </div>
        <button type="button" className="swb-collapse-btn" onClick={onToggleCollapse} aria-expanded title="접기">›</button>
      </div>
      <div className="swb-panel-body">
        {!manifest && <div className="swb-empty">실행된 분석이 없습니다.</div>}

        {manifest && tab === 'inspector' && (
          <>
            <div className="swb-section-label">Run Manifest</div>
            <table className="swb-table">
              <tbody>
                <tr><th>analysisRunId</th><td>{manifest.analysisRunId}</td></tr>
                <tr><th>snapshotAsOf</th><td>{manifest.snapshotAsOf}</td></tr>
                <tr><th>recipeDigest</th><td>{manifest.recipeDigest}</td></tr>
                <tr><th>sourceDigest</th><td>{manifest.sourceDigest}</td></tr>
                {/* 5차 리뷰가 잡은 누락 — resultDigest·manifest.formulaPolicies가 빠져 있었다. */}
                <tr><th>resultDigest</th><td>{manifest.resultDigest}</td></tr>
                <tr><th>catalogVersion</th><td>{manifest.catalogVersion}</td></tr>
                <tr><th>extractorVersion</th><td>{manifest.extractorVersion}</td></tr>
                <tr><th>migrationVersion</th><td>{manifest.migrationVersion}</td></tr>
                <tr><th>engineVersion</th><td>{manifest.engineVersion}</td></tr>
                <tr><th>serializerVersion</th><td>{manifest.serializerVersion}</td></tr>
                <tr><th>estimabilityPolicyVersion</th><td>{manifest.estimabilityPolicyVersion}</td></tr>
                {/* PR3-A 신규 필드 — 둘 다 optional(구버전 저장 결과엔 없을 수 있음). */}
                {manifest.analysisMode && <tr><th>analysisMode</th><td>{manifest.analysisMode}</td></tr>}
                {manifest.inferenceGatePolicyVersion && (
                  <tr><th>inferenceGatePolicyVersion</th><td>{manifest.inferenceGatePolicyVersion}</td></tr>
                )}
                <tr>
                  <th>formulaPolicies</th>
                  <td>
                    {Object.keys(manifest.formulaPolicies || {}).length === 0
                      ? '(없음)'
                      : Object.entries(manifest.formulaPolicies).map(([family, policy]) => `${family}=${policy}`).join(', ')}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="swb-section-label">Recipe</div>
            <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(committedRecipe, null, 2)}
            </pre>
          </>
        )}

        {manifest && tab === 'report' && (
          <>
            <div className="swb-section-label">억제</div>
            <p className="swb-suppressed-note">
              소수 셀(최소 표본 {catalog?.minimumCohort ?? '—'}명 미달)은 변수 전체 또는 결측사유 단위로 연결 억제됩니다. 부분 마스킹은 하지 않습니다.
            </p>
            {/* 5차 리뷰가 잡은 누락 — 일반 설명뿐이고 실제 이번 실행에서 어떤 변수가 억제됐는지가 없었다. */}
            <SuppressedVariablesList catalogByKey={catalogByKey} committedResult={committedResult} />
            <div className="swb-section-label">다중검정 보정</div>
            {/* PR3-A §"BH-FDR/Holm 범위 정직화" — 레시피가 항상 변수 2개(p값 1개)만
                만들므로 "다중검정 보정을 지원한다"고 말하지 않는다. bh_fdr/holm
                함수는 구현·검증됐지만 이 레시피 구조에선 실제로 m=1로만 호출된다. */}
            {committedResult?.result?.bivariate && !committedResult.result.bivariate.suppressed ? (
              <p className="swb-suppressed-note">
                단일 검정(보정 없음) — raw p = adjusted p = {committedResult.result.bivariate.pValue ?? '—'}
                (method: {committedResult.result.bivariate.multipleTesting?.method ?? 'none'})
              </p>
            ) : (
              <p className="swb-suppressed-note">현재는 검정이 1개뿐이라 다중검정 보정이 적용되지 않습니다.</p>
            )}
            <div className="swb-section-label">반출 형식</div>
            <p>현재 제공되는 반출 형식: 집계 결과(aggregate). 실제 권한 여부는 내보내기 버튼을 눌러야 서버가 최종 확인합니다.</p>
            <table className="swb-table">
              <thead><tr><th>등급</th><th>대상</th></tr></thead>
              <tbody>
                <tr><td>집계(aggregate)</td><td>집계표·회귀 결과</td></tr>
                <tr><td>제한데이터</td><td>관리자 문의</td></tr>
                <tr><td>PHI 포함</td><td>관리자 문의</td></tr>
              </tbody>
            </table>
            <div className="swb-section-label">감사</div>
            <p className="swb-suppressed-note">이 실행은 감사 로그에 기록됩니다.</p>
          </>
        )}
      </div>
    </aside>
  );
}

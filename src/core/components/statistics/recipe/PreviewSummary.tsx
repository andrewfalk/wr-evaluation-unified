// 분석 범위 미리보기 요약 — P2-79b에서 RecipePanel.tsx의 선언을 본문 그대로 옮겼다.
import { describeStatsApiError } from '../describeStatsError';
import type { PreviewResponse } from '@wr/contracts/stats';
import type { RecipePreviewState, CatalogByKey } from './types';

export function PreviewSummary({ previewState, isPreviewCurrent, catalogByKey }: { previewState: RecipePreviewState; isPreviewCurrent: boolean; catalogByKey: CatalogByKey }) {
  if (!isPreviewCurrent || previewState.status === 'idle') {
    return <p className="swb-suppressed-note">변수를 선택하면 미리보기가 표시됩니다.</p>;
  }
  if (previewState.status === 'loading') {
    return <p className="swb-suppressed-note">미리보기 계산 중…</p>;
  }
  if (previewState.status === 'error') {
    return <p className="swb-status-danger" style={{ whiteSpace: 'pre-wrap' }}>미리보기 실패: {describeStatsApiError(previewState.error, { catalogByKey, analysisPurpose: previewState.requestPurpose })}</p>;
  }
  const { counts, estimability } = previewState.result as PreviewResponse;
  if (counts.suppressed) {
    const reason = counts.reasonCode === 'DIFFERENCING_RATE_LIMIT'
      ? '짧은 시간 내 반복 조회 제한에 걸렸습니다.'
      : `최소 표본(${counts.minimumCohort}명) 미달로 표시할 수 없습니다.`;
    return <p className="swb-status-warn">{reason}</p>;
  }
  // 제한데이터 권한자가 소수 셀 억제를 실제로 푼 미리보기(서버가 풀 것이 있었을 때만 표시한다).
  const limitedApplied = (previewState.result as PreviewResponse).limitedDisclosure === 'applied';
  // 추정가능성의 `—`/`비공개`는 소수 인원(1~9명) 보호로 숨겨진 값이다. 0명인 경우와는 서버 응답으로 구분되지
  // 않으므로(같은 null) "숨겨질 수 있다"는 중립 문구만 쓴다.
  const hasHiddenEstimability = estimability.completeCaseN === null
    || Object.values(estimability.missingRatesByVariable).some((rate) => rate === null)
    || estimability.eventNonEvent.some((e) => e.suppressed);
  return (
    <>
      {limitedApplied && (
        <div className="swb-banner" role="status" style={{ marginBottom: 8 }}>
          제한데이터 권한: 소수 인원(10명 미만) 보호가 해제된 미리보기입니다.
        </div>
      )}
      <div className="swb-metric-grid">
        <div className="swb-metric">
          <div className="swb-metric-value">{counts.personCount}</div>
          <div className="swb-metric-label">person</div>
        </div>
        <div className="swb-metric">
          <div className="swb-metric-value">{counts.caseCount}</div>
          <div className="swb-metric-label">case</div>
        </div>
        <div className="swb-metric">
          <div className="swb-metric-value">{counts.observationCount}</div>
          <div className="swb-metric-label">observation</div>
        </div>
      </div>
      {/* 5차 리뷰가 잡은 누락 — completeCaseN·변수별 결측률·event/non-event를 표시하지 않으면
          estimability 정보를 아예 확인할 방법이 없었다(§6.3). */}
      <table className="swb-table">
        <tbody>
          <tr><th>완전사례 수</th><td>{estimability.completeCaseN ?? '—'}</td></tr>
          {estimability.distinctAssignedDoctorClusters !== null && (
            <tr><th>담당의 클러스터 수</th><td>{estimability.distinctAssignedDoctorClusters}</td></tr>
          )}
          {Object.entries(estimability.missingRatesByVariable).map(([key, rate]) => (
            <tr key={key}>
              <th>결측률({catalogByKey.get(key)?.label || key})</th>
              <td>{rate === null ? '비공개' : `${(rate * 100).toFixed(1)}%`}</td>
            </tr>
          ))}
          {estimability.eventNonEvent.map((e) => (
            <tr key={e.variableKey}>
              <th>event/non-event({catalogByKey.get(e.variableKey)?.label || e.variableKey})</th>
              <td>{e.suppressed ? '비공개' : `${e.events} / ${e.nonEvents}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasHiddenEstimability && (
        <p className="swb-suppressed-note">
          <strong>—</strong>·<strong>비공개</strong>는 소수 인원 보호로 숨겨진 값일 수 있습니다.
        </p>
      )}
    </>
  );
}

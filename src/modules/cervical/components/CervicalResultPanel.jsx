function FlagPill({ flag }) {
  return (
    <span className={`cervical-flag-pill tone-${flag.tone || 'neutral'}`} title={flag.description || ''}>
      <span>{flag.label}</span>
    </span>
  );
}

function MissingList({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="result-note">
      <strong>입력 누락</strong>
      <div>{items.join(', ')}</div>
    </div>
  );
}

function SummaryCard({ summary }) {
  const riskFactorSummary = summary.riskFactorItems?.length > 0
    ? summary.riskFactorItems.map(flag => flag.label).join(', ')
    : '확인된 위험 요인 없음';

  return (
    <div className="result-detail-card">
      <div className="result-card-title">{summary.jobName || '직업 미입력'}</div>
      <div className="result-card-meta">
        완료 {summary.missingFields.length === 0 ? '예' : '아니오'}
        {' · '}
        위험 요인 {summary.riskFactorCount}개
      </div>

      <div className="cervical-flag-list">
        {summary.flagItems.length > 0
          ? summary.flagItems.map(flag => <FlagPill key={flag.key} flag={flag} />)
          : <span className="result-card-meta">표시할 플래그 없음</span>}
      </div>

      <MissingList items={summary.missingFields} />

      <div className="report-preview ai-result-panel cervical-summary-panel">
        <div className="report-preview-toolbar">
          <span className="report-preview-label">분석 정리</span>
        </div>
        <div className="preview-section cervical-summary-copy">
          <div style={{ whiteSpace: 'pre-line' }}>{summary.narrative}</div>
          <div><strong>업무관련성 위험 요인:</strong> {riskFactorSummary}</div>
          <div className="cervical-summary-conclusion"><strong>종합평가:</strong> {summary.conclusionText}</div>
        </div>
      </div>
    </div>
  );
}

export function CervicalResultPanel({ calc }) {
  if (!calc) return null;

  return (
    <div className="panel">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>경추 부담 분석</h2>
          <p className="section-description">BK2109형 정량 신호와 비중립·정적 목 부하를 함께 정리합니다.</p>
        </div>
      </div>

      <div className="result-panel">
        <div className="result-detail-stack">
          {(calc.jobSummaries || []).map(jobSummary => (
            <div key={jobSummary.sharedJobId} className="result-detail-card">
              <div className="result-card-title">{jobSummary.jobName || '직업 미입력'}</div>
              <div className="result-card-meta">
                완료 {jobSummary.completedCount}/{jobSummary.diagnosisSummaries.length}
                {' · '}
                표시 신호 {jobSummary.flaggedCount}개
              </div>
              <div className="result-detail-stack">
                {jobSummary.diagnosisSummaries.map(summary => (
                  <SummaryCard key={`${summary.sharedJobId}_${summary.diagnosisId}`} summary={summary} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {(calc.jobSummaries || []).length === 0 && (
          <div className="evaluation-empty-state">직업 또는 경추 상병이 없어 결과를 표시할 수 없습니다.</div>
        )}
      </div>
    </div>
  );
}

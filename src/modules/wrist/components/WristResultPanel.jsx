import { BK_TYPE_LABELS } from '../utils/data';
import { formatCommonExposureTypeText } from '../utils/calculations';

const TASK_CHANGE_OPTIONS = [
  { value: 'none', label: '변화 없음' },
  { value: 'increased_load', label: '부담 증가' },
  { value: 'process_change', label: '공정 변경' },
  { value: 'new_task', label: '신규 작업' },
];

const REST_OPTIONS = [
  { value: 'yes', label: '예' },
  { value: 'no', label: '아니오' },
];

function FlagPill({ flag }) {
  return (
    <span className={`wrist-flag-pill tone-${flag.tone || 'neutral'}`} title={flag.description || ''}>
      <span className="wrist-flag-icon">{flag.icon}</span>
      <span>{flag.label}</span>
    </span>
  );
}

function MissingList({ title, items }) {
  if (!items || items.length === 0) return null;

  return (
    <div className="result-note">
      <strong>{title}</strong>
      <div className="wrist-note-list">{items.join(', ')}</div>
    </div>
  );
}

function getSideLabel(side) {
  return side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';
}

function TemporalSequenceSection({ temporalSequence, onChange }) {
  return (
    <section className="section pattern-surface form-section">
      <div className="section-header wrist-analysis-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4C5;</span>시간적 선후관계</h2>
          <p className="section-description">작업 변화와 증상 발생의 시간 흐름을 손목 모듈 전체에 공통으로 입력합니다.</p>
        </div>
      </div>

      <div className="job-card">
        <div className="form-group">
          <label>최근 작업변화</label>
          <div className="radio-group">
            {TASK_CHANGE_OPTIONS.map(option => (
              <label key={option.value} className="radio-label">
                <input
                  type="radio"
                  name="wrist_recent_task_change"
                  value={option.value}
                  checked={temporalSequence.recent_task_change === option.value}
                  onChange={e => onChange('recent_task_change', e.target.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>작업변화 시점</label>
            <input type="date" value={temporalSequence.task_change_date} onChange={e => onChange('task_change_date', e.target.value)} />
          </div>
          <div className="form-group">
            <label>작업변화 후 증상발생까지 기간</label>
            <input
              value={temporalSequence.symptom_onset_interval}
              onChange={e => onChange('symptom_onset_interval', e.target.value)}
              placeholder="예: 2주, 3개월"
            />
          </div>
        </div>

        <div className="form-group">
          <label>휴식/업무중단 시 호전</label>
          <div className="radio-group">
            {REST_OPTIONS.map(option => (
              <label key={option.value} className="radio-label">
                <input
                  type="radio"
                  name="wrist_improves_with_rest"
                  value={option.value}
                  checked={temporalSequence.improves_with_rest === option.value}
                  onChange={e => onChange('improves_with_rest', e.target.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SummaryCard({ summary }) {
  const diag = summary.diagnosis || {};
  const entry = summary.entry || {};
  const exposureTypes = formatCommonExposureTypeText(entry);
  const riskFactorSummary = summary.riskFactorItems?.length > 0
    ? summary.riskFactorItems.map(flag => flag.label).join(', ')
    : '확인된 위험 요인 없음';

  return (
    <div className="result-detail-card wrist-summary-card">
      <div className="result-card-title">{diag.code || '-'} {diag.name || '손목 상병'}</div>
      <div className="result-card-meta">
        {summary.jobName || '직업 미입력'}
        {' · '}
        {getSideLabel(diag.side)}
        {' · '}
        {BK_TYPE_LABELS[entry.selectedBkType] || 'BK 유형 미선택'}
        {' · '}
        {entry.bkSelectionMode === 'manual' ? '수동 선택' : (entry.selectedBkType ? '자동 제안' : '자동 제안 없음')}
      </div>

      <div className="result-metric-list">
        <div className="result-metric-row"><span>문제 작업</span><strong>{entry.main_task_name || '-'}</strong></div>
        <div className="result-metric-row"><span>공통 노출 유형</span><strong>{exposureTypes}</strong></div>
        <div className="result-metric-row"><span>1일 노출시간</span><strong>{entry.daily_exposure_hours || '-'}시간</strong></div>
        <div className="result-metric-row"><span>근무시간 비중</span><strong>{entry.shift_share_percent || '-'}%</strong></div>
      </div>

      <div className="wrist-flag-list">
        {summary.flagItems.length > 0
          ? summary.flagItems.map(flag => <FlagPill key={flag.key} flag={flag} />)
          : <span className="result-card-meta">표시할 신호 없음</span>}
      </div>

      <MissingList title="입력 누락" items={summary.missingFields} />

      <div className="report-preview ai-result-panel wrist-summary-panel">
        <div className="report-preview-toolbar">
          <span className="report-preview-label">분석 정리</span>
        </div>
        <div className="preview-section wrist-summary-copy">
          <div>{summary.narrative}</div>
          <div><strong>업무관련성 위험 요인:</strong> {riskFactorSummary}</div>
          <div className="wrist-summary-conclusion"><strong>종합평가</strong> {summary.riskFactorSentence}</div>
        </div>
      </div>
    </div>
  );
}

export function WristResultPanel({ calc, temporalSequence, onTemporalChange }) {
  if (!calc) return null;

  return (
    <div className="panel">
      <TemporalSequenceSection temporalSequence={temporalSequence} onChange={onTemporalChange} />

      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>손목/손가락 부담 분석</h2>
          <p className="section-description">직업별 요약과 진단별 주요 신호를 시각적으로 정리합니다.</p>
        </div>
      </div>

      <div className="result-panel wrist-result-panel">
        {calc.missingCommonFields?.length > 0 && (
          <div className="wrist-result-spacing">
            <MissingList title="공통 시간적 선후관계 입력 누락" items={calc.missingCommonFields} />
          </div>
        )}

        <div className="result-detail-stack">
          {(calc.jobSummaries || []).map(jobSummary => (
            <div key={jobSummary.sharedJobId} className="result-detail-card">
              <div className="result-card-title">{jobSummary.jobName || '직업 미입력'}</div>
              <div className="result-card-meta">
                완료 {jobSummary.completedCount}/{jobSummary.diagnosisSummaries.length}
                {' · '}
                표시 신호 {jobSummary.flagCount}개
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
          <div className="evaluation-empty-state">직업 또는 손목 상병이 없어 결과를 표시할 수 없습니다.</div>
        )}
      </div>
    </div>
  );
}

import { BK_TYPE_LABELS } from '../utils/data';
import { formatCommonExposureTypeText, groupSummariesByBkType, mergeBkGroupSummaries } from '../utils/calculations';
import { getSideText } from '../../../core/i18n/sideLabels';
import type { DiagnosisSummary, ElbowCalcResult } from '@wr/analytics-core/modules/elbow/index';
import { BkGroupSummaryCard, MissingList, SummaryCard } from '../../_shared/upperLimb/ResultCards';
import type { UpperLimbResultCardConfig } from '../../_shared/upperLimb/ResultCards';
import type { ElbowTemporalSequence } from '../utils/data';

type TemporalField = keyof ElbowTemporalSequence;

const TASK_CHANGE_OPTIONS = [
  { value: 'none', label: '변화 없음' },
  { value: 'increased_load', label: '부하 증가' },
  { value: 'process_change', label: '공정 변경' },
  { value: 'new_task', label: '신규 작업' },
];

const REST_OPTIONS = [
  { value: 'yes', label: '예' },
  { value: 'no', label: '아니오' },
];

function TemporalSequenceSection({ temporalSequence, onChange }: { temporalSequence: ElbowTemporalSequence; onChange: (field: TemporalField, value: string) => void }) {
  return (
    <section className="section pattern-surface form-section">
      <div className="section-header elbow-analysis-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4C5;</span>시간적 선후관계</h2>
          <p className="section-description">작업 변화와 증상 발생 순서를 팔꿈치 모듈 전체에 공통으로 한 번 입력합니다.</p>
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
                  name="elbow_recent_task_change"
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
          <label>휴가/업무중단 시 호전</label>
          <div className="radio-group">
            {REST_OPTIONS.map(option => (
              <label key={option.value} className="radio-label">
                <input
                  type="radio"
                  name="elbow_improves_with_rest"
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

// 결과 카드(상병 요약·BK 묶음 요약·신호 알약·입력 누락)는 팔꿈치·손목 공용(_shared/upperLimb/ResultCards, P2-72b) — 이 모듈의
// className 접두·라벨을 넘긴다. 패널 본문(시간적 선후관계·직업별 묶음)은 손목과 두 벌로 남는다(P2-71 twinParity가 지킨다).
const CARD_CONFIG: UpperLimbResultCardConfig<DiagnosisSummary> = {
  classPrefix: 'elbow',
  emptyDiagnosisName: '팔꿈치 상병',
  labels: { exposureTypes: '공통 핵심 노출유형', shiftShare: '하루 작업 비중', riskFactors: '업무에 포함된 위험 요인:' },
  bkLabels: BK_TYPE_LABELS,
  getSideText,
  formatExposureTypes: formatCommonExposureTypeText,
  mergeGroups: mergeBkGroupSummaries,
};

export interface ElbowResultPanelProps {
  calc: ElbowCalcResult | null | undefined;
  temporalSequence: ElbowTemporalSequence;
  onTemporalChange: (field: TemporalField, value: string) => void;
}

export function ElbowResultPanel({ calc, temporalSequence, onTemporalChange }: ElbowResultPanelProps) {
  if (!calc) return null;

  return (
    <div className="panel">
      <TemporalSequenceSection temporalSequence={temporalSequence} onChange={onTemporalChange} />

      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>팔꿈치 신체부담 분석</h2>
          <p className="section-description">직업별 요약과 진단별 주요 신호를 시각적으로 정리합니다.</p>
        </div>
      </div>

      <div className="result-panel elbow-result-panel">
        {calc.missingCommonFields?.length > 0 && (
          <div className="elbow-result-spacing">
            <MissingList classPrefix="elbow" title="공통 시간적 선후관계 입력 누락" items={calc.missingCommonFields} />
          </div>
        )}

        <div className="result-detail-stack">
          {(calc.jobSummaries || []).map(jobSummary => (
            <div key={jobSummary.sharedJobId} className="result-detail-card">
              <div className="result-card-title">{jobSummary.jobName || '직업 미입력'}</div>
              <div className="result-card-meta">
                완료 {jobSummary.completedCount}/{jobSummary.diagnosisSummaries.length}
                {' · '}
                활성 신호 {jobSummary.flagCount}개
              </div>
              <div className="result-detail-stack">
                {groupSummariesByBkType(jobSummary.diagnosisSummaries || []).map(group =>
                  group.isGrouped
                    ? <BkGroupSummaryCard key={group.bkType} group={group} config={CARD_CONFIG} />
                    : <SummaryCard key={`${group.summaries[0]?.sharedJobId}_${group.summaries[0]?.diagnosisId}`} summary={group.summaries[0]} config={CARD_CONFIG} />
                )}
              </div>
            </div>
          ))}
        </div>

        {(calc.jobSummaries || []).length === 0 && (
          <div className="evaluation-empty-state">직업 또는 팔꿈치 상병이 없어 결과를 표시할 수 없습니다.</div>
        )}

      </div>
    </div>
  );
}

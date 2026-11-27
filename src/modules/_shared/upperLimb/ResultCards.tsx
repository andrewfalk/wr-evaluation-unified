// 팔꿈치·손목 공용 결과 카드(REFACTORING_ROADMAP Phase 2 C8, P2-72b) — 상병 하나의 요약 카드(SummaryCard), 같은 BK 유형으로
// 묶인 상병의 요약 카드(BkGroupSummaryCard), 표시 신호 알약(FlagPill), 입력 누락 목록(MissingList).
// 두 결과 패널에서 라벨과 className 접두만 다른 같은 코드였다. 모듈마다 다른 것은 config로 받는다 — className 접두
// (`elbow`·`wrist` — 지금과 같은 className을 낸다, `.ul-` 통합은 C10), 빈 상병 이름, 지표·위험 요인 라벨, BK 유형 라벨,
// 공통 노출 유형 문구·그룹 합치기(모듈 계산의 함수). 결과 패널 본문(시간적 선후관계·직업별 묶음)은 두 벌로 남는다.

/** 카드가 읽는 표시 신호의 모양(모듈 계산의 FlagItem). */
export interface UpperLimbFlagLike {
  key: string;
  label: string;
  tone?: string;
  description?: string;
  icon?: string;
}

/** 카드가 읽는 상병 요약의 모양(모듈 계산의 DiagnosisSummary). */
export interface UpperLimbResultSummary {
  jobName: string;
  diagnosis?: { code?: string; name?: string; side?: string };
  entry?: {
    selectedBkType?: string;
    bkSelectionMode?: string;
    main_task_name?: string;
    daily_exposure_hours?: string | number;
    shift_share_percent?: string | number;
  };
  flagItems: UpperLimbFlagLike[];
  riskFactorItems: UpperLimbFlagLike[];
  missingFields: string[];
  narrative: string;
  riskFactorSentence: string;
}

export interface UpperLimbResultCardConfig<S extends UpperLimbResultSummary> {
  classPrefix: string;
  /** 상병 이름이 비었을 때(`팔꿈치 상병`·`손목 상병`). */
  emptyDiagnosisName: string;
  labels: {
    /** 공통 노출 유형 지표(`공통 핵심 노출유형`·`공통 노출 유형`). */
    exposureTypes: string;
    /** 근무시간 비중 지표(`하루 작업 비중`·`근무시간 비중`). */
    shiftShare: string;
    /** 위험 요인 줄(`업무에 포함된 위험 요인:`·`업무관련성 위험 요인:`). */
    riskFactors: string;
  };
  bkLabels: Record<string, string>;
  getSideText(side: string | undefined): string;
  formatExposureTypes(entry: NonNullable<S['entry']>): string;
  mergeGroups(summaries: S[]): S;
}

export function FlagPill({ flag, classPrefix }: { flag: UpperLimbFlagLike; classPrefix: string }) {
  return (
    <span className={`${classPrefix}-flag-pill tone-${flag.tone || 'neutral'}`} title={flag.description || ''}>
      <span className={`${classPrefix}-flag-icon`}>{flag.icon}</span>
      <span>{flag.label}</span>
    </span>
  );
}

export function MissingList({ title, items, classPrefix }: { title: string; items: string[] | undefined; classPrefix: string }) {
  if (!items || items.length === 0) return null;

  return (
    <div className="result-note">
      <strong>{title}</strong>
      <div className={`${classPrefix}-note-list`}>{items.join(', ')}</div>
    </div>
  );
}

export function SummaryCard<S extends UpperLimbResultSummary>({ summary, config }: { summary: S; config: UpperLimbResultCardConfig<S> }) {
  const p = config.classPrefix;
  const diag: NonNullable<UpperLimbResultSummary['diagnosis']> = summary.diagnosis || {};
  const entry = (summary.entry || {}) as NonNullable<S['entry']>;
  const exposureTypes = config.formatExposureTypes(entry);
  const riskFactorSummary = summary.riskFactorItems?.length > 0
    ? summary.riskFactorItems.map(flag => flag.label).join(', ')
    : '확인된 위험 요인 없음';

  return (
    <div className={`result-detail-card ${p}-summary-card`}>
      <div className="result-card-title">{diag.code || '-'} {diag.name || config.emptyDiagnosisName}</div>
      <div className="result-card-meta">
        {summary.jobName || '직업 미입력'}
        {' · '}
        {config.getSideText(diag.side)}
        {' · '}
        {config.bkLabels[entry.selectedBkType as string] || 'BK 유형 미선택'}
        {' · '}
        {entry.bkSelectionMode === 'manual' ? '수동 선택' : (entry.selectedBkType ? '자동 제안' : '자동 제안 없음')}
      </div>

      <div className="result-metric-list">
        <div className="result-metric-row"><span>문제 작업</span><strong>{entry.main_task_name || '-'}</strong></div>
        <div className="result-metric-row"><span>{config.labels.exposureTypes}</span><strong>{exposureTypes}</strong></div>
        <div className="result-metric-row"><span>1일 노출시간</span><strong>{entry.daily_exposure_hours || '-'}시간</strong></div>
        <div className="result-metric-row"><span>{config.labels.shiftShare}</span><strong>{entry.shift_share_percent || '-'}%</strong></div>
      </div>

      <div className={`${p}-flag-list`}>
        {summary.flagItems.length > 0
          ? summary.flagItems.map(flag => <FlagPill key={flag.key} flag={flag} classPrefix={p} />)
          : <span className="result-card-meta">표시할 신호 없음</span>}
      </div>

      <MissingList title="입력 누락" items={summary.missingFields} classPrefix={p} />

      <div className={`report-preview ai-result-panel ${p}-summary-panel`}>
        <div className="report-preview-toolbar">
          <span className="report-preview-label">분석 정리</span>
        </div>
        <div className={`preview-section ${p}-summary-copy`}>
          <div>{summary.narrative}</div>
          <div><strong>{config.labels.riskFactors}</strong> {riskFactorSummary}</div>
          <div className={`${p}-summary-conclusion`}><strong>종합평가</strong> {summary.riskFactorSentence}</div>
        </div>
      </div>
    </div>
  );
}

export function BkGroupSummaryCard<S extends UpperLimbResultSummary>({ group, config }: { group: { bkType: string; summaries: S[] }; config: UpperLimbResultCardConfig<S> }) {
  const p = config.classPrefix;
  const merged = config.mergeGroups(group.summaries);
  const representativeEntry = (merged.entry || {}) as NonNullable<S['entry']>;
  const exposureTypes = config.formatExposureTypes(representativeEntry);
  const riskFactorSummary = merged.riskFactorItems?.length > 0
    ? merged.riskFactorItems.map(flag => flag.label).join(', ')
    : '확인된 위험 요인 없음';
  const diagSubtitle = group.summaries
    .map(s => {
      const d: NonNullable<UpperLimbResultSummary['diagnosis']> = s.diagnosis || {};
      return `${d.code || ''} ${d.name || ''}`.trim();
    })
    .join(' / ');

  return (
    <div className={`result-detail-card ${p}-summary-card`}>
      <div className="result-card-title">{config.bkLabels[group.bkType] || group.bkType}</div>
      <div className="result-card-meta">{diagSubtitle}</div>

      <div className="result-metric-list">
        <div className="result-metric-row"><span>문제 작업</span><strong>{representativeEntry.main_task_name || '-'}</strong></div>
        <div className="result-metric-row"><span>{config.labels.exposureTypes}</span><strong>{exposureTypes}</strong></div>
        <div className="result-metric-row"><span>1일 노출시간</span><strong>{representativeEntry.daily_exposure_hours || '-'}시간</strong></div>
        <div className="result-metric-row"><span>{config.labels.shiftShare}</span><strong>{representativeEntry.shift_share_percent || '-'}%</strong></div>
      </div>

      <div className={`${p}-flag-list`}>
        {merged.flagItems?.length > 0
          ? merged.flagItems.map(flag => <FlagPill key={flag.key} flag={flag} classPrefix={p} />)
          : <span className="result-card-meta">표시할 신호 없음</span>}
      </div>

      <MissingList title="입력 누락" items={merged.missingFields} classPrefix={p} />

      <div className={`report-preview ai-result-panel ${p}-summary-panel`}>
        <div className="report-preview-toolbar">
          <span className="report-preview-label">분석 정리</span>
        </div>
        <div className={`preview-section ${p}-summary-copy`}>
          <div>{merged.narrative}</div>
          <div><strong>{config.labels.riskFactors}</strong> {riskFactorSummary}</div>
          <div className={`${p}-summary-conclusion`}><strong>종합평가</strong> {merged.riskFactorSentence}</div>
        </div>
      </div>
    </div>
  );
}

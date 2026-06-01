import { Fragment } from 'react';
import { thresholds } from '../utils/thresholds';
import { convertTimeToSeconds, classifySpineSeverity } from '../utils/calculations';
import { getSpineInterpretation } from '../utils/sectionText';
import { SPINE_FORMULA_V513 } from '../utils/formulaVersion';

export function SpineResultPanel({ calc }) {
  // present일 때만 결과 패널 표시. unknown(미평가)·none(노출없음)은 공간 절약을 위해 미표시.
  const mddmStatus = calc?.mddmStatus || (calc?.dailyDose ? 'present' : 'unknown');
  if (mddmStatus !== 'present') return null;
  if (!calc?.dailyDose) return null;

  const { tasks, jobResults, dailyDose, lifetimeDose, comparison, risk, workRelatedness, maxForce, gender, weightedDailyDose, formulaVersion } = calc;
  const forceThreshold = thresholds.singleForce;
  const isV513 = formulaVersion === SPINE_FORMULA_V513;
  const dailyDoseThreshold = thresholds.dailyDose[isV513 ? 'v513' : 'legacy'][gender];
  const formulaBadgeLabel = isV513 ? 'MDDM v5.1.3' : 'MDDM 레거시';
  const formulaBadgeTitle = isV513
    ? '정정된 MDDM 공식(D_r = √(ΣF²·t/8h)·8h) 적용 중. 신규 환자 또는 v5.1.3 이후 입력이 편집된 환자에 적용됩니다.'
    : '이전 공식 적용 중 (v5.1.2와 동일한 결과 보존). 이 환자의 spine 작업을 추가/수정/삭제하면 자동으로 v5.1.3 공식으로 재계산됩니다.';

  const riskIcon = { danger: '\u26D4', warning: '\u26A0\uFE0F', safe: '\u2705' };

  const statusLabel = { safe: '\u2713 적합', warning: '\u26A0 주의', danger: '\u2717 초과' };

  return (
    <div className="panel">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title">
            <span className="section-icon">&#x1F4CA;</span>MDDM 결과
            <span
              className={`spine-formula-badge ${isV513 ? 'is-v513' : 'is-legacy'}`}
              title={formulaBadgeTitle}
            >
              {formulaBadgeLabel}
            </span>
          </h2>
          <p className="section-description">최대 압박력, 일일·평생 누적 용량, 기준 비교와 업무관련성 평가를 함께 보여줍니다.</p>
        </div>
      </div>

      <div className="result-panel">
      <div className="result-summary-grid">
        <SummaryCard
          label="최대 단일 압박력"
          value={maxForce.toLocaleString()}
          unit="N"
          sub={tasks.length > 0 ? `${tasks.reduce((max, t) => t.force > max.force ? t : max, tasks[0]).name}` : '-'}
          highlight={maxForce >= 6000}
        />
        {(() => {
          const displayedDaily = weightedDailyDose ? weightedDailyDose.value : dailyDose.dailyDoseKNh;
          const meetsThreshold = displayedDaily >= dailyDoseThreshold;
          const severityLabel = classifySpineSeverity(displayedDaily, maxForce, gender);
          let subText;
          if (weightedDailyDose) {
            if (meetsThreshold) {
              subText = `가중평균 | 임계치 ${dailyDoseThreshold} kN\xB7h 이상`;
            } else if (weightedDailyDose.aboveThreshold) {
              subText = `가중평균 ${displayedDaily.toFixed(2)} kN\xB7h | 임계치 ${dailyDoseThreshold} kN\xB7h 미만 (단, 수행 직업 중 임계치 초과 직업이 포함, 그 기간만으로 누적량을 산출)`;
            } else {
              subText = `최대 직업별 | 임계치 ${dailyDoseThreshold} kN\xB7h 미만`;
            }
          } else {
            subText = `임계치 ${dailyDoseThreshold} kN\xB7h ${meetsThreshold ? '이상' : '미만'}`;
          }
          return (
            <SummaryCard
              label="일일 누적 용량"
              value={displayedDaily.toFixed(2)}
              unit={`kN\xB7h`}
              sub={`${subText} (${severityLabel})`}
            />
          );
        })()}
        <SummaryCard
          label="평생 누적 용량"
          value={lifetimeDose.excluded ? '0.00' : lifetimeDose.lifetimeDoseMNh.toFixed(2)}
          unit={`MN\xB7h`}
          sub={lifetimeDose.excluded
            ? '(일 임계값 미만으로 누적 노출량이 0으로 계산됩니다)'
            : `독일 법원(BSG) ${comparison.court.percent.toFixed(0)}%`}
          highlight={!lifetimeDose.excluded && comparison.court.percent >= 80}
        />
      </div>

      <div className={`result-risk-banner level-${risk.level}`}>
        <div className="result-risk-icon">
          {riskIcon[risk.level]}
        </div>
        <div>
          <div className={`result-risk-title level-${risk.level}`}>{risk.text}</div>
          <div className="result-risk-copy">{risk.description}</div>
        </div>
      </div>

      <div>
      <div className="result-section-heading">
        <div className="result-section-title">평생 누적 용량 기준 비교</div>
        <div className="result-section-caption">MDDM, 독일 법원(BSG) 기준 대비 비율</div>
      </div>
      <div className="result-detail-stack">
      {[
        { key: 'court', name: '독일 법원(BSG) 기준', data: comparison.court },
        { key: 'mddm', name: 'MDDM 최초 기준', data: comparison.mddm },
      ].map(({ key, name, data }) => (
        <div key={key} className="result-detail-card">
          <div className="result-card-top result-card-top-tight">
            <div>
              <span className="result-card-title">{name}</span>
              <span className={`result-status-badge level-${data.status}`}>{statusLabel[data.status]}</span>
            </div>
            <div className="result-card-meta">
              <span className={`result-value-highlight ${data.status !== 'safe' ? `level-${data.status}` : ''}`}>{lifetimeDose.lifetimeDoseMNh.toFixed(1)}</span>
              {' / '}{data.limit} MN{'\xB7'}h
            </div>
          </div>
          <div className="result-progress-track">
            <div
              className={`result-progress-fill level-${data.status}`}
              style={{ width: `${Math.min(100, data.percent)}%` }}
            />
          </div>
        </div>
      ))}
      <div className="result-detail-card">
        <div className="result-section-caption">해석</div>
        <div className="result-card-meta result-card-meta-bottom">
          {getSpineInterpretation(comparison, { markdown: false })}
        </div>
      </div>
      </div>
      </div>

      {jobResults && jobResults.length > 1 && (
        <div>
          <div className="result-section-heading">
            <div className="result-section-title">직업별 누적선량 내역</div>
            <div className="result-section-caption">직력별 일일선량, 누적선량, 포함 작업 수</div>
          </div>
          <div className="result-detail-stack">
          {jobResults.map((jr, i) => (
            <div key={jr.jobId} className="result-detail-card">
              <div className="result-card-title">직력{i + 1}: {jr.jobName} ({jr.periodYears.toFixed(1)}년)</div>
              <div className="result-metric-list result-metric-list-spaced">
                <div className="result-metric-row"><span>일일선량</span><strong>{jr.dailyDose.dailyDoseKNh.toFixed(2)} kN{'\xB7'}h</strong></div>
                <div className="result-metric-row">
                <span>누적선량</span>
                <strong>{jr.lifetimeDose.excluded ? '일일선량 미달' : `${jr.lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h`}</strong>
                </div>
                <div className="result-card-meta">포함 작업: {jr.tasks.length}개</div>
              </div>
            </div>
          ))}
          <div className="result-detail-card">
            <div className="result-metric-row">
              <span>합계 누적선량</span><strong>{lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN{'\xB7'}h</strong>
            </div>
          </div>
          </div>
        </div>
      )}

      {(!jobResults || jobResults.length <= 1) && (
        <div className="result-detail-card">
          <div className="result-section-heading">
            <div className="result-section-title">단일 직업 누적 용량</div>
            <div className="result-section-caption">직업이 하나인 경우의 일일·평생 누적 용량</div>
          </div>
          <div className="result-metric-list">
            <div className="result-metric-row"><span>일일 누적 용량</span><strong>{dailyDose.dailyDoseKNh.toFixed(2)} kN{'\xB7'}h</strong></div>
            <div className="result-metric-row"><span>일일 임계치 ({gender === 'male' ? '남성' : '여성'})</span><strong>{dailyDoseThreshold} kN{'\xB7'}h</strong></div>
          {lifetimeDose.excluded ? (
            <div className="result-metric-row">
              <span>평생 누적 용량</span>
              <strong>0.00 MN{'\xB7'}h <span className="result-card-meta">(일 임계값 미만으로 누적 노출량이 0으로 계산됩니다)</span></strong>
            </div>
          ) : lifetimeDose.totalYears > 0 && (
            <>
              <div className="result-metric-row"><span>직업력</span><strong>{'\u00D7'} {lifetimeDose.totalYears.toFixed(1)}년</strong></div>
              <div className="result-metric-row"><span>평생 누적 용량</span><strong>{lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN{'\xB7'}h</strong></div>
            </>
          )}
          </div>
        </div>
      )}

      <div>
      <div className="result-section-heading">
        <div className="result-section-title">작업별 용량 기여도</div>
        <div className="result-section-caption">기준값 초과 여부와 일일 기여 용량</div>
      </div>
      <div className="result-detail-stack">
      {renderTaskCards(tasks, jobResults, forceThreshold)}
      </div>
      </div>

      <div className="result-detail-card">
        <div className="result-section-heading">
          <div className="result-section-title">업무관련성 평가</div>
          <div className="result-section-caption">업무 기여도와 개인 기여도 추정</div>
        </div>
        <div className="result-card-top result-card-top-tight">
          <span className="result-card-title">{workRelatedness.description}</span>
          <span className={`job-badge badge-${workRelatedness.level === 'high' ? 'high' : workRelatedness.level === 'medium' ? 'medium-high' : workRelatedness.level === 'low' ? 'medium-low' : 'low'}`}>
            {workRelatedness.grade}
          </span>
        </div>
        <div className="result-card-meta result-card-meta-bottom">{workRelatedness.detail}</div>
        <div className="result-section-caption result-section-caption-tight">기여도 추정</div>
        <div className="result-progress-track result-progress-track-lg">
          <div className="result-progress-fill result-progress-fill-accent" style={{ width: `${Math.min(100, workRelatedness.workContribution)}%` }} />
        </div>
        <div className="result-contribution-split">
          <span>업무 {workRelatedness.workContribution}%</span>
          <span>개인 {workRelatedness.personalContribution}%</span>
        </div>
      </div>
      </div>
    </div>
  );
}

function renderTaskCard(task, forceThreshold) {
  const included = task.force >= forceThreshold;
  const timeH = (convertTimeToSeconds(task.timeValue, task.timeUnit) * task.frequency) / 3600;
  const taskDose = included ? (task.force * Math.sqrt(timeH)) / 1000 : 0;
  const forceLevel = task.force >= 6000 ? 'danger' : task.force >= forceThreshold ? 'warning' : 'safe';
  return (
    <div key={task.id} className="result-detail-card">
      <div className="result-card-top">
        <div>
          <div className="result-card-title">{task.name}</div>
          <div className="result-card-meta">{task.posture} {'\xB7'} {task.weight}kg {'\xB7'} {task.frequency}회/일</div>
        </div>
        <span className={`result-force-value level-${forceLevel}`}>{task.force.toLocaleString()} N</span>
      </div>
      <div className="result-card-meta result-card-meta-spaced">
        {included
          ? `일일 시간: ${timeH.toFixed(3)} h | 일일 기여: ${taskDose.toFixed(2)} kN\xB7h`
          : `기준값(${forceThreshold}N) 미만 - 일일선량 미포함`}
      </div>
    </div>
  );
}

function renderTaskCards(tasks, jobResults, forceThreshold) {
  if (jobResults && jobResults.length > 1) {
    return jobResults.map((jr, ji) => {
      const jrTasks = jr.tasks || [];
      if (jrTasks.length === 0) return null;
      return (
        <Fragment key={jr.jobId}>
          <div className="result-section-caption result-task-group-label">직력{ji + 1}: {jr.jobName || '-'}</div>
          {jrTasks.map(task => renderTaskCard(task, forceThreshold))}
        </Fragment>
      );
    });
  }
  return tasks.map(task => renderTaskCard(task, forceThreshold));
}

function SummaryCard({ label, value, unit, sub, highlight }) {
  return (
    <div className={`result-summary-card ${highlight ? 'is-danger' : ''}`}>
      <div className="result-summary-label">{label}</div>
      <div className="result-summary-value">
        {value} <span className="result-summary-unit">{unit}</span>
      </div>
      <div className="result-summary-sub">{sub}</div>
    </div>
  );
}

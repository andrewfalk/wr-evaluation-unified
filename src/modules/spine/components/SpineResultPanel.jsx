import { thresholds } from '../utils/thresholds';
import { convertTimeToSeconds } from '../utils/calculations';

export function SpineResultPanel({ calc }) {
  if (!calc?.dailyDose) return null;

  const { tasks, jobResults, dailyDose, lifetimeDose, comparison, risk, workRelatedness, maxForce, gender } = calc;
  const forceThreshold = thresholds.singleForce;

  const riskIcon = { danger: '\u26D4', warning: '\u26A0\uFE0F', safe: '\u2705' };

  const statusLabel = { safe: '\u2713 적합', warning: '\u26A0 주의', danger: '\u2717 초과' };

  return (
    <div className="panel">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>MDDM 결과</h2>
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
        <SummaryCard
          label="일일 누적 용량"
          value={dailyDose.dailyDoseKNh.toFixed(2)}
          unit={`kN\xB7h`}
          sub={`임계치 ${thresholds.dailyDose[gender]} kN\xB7h ${dailyDose.dailyDoseKNh >= thresholds.dailyDose[gender] ? '초과' : '미만'}`}
        />
        <SummaryCard
          label="평생 누적 용량"
          value={lifetimeDose.excluded ? '0' : lifetimeDose.lifetimeDoseMNh.toFixed(2)}
          unit={`MN\xB7h`}
          sub={lifetimeDose.excluded ? '일일선량 미달' : `DWS2 ${comparison.dws2.percent.toFixed(0)}%`}
          highlight={!lifetimeDose.excluded && comparison.dws2.status !== 'safe'}
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
        <div className="result-section-caption">MDDM, 독일 법원, DWS2 기준 대비 비율</div>
      </div>
      <div className="result-detail-stack">
      {[
        { key: 'mddm', name: 'MDDM 최초 기준', data: comparison.mddm },
        { key: 'court', name: '독일 법원 기준', data: comparison.court },
        { key: 'dws2', name: 'DWS2 연구 기준', data: comparison.dws2 },
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

      {(!jobResults || jobResults.length <= 1) && !lifetimeDose.excluded && (
        <div className="result-detail-card">
          <div className="result-section-heading">
            <div className="result-section-title">단일 직업 누적 용량</div>
            <div className="result-section-caption">직업이 하나인 경우의 일일·평생 누적 용량</div>
          </div>
          <div className="result-metric-list">
            <div className="result-metric-row"><span>일일 누적 용량</span><strong>{dailyDose.dailyDoseKNh.toFixed(2)} kN{'\xB7'}h</strong></div>
            <div className="result-metric-row"><span>일일 임계치 ({gender === 'male' ? '남성' : '여성'})</span><strong>{thresholds.dailyDose[gender]} kN{'\xB7'}h</strong></div>
          {lifetimeDose.totalYears > 0 && (
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
      {tasks.map((task) => {
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
      })}
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

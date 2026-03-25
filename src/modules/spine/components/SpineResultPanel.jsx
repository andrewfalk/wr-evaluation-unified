import { thresholds } from '../utils/thresholds';
import { convertTimeToSeconds } from '../utils/calculations';

export function SpineResultPanel({ calc }) {
  if (!calc?.dailyDose) return null;

  const { tasks, jobResults, dailyDose, lifetimeDose, comparison, risk, workRelatedness, maxForce, gender } = calc;
  const forceThreshold = thresholds.singleForce[gender];

  // Risk gauge colors
  const riskColors = { danger: '#c92a2a', warning: '#e67700', safe: '#2b8a3e' };
  const riskBg = { danger: '#fff5f5', warning: '#fff9db', safe: '#ebfbee' };
  const riskIcon = { danger: '\u26D4', warning: '\u26A0\uFE0F', safe: '\u2705' };

  // Threshold bar status colors
  const statusColor = { safe: '#2b8a3e', warning: '#e67700', danger: '#c92a2a' };
  const statusLabel = { safe: '\u2713 적합', warning: '\u26A0 주의', danger: '\u2717 초과' };

  return (
    <div className="panel">
      <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>MDDM 결과</h2>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 15 }}>
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

      {/* Risk Gauge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: riskBg[risk.level], borderRadius: 10, marginBottom: 15 }}>
        <div style={{ width: 50, height: 50, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, background: 'white' }}>
          {riskIcon[risk.level]}
        </div>
        <div>
          <div style={{ fontWeight: 600, color: riskColors[risk.level], fontSize: '0.9rem' }}>{risk.text}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{risk.description}</div>
        </div>
      </div>

      {/* Threshold Comparison */}
      <h3 style={{ margin: '15px 0 10px', fontSize: '0.9rem' }}>평생 누적 용량 기준 비교</h3>
      {[
        { key: 'mddm', name: 'MDDM 최초 기준', data: comparison.mddm },
        { key: 'court', name: '독일 법원 기준', data: comparison.court },
        { key: 'dws2', name: 'DWS2 연구 기준', data: comparison.dws2 },
      ].map(({ key, name, data }) => (
        <div key={key} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', marginBottom: 3 }}>
            <div>
              <span style={{ fontWeight: 500 }}>{name}</span>
              <span style={{ marginLeft: 6, color: statusColor[data.status], fontWeight: 600, fontSize: '0.75rem' }}>{statusLabel[data.status]}</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span style={{ fontWeight: 600, color: data.status !== 'safe' ? statusColor[data.status] : undefined }}>{lifetimeDose.lifetimeDoseMNh.toFixed(1)}</span>
              {' / '}{data.limit} MN{'\xB7'}h
            </div>
          </div>
          <div style={{ height: 8, background: 'var(--card-bg)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.min(100, data.percent)}%`,
              background: statusColor[data.status],
              borderRadius: 4,
              transition: 'width 0.3s'
            }} />
          </div>
        </div>
      ))}

      {/* 직업별 누적선량 내역 */}
      {jobResults && jobResults.length > 1 && (
        <>
          <h3 style={{ margin: '15px 0 10px', fontSize: '0.9rem' }}>직업별 누적선량 내역</h3>
          {jobResults.map((jr, i) => (
            <div key={jr.jobId} className="assessment-box" style={{ marginBottom: 6, padding: 10, fontSize: '0.8rem' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                직력{i + 1}: {jr.jobName} ({jr.periodYears.toFixed(1)}년)
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span>일일선량</span><span>{jr.dailyDose.dailyDoseKNh.toFixed(2)} kN{'\xB7'}h</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span>누적선량</span>
                <span>{jr.lifetimeDose.excluded ? '일일선량 미달' : `${jr.lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h`}</span>
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>포함 작업: {jr.tasks.length}개</div>
            </div>
          ))}
          <div className="assessment-box" style={{ padding: 10, fontSize: '0.85rem', fontWeight: 600, borderTop: '2px solid var(--primary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>합계 누적선량</span><span>{lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN{'\xB7'}h</span>
            </div>
          </div>
        </>
      )}

      {/* Daily Dose Detail (단일 직업 또는 legacy) */}
      {(!jobResults || jobResults.length <= 1) && !lifetimeDose.excluded && (
        <div className="assessment-box" style={{ marginTop: 12, fontSize: '0.8rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span>일일 누적 용량</span><span>{dailyDose.dailyDoseKNh.toFixed(2)} kN{'\xB7'}h</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span>일일 임계치 ({gender === 'male' ? '남성' : '여성'})</span><span>{thresholds.dailyDose[gender]} kN{'\xB7'}h</span>
          </div>
          {lifetimeDose.totalYears > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span>직업력</span><span>{'\u00D7'} {lifetimeDose.totalYears.toFixed(1)}년</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '2px solid var(--primary)', marginTop: 4, paddingTop: 8, fontWeight: 600 }}>
                <span>평생 누적 용량</span><span>{lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN{'\xB7'}h</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Task Contribution */}
      <h3 style={{ margin: '15px 0 10px', fontSize: '0.9rem' }}>작업별 용량 기여도</h3>
      {tasks.map((task, i) => {
        const included = task.force >= forceThreshold;
        const timeH = (convertTimeToSeconds(task.timeValue, task.timeUnit) * task.frequency) / 3600;
        const taskDose = included ? (task.force * Math.sqrt(timeH)) / 1000 : 0;
        const forceColor = task.force >= 6000 ? '#c92a2a' : task.force >= forceThreshold ? '#e67700' : '#2b8a3e';
        return (
          <div key={task.id} className="assessment-box" style={{ marginBottom: 6, padding: 10, fontSize: '0.8rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontWeight: 600 }}>{task.name}</span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{task.posture} {'\xB7'} {task.weight}kg {'\xB7'} {task.frequency}회/일</span>
              </div>
              <span style={{ fontWeight: 700, color: forceColor }}>{task.force.toLocaleString()} N</span>
            </div>
            <div style={{ color: 'var(--text-muted)', marginTop: 3 }}>
              {included
                ? `일일 시간: ${timeH.toFixed(3)} h | 일일 기여: ${taskDose.toFixed(2)} kN\xB7h`
                : `기준값(${forceThreshold}N) 미만 - 일일선량 미포함`}
            </div>
          </div>
        );
      })}

      {/* Work Relatedness */}
      <h3 style={{ margin: '15px 0 10px', fontSize: '0.9rem' }}>업무관련성 평가</h3>
      <div className="assessment-box" style={{ padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>{workRelatedness.description}</span>
          <span className={`job-badge badge-${workRelatedness.level === 'high' ? 'high' : workRelatedness.level === 'medium' ? 'medium-high' : workRelatedness.level === 'low' ? 'medium-low' : 'low'}`}>
            {workRelatedness.grade}
          </span>
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>{workRelatedness.detail}</div>
        {/* Contribution Bar */}
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 3 }}>기여도 추정</div>
        <div style={{ height: 12, background: 'var(--card-bg)', borderRadius: 6, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: `${Math.min(100, workRelatedness.workContribution)}%`, background: 'var(--primary)', borderRadius: 6, transition: 'width 0.3s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>
          <span>업무 {workRelatedness.workContribution}%</span>
          <span>개인 {workRelatedness.personalContribution}%</span>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, unit, sub, highlight }) {
  return (
    <div style={{
      background: highlight ? 'linear-gradient(135deg, #e03131, #c92a2a)' : 'linear-gradient(135deg, #667eea, #764ba2)',
      borderRadius: 10,
      padding: 12,
      color: 'white',
      textAlign: 'center'
    }}>
      <div style={{ fontSize: '0.7rem', opacity: 0.9, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
        {value} <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>{unit}</span>
      </div>
      <div style={{ fontSize: '0.65rem', opacity: 0.8, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

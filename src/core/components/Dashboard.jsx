import { useMemo, useState } from 'react';
import { computeDashboardStats } from '../utils/dashboardStats';
import { getAllModules } from '../moduleRegistry';

const MODULE_LABELS = { knee: '무릎', spine: '허리', shoulder: '어깨', elbow: '팔꿈치', wrist: '손목', cervical: '목' };
const MODULE_COLORS = { knee: 'var(--accent)', spine: '#f59e0b', shoulder: 'var(--color-safe)', elbow: '#8b5cf6', wrist: '#ec4899', cervical: '#06b6d4' };

const BarChart = ({ data, color, title, caption }) => {
  const gridSteps = 5;
  const yMax = Math.ceil(Math.max(...data.map(m => m.count), 5) / gridSteps) * gridSteps;
  const step = yMax / gridSteps;

  return (
    <div className="dashboard-section pattern-surface">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-title">{title}</div>
        <div className="dashboard-section-caption">{caption}</div>
      </div>
      <div className="dashboard-chart-area">
        <div className="dashboard-y-axis">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <span className="dashboard-y-label" key={i}>{yMax - i * step}</span>
          ))}
        </div>
        <div className="dashboard-chart-body">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <div className="dashboard-grid-line" key={i} style={{ '--line-top': `${(i / gridSteps) * 100}%` }} />
          ))}
          <div className="dashboard-bars">
            {data.map(m => (
              <div className="dashboard-bar-wrapper" key={m.key}>
                {m.count > 0 && <span className="dashboard-bar-label">{m.count}</span>}
                <div className="dashboard-bar" style={{ '--bar-height': `${(m.count / yMax) * 100}%`, '--bar-color': color }}>
                  {m.count > 0 && <span className="dashboard-bar-tooltip">{m.count}건</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="dashboard-x-labels">
        {data.map(m => <span className="dashboard-x-label" key={m.key}>{m.label}</span>)}
      </div>
    </div>
  );
};

const SEG_COLORS = {
  high: 'var(--color-safe)',
  low: '#f59e0b',
  unassessed: 'var(--text-muted)',
};

const StackedBarChart = ({ data, title, caption = '' }) => {
  const maxTotal = Math.max(...data.map(d => d.highCount + d.lowCount + d.unassessedCount), 5);
  const gridSteps = 5;
  const stepValue = Math.ceil(maxTotal / gridSteps);
  const yMax = stepValue * gridSteps;

  return (
    <div className="dashboard-section pattern-surface">
      <div className="dashboard-section-heading">
        <div>
          <div className="dashboard-section-title">{title}</div>
          <div className="stacked-legend">
            <span className="stacked-legend-item"><span className="stacked-legend-dot" style={{ background: SEG_COLORS.high }} />높음</span>
            <span className="stacked-legend-item"><span className="stacked-legend-dot" style={{ background: SEG_COLORS.low }} />낮음</span>
            <span className="stacked-legend-item"><span className="stacked-legend-dot" style={{ background: SEG_COLORS.unassessed }} />미평가</span>
          </div>
        </div>
        <div className="dashboard-section-caption">{caption}</div>
      </div>
      <div className="dashboard-chart-area">
        <div className="dashboard-y-axis">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <span className="dashboard-y-label" key={i}>{yMax - i * stepValue}</span>
          ))}
        </div>
        <div className="dashboard-chart-body">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <div className="dashboard-grid-line" key={i} style={{ '--line-top': `${(i / gridSteps) * 100}%` }} />
          ))}
          <div className="dashboard-bars">
            {data.map(d => {
              const total = d.highCount + d.lowCount + d.unassessedCount;
              return (
                <div className="dashboard-bar-wrapper" key={d.key}>
                  {d.highCount > 0 && <span className="stacked-bar-high-label">{d.highCount}</span>}
                  {d.lowCount > 0 && <span className="stacked-bar-low-label">{d.lowCount}</span>}
                  <div className="stacked-bar" style={{ '--bar-height': `${(total / yMax) * 100}%` }}>
                    {d.unassessedCount > 0 && <div className="stacked-segment" style={{ flex: d.unassessedCount, background: SEG_COLORS.unassessed }} />}
                    {d.lowCount > 0 && <div className="stacked-segment" style={{ flex: d.lowCount, background: SEG_COLORS.low }} />}
                    {d.highCount > 0 && <div className="stacked-segment" style={{ flex: d.highCount, background: SEG_COLORS.high }} />}
                    {total > 0 && (
                      <div className="stacked-bar-tooltip">
                        <div>높음 {d.highCount}건</div>
                        <div>낮음 {d.lowCount}건</div>
                        <div>미평가 {d.unassessedCount}건</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="dashboard-x-labels">
        {data.map(d => <span className="dashboard-x-label" key={d.key}>{d.label}</span>)}
      </div>
    </div>
  );
};

const Dashboard = ({ patients, onSelectPatient }) => {
  const [period, setPeriod] = useState('monthly');
  const [showJobStats, setShowJobStats] = useState(false);

  const stats = useMemo(
    () => computeDashboardStats(patients),
    [patients]
  );

  const PERIOD_META = {
    monthly: { caption: '최근 6개월', label: '월간' },
    weekly:  { caption: '최근 8주',   label: '주간' },
    daily:   { caption: '최근 7일',   label: '일간' },
  };

  const regData  = {
    monthly: stats.monthlyRegistrations,
    weekly: stats.weeklyRegistrations,
    daily: stats.dailyRegistrations
  };
  const evalData = {
    monthly: stats.monthlyEvaluations,
    weekly: stats.weeklyEvaluations,
    daily: stats.dailyEvaluations
  };

  if (stats.totalPatients === 0) {
    return (
      <div className="dashboard">
        <div className="dashboard-empty">
          아직 저장된 평가 데이터가 없습니다.<br />
          평가를 시작하면 통계가 여기에 표시됩니다.
        </div>
      </div>
    );
  }

  const allModules = getAllModules();

  return (
    <div className="dashboard">
      {/* 요약 카드 */}
      <div className="dashboard-summary">
        <div className="dashboard-stat-card metric-card pattern-surface">
          <div className="stat-value stat-total">{stats.totalPatients}</div>
          <div className="stat-label">총 환자</div>
        </div>
        <div className="dashboard-stat-card metric-card pattern-surface">
          <div className="stat-value stat-complete">{stats.completedCount}</div>
          <div className="stat-label">평가 완료</div>
        </div>
        <div className="dashboard-stat-card metric-card pattern-surface">
          <div className="stat-value stat-progress">{stats.inProgressCount}</div>
          <div className="stat-label">진행 중</div>
        </div>
        <div className="dashboard-stat-card metric-card pattern-surface">
          <div className="stat-value stat-days">
            {stats.avgProcessingDays ?? '-'}
            <span className="stat-unit">일</span>
          </div>
          <div className="stat-label">평균 처리일수</div>
        </div>
        <div className="dashboard-stat-card metric-card pattern-surface metric-card-modules">
          {!showJobStats ? (
            <div className="stat-module-grid">
              {allModules.map(m => (
                <div className="stat-module-cell" key={m.id}>
                  <div className="stat-module-label">{MODULE_LABELS[m.id] || m.name}</div>
                  <div
                    className="stat-module-value stat-module-value-tip"
                    style={{ color: MODULE_COLORS[m.id] || 'var(--accent)' }}
                  >
                    {stats.moduleUsage[m.id] || 0}
                    <div className="module-usage-tooltip">
                      <div>높음 {stats.moduleHighLow[m.id]?.high || 0}건</div>
                      <div>낮음 {stats.moduleHighLow[m.id]?.low || 0}건</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="stat-job-grid">
              {stats.topJobs.length > 0 ? (
                stats.topJobs.map((job, idx) => (
                  <div className="stat-job-row" key={idx}>
                    <div className="stat-job-name">{job.name}</div>
                    <div className="stat-job-count">{job.count}명</div>
                  </div>
                ))
              ) : (
                <div className="stat-empty">직종 데이터 없음</div>
              )}
            </div>
          )}
          <div className="stat-label stat-label-toggle" onClick={() => setShowJobStats(!showJobStats)}>
            {showJobStats ? '상위 직종' : '모듈별 개수'}
          </div>
        </div>
        <div className="dashboard-stat-card metric-card pattern-surface">
          <div className="stat-assessment-grid">
            {(() => {
              const assessed = stats.totalHighCount + stats.totalLowCount;
              const pct = n => assessed > 0 ? Math.round(n / assessed * 100) : 0;
              return [
                { label: '높음', count: stats.totalHighCount, color: 'var(--color-safe)', pct: pct(stats.totalHighCount), showPct: true },
                { label: '낮음', count: stats.totalLowCount, color: '#f59e0b', pct: pct(stats.totalLowCount), showPct: true },
                { label: '미판정', count: stats.totalUnassessedCount, color: 'var(--text-muted)', showPct: false },
              ].map(row => (
                <div className="stat-assessment-row" key={row.label}>
                  <span className="stat-assessment-label">{row.label}</span>
                  <span className="stat-assessment-count" style={{ color: row.color }}>{row.count}</span>
                  <span className="stat-assessment-pct">{row.showPct ? `${row.pct}%` : ''}</span>
                </div>
              ));
            })()}
          </div>
          <div className="stat-label">평가 결과</div>
        </div>
      </div>

      {/* 차트 2개 */}
      <div>
        <div className="dashboard-period-tabs">
          {['monthly','weekly','daily'].map(p => (
            <button key={p}
              className={`btn btn-sm dashboard-period-btn${period === p ? ' active' : ''}`}
              onClick={() => setPeriod(p)}>
              {PERIOD_META[p].label}
            </button>
          ))}
        </div>
        <div className="dashboard-content">
          <BarChart data={regData[period]} color="var(--accent)" title="등록 환자 수" caption={PERIOD_META[period].caption} />
          <BarChart data={evalData[period].map(d => ({ ...d, count: d.patientCount }))} color="var(--color-safe)" title="평가 환자 수" caption={PERIOD_META[period].caption} />
          <StackedBarChart data={evalData[period]} title="평가 결과" caption={PERIOD_META[period].caption} />
        </div>
      </div>

      {/* 최근 활동 */}
      <div className="dashboard-section dashboard-recent pattern-surface">
        <div className="dashboard-section-heading">
          <div className="dashboard-section-title">최근 활동</div>
          <div className="dashboard-section-caption">등록 및 평가 완료 이력</div>
        </div>
        {stats.recentActivity.length > 0 ? (
          <div className="dashboard-table-wrap">
            <table className="dashboard-table list-table">
              <thead>
                <tr>
                  <th>등록번호</th>
                  <th>환자명</th>
                  <th>직종명</th>
                  <th>등록일 / 평가일</th>
                  <th>처리일수</th>
                  <th title="총 입력 상병 수">상병</th>
                  <th title="업무관련성 높음">높음</th>
                  <th title="업무관련성 낮음">낮음</th>
                  <th>모듈</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentActivity.map((item, i) => (
                  <tr key={i}>
                    <td>{item.patientNo || '-'}</td>
                    <td>
                      {onSelectPatient ? (
                        <a
                          className="dashboard-link"
                          href="#"
                          onClick={e => { e.preventDefault(); onSelectPatient(item.id); }}
                          title="편집창으로 즉시 이동"
                        >
                          {item.name}
                        </a>
                      ) : item.name}
                    </td>
                    <td>{item.jobName || '-'}</td>
                    <td className="dashboard-date-cell">
                      <div>등록: {item.registrationDate || '-'}</div>
                      <div>평가: {item.completionDate || '-'}</div>
                    </td>
                    <td>{item.processingDays !== null ? `${item.processingDays}일` : '-'}</td>
                    <td>{item.totalDiagnoses}</td>
                    <td style={{ color: 'var(--color-safe)' }}>{item.highCount}</td>
                    <td style={{ color: '#f59e0b' }}>{item.lowCount}</td>
                    <td>{item.moduleIds.map(id => MODULE_LABELS[id] || id).join(', ') || '-'}</td>
                    <td>
                      <span className={`dashboard-status ${item.status === '완료' ? 'complete' : 'in-progress'}`}>
                        {item.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dashboard-empty dashboard-empty-compact">
            최근 활동이 없습니다.
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;

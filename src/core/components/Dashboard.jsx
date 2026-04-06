import { useMemo } from 'react';
import { computeDashboardStats } from '../utils/dashboardStats';
import { getAllModules } from '../moduleRegistry';

const MODULE_LABELS = { knee: '무릎', spine: '척추', shoulder: '어깨' };

const BarChart = ({ data, color, title }) => {
  const maxCount = Math.max(...data.map(m => m.count), 5);
  const gridSteps = 5;
  const stepValue = Math.ceil(maxCount / gridSteps);
  const yMax = stepValue * gridSteps;

  return (
    <div className="dashboard-section pattern-surface">
      <div className="dashboard-section-heading">
        <div className="dashboard-section-title">{title}</div>
        <div className="dashboard-section-caption">최근 6개월 추이</div>
      </div>
      <div className="dashboard-chart-area">
        <div className="dashboard-y-axis">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <span className="dashboard-y-label" key={i}>{yMax - i * stepValue}</span>
          ))}
        </div>
        <div className="dashboard-chart-body">
          {Array.from({ length: gridSteps + 1 }, (_, i) => (
            <div
              className="dashboard-grid-line"
              key={i}
              style={{ '--line-top': `${(i / gridSteps) * 100}%` }}
            />
          ))}
          <div className="dashboard-bars">
            {data.map(m => (
              <div className="dashboard-bar-wrapper" key={m.key}>
                <div
                  className="dashboard-bar"
                  style={{
                    '--bar-height': `${(m.count / yMax) * 100}%`,
                    '--bar-color': color,
                  }}
                >
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

const Dashboard = ({ patients, onSelectPatient }) => {
  const stats = useMemo(
    () => computeDashboardStats(patients),
    [patients]
  );


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
  const moduleText = allModules
    .map(m => `${MODULE_LABELS[m.id] || m.name} ${stats.moduleUsage[m.id] || 0}`)
    .join(' / ');

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
        <div className="dashboard-stat-card metric-card pattern-surface metric-card-wide">
          <div className="stat-value stat-module">{stats.totalPatients}</div>
          <div className="stat-label">모듈 사용</div>
          <div className="stat-sub">{moduleText}</div>
        </div>
      </div>

      {/* 차트 2개 */}
      <div className="dashboard-content">
        <BarChart data={stats.monthlyRegistrations} color="var(--accent)" title="월별 등록 현황" />
        <BarChart data={stats.monthlyEvaluations} color="var(--color-safe)" title="월별 평가 현황" />
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
                  <th>환자명</th>
                  <th>등록일 / 평가일</th>
                  <th>모듈</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentActivity.map((item, i) => (
                  <tr key={i}>
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
                    <td className="dashboard-date-cell">
                      <div>등록: {item.registrationDate || '-'}</div>
                      <div>평가: {item.completionDate || '-'}</div>
                    </td>
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

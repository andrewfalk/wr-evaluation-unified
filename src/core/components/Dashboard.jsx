import { useEffect, useMemo, useState } from 'react';
import { computeDashboardStats, getDoctorPatientCounts, getDoctorOptions, UNASSIGNED_GROUP_KEY } from '../utils/dashboardStats';
import { getAllModules } from '../moduleRegistry';
import { isMyPatient, getOwnerGroupKey } from '../utils/patientOwnership';
import { isRedactedPatientRecord } from '../services/patientRecords';
import { isPatientComplete } from '../utils/patientCompletion';

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

const GENDER_OPTIONS = [
  { key: 'all', label: '전체' },
  { key: 'male', label: '남' },
  { key: 'female', label: '여' },
];

const GenderToggle = ({ value, onChange }) => (
  <div className="card-gender-toggle">
    {GENDER_OPTIONS.map(opt => (
      <button
        key={opt.key}
        type="button"
        className={`card-gender-btn${value === opt.key ? ' card-gender-btn--active' : ''}`}
        onClick={() => onChange(opt.key)}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

const GenderToggleCard = ({ title, data, renderBody }) => {
  const [g, setG] = useState('all');
  return (
    <div className="dashboard-stat-card metric-card pattern-surface dashboard-card-with-toggle">
      <div className="card-toggle-row">
        <div className="stat-label">{title}</div>
        <GenderToggle value={g} onChange={setG} />
      </div>
      <div className="card-toggle-body">{renderBody(data?.[g], g)}</div>
    </div>
  );
};

const Top5List = (items) => {
  const filled = [...(items || [])];
  while (filled.length < 5) filled.push(null);
  return (
    <div className="stat-job-grid">
      {filled.map((it, i) => (
        <div className="stat-job-row" key={i}>
          {it ? (
            <>
              <div className="stat-job-name" title={it.name || ''}>
                {it.key}{it.name ? ` · ${it.name}` : ''}
              </div>
              <div className="stat-job-count">{it.count}명</div>
            </>
          ) : (
            <>
              <div className="stat-job-name stat-empty-row">&nbsp;</div>
              <div className="stat-job-count">&nbsp;</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
};

const GenderDonut = ({ segments }) => {
  const size = 130;
  const stroke = 26;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  const cx = size / 2;
  const cy = size / 2;
  const midRadius = radius;
  const pad = 8;
  const vbSize = size + pad * 2;

  return (
    <div className="gender-donut">
      <svg
        width={vbSize} height={vbSize}
        viewBox={`${-pad} ${-pad} ${vbSize} ${vbSize}`}
        style={{ overflow: 'visible' }}
        role="img" aria-label="성별 비율"
      >
        <circle
          cx={cx} cy={cy} r={radius}
          fill="none" stroke="var(--bg-secondary, #f5f5f5)" strokeWidth={stroke}
        />
        {total > 0 && segments.map(s => {
          if (s.value <= 0) return null;
          const length = (s.value / total) * circumference;
          const dash = `${length} ${circumference - length}`;
          const dashOffset = -offset;
          offset += length;
          return (
            <circle
              key={s.key}
              cx={cx} cy={cy} r={radius}
              fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={dash} strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
        {total > 0 && (() => {
          let segStart = 0;
          return segments.map(s => {
            if (s.value <= 0) return null;
            const angleSpan = (s.value / total) * 2 * Math.PI;
            const midAngle = -Math.PI / 2 + segStart + angleSpan / 2;
            segStart += angleSpan;
            const lx = cx + Math.cos(midAngle) * midRadius;
            const ly = cy + Math.sin(midAngle) * midRadius;
            const pct = Math.round((s.value / total) * 100);
            return (
              <text
                key={s.key}
                x={lx} y={ly}
                textAnchor="middle" dominantBaseline="central"
                className="gender-donut-seg-label"
              >
                {s.label} {pct}%
              </text>
            );
          });
        })()}
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
              className="gender-donut-center">{total}</text>
      </svg>
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

const Dashboard = ({
  patients,
  onSelectPatient,
  session,
  scope = 'all',
  onScopeChange,
  canUseScope = false,
  patientListScope,
}) => {
  const [period, setPeriod] = useState('monthly');
  const [showJobStats, setShowJobStats] = useState(false);

  const userId = session?.user?.id;
  const allPatientsSafe = Array.isArray(patients) ? patients : [];

  const nonRedactedPatients = useMemo(
    () => allPatientsSafe.filter(p => !isRedactedPatientRecord(p)),
    [allPatientsSafe]
  );

  const isAdmin = canUseScope && session?.user?.role === 'admin';

  // 관리자 통계 드롭다운: 등록 환자를 가진 모든 의사 옵션
  const doctorOptions = useMemo(
    () => isAdmin ? getDoctorOptions(nonRedactedPatients) : [],
    [isAdmin, nonRedactedPatients]
  );

  const scopedPatients = useMemo(() => {
    if (scope === 'all') return nonRedactedPatients;
    if (scope === 'mine') return nonRedactedPatients.filter(p => isMyPatient(p, session));
    // 특정 의사 userId 또는 미배정 키
    return nonRedactedPatients.filter(p => {
      const key = getOwnerGroupKey(p);
      return scope === UNASSIGNED_GROUP_KEY ? key == null : key === scope;
    });
  }, [nonRedactedPatients, scope, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(
    () => computeDashboardStats(scopedPatients),
    [scopedPatients]
  );

  // 'all'을 제외한 포커스 뷰(내 환자 / 특정 의사) 전용: 미완료 평가 건수
  const incompleteCount = useMemo(
    () => scope !== 'all'
      ? scopedPatients.filter(p => !isPatientComplete(p)).length
      : 0,
    [scopedPatients, scope]
  );

  // 동기화 후 선택한 의사가 옵션에서 사라지면 scope를 'all'로 되돌리는 가드 (role-aware).
  // 관리자 UI에는 'mine' 옵션이 없으므로 admin 유효값 = 'all' + doctorOptions key.
  useEffect(() => {
    if (!canUseScope) return;
    const validScopes = isAdmin
      ? new Set(['all', ...doctorOptions.map(o => o.key)])
      : new Set(['all', 'mine']);
    if (!validScopes.has(scope)) onScopeChange?.('all');
  }, [isAdmin, canUseScope, doctorOptions, scope, onScopeChange]);

  // 'all' 전용: 의사별 환자 수 Top 5
  const doctorCounts = useMemo(
    () => scope === 'all' && canUseScope
      ? getDoctorPatientCounts(scopedPatients)
      : null,
    [scopedPatients, scope, canUseScope]
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

  const allModules = getAllModules();
  const showSyncMismatchBanner = canUseScope && scope === 'all' && patientListScope === 'mine';

  const userBadge = (() => {
    if (session?.mode !== 'intranet' || !session?.user) return null;
    const displayName = session.user.name || session.user.displayName || session.user.loginId;
    if (!displayName) return null;
    const role = session.user.role;
    const roleLabel = role === 'admin' ? '관리자' : role === 'doctor' ? '의사' : role;
    return (
      <div className="dashboard-user-badge">
        <span className="dashboard-user-name">{displayName}</span>
        {role && <span className="dashboard-user-role">{roleLabel}</span>}
      </div>
    );
  })();

  const header = (
    <div className="dashboard-header-row">
      <div className="dashboard-header-spacer" />
      <div className="dashboard-header-center">{userBadge}</div>
      <div className="dashboard-header-right">
        {canUseScope && isAdmin && (
          <select
            className="patient-scope-select"
            value={scope}
            onChange={e => onScopeChange?.(e.target.value)}
          >
            <option value="all">전체 통계</option>
            {doctorOptions.map(o => (
              <option key={o.key} value={o.key}>{`${o.label} (${o.count}명)`}</option>
            ))}
          </select>
        )}
        {canUseScope && !isAdmin && (
          <div className="patient-scope-toggle">
            <button
              type="button"
              className={`patient-scope-btn${scope === 'mine' ? ' patient-scope-btn--active' : ''}`}
              onClick={() => onScopeChange?.('mine')}
            >
              내 환자 통계
            </button>
            <button
              type="button"
              className={`patient-scope-btn${scope === 'all' ? ' patient-scope-btn--active' : ''}`}
              onClick={() => onScopeChange?.('all')}
            >
              전체 통계
            </button>
          </div>
        )}
      </div>
    </div>
  );

  const banner = showSyncMismatchBanner ? (
    <div className="dashboard-banner dashboard-banner-warning">
      사이드바가 본인 환자만 동기화 중이라 전체 통계가 부정확할 수 있습니다.
      사이드바에서 [전체]로 전환하세요.
    </div>
  ) : null;

  if (stats.totalPatients === 0) {
    return (
      <div className="dashboard">
        {header}
        {banner}
        <div className="dashboard-empty">
          {scope === 'mine'
            ? <>담당 환자가 아직 없습니다.<br />
                {canUseScope && (
                  <button className="btn btn-sm" onClick={() => onScopeChange?.('all')} style={{ marginTop: 8 }}>
                    전체 보기로 전환
                  </button>
                )}
              </>
            : <>아직 저장된 평가 데이터가 없습니다.<br />평가를 시작하면 통계가 여기에 표시됩니다.</>
          }
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      {header}
      {banner}
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

        {scope !== 'all' && (() => {
          const total = scopedPatients.length;
          const completed = total - incompleteCount;
          const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
          return (
            <div className="dashboard-stat-card metric-card pattern-surface">
              <div className="stat-value stat-complete">{pct}<span className="stat-unit">%</span></div>
              <div className="stat-label">{scope === 'mine' ? '내 환자 완료율' : '선택 의사 완료율'}</div>
              <div className="stat-subnote">완료 {completed} / 총 {total}</div>
            </div>
          );
        })()}

        {scope === 'all' && doctorCounts && (
          <div className="dashboard-stat-card metric-card pattern-surface metric-card-modules">
            <div className="stat-job-grid">
              {doctorCounts.top.length > 0 ? (
                doctorCounts.top.map(row => (
                  <div className="stat-job-row" key={row.key}>
                    <div className="stat-job-name">{row.label}</div>
                    <div className="stat-job-count">{row.count}명</div>
                  </div>
                ))
              ) : (
                <div className="stat-empty">담당 의사 데이터 없음</div>
              )}
              {doctorCounts.unassigned && (
                <div className="stat-job-row" key="__unassigned__">
                  <div className="stat-job-name">{doctorCounts.unassigned.label}</div>
                  <div className="stat-job-count">{doctorCounts.unassigned.count}명</div>
                </div>
              )}
            </div>
            <div className="stat-label">의사별 환자 수 (Top 5)</div>
          </div>
        )}

        {/* 성별 비율 (도넛) */}
        <div className="dashboard-stat-card metric-card pattern-surface">
          <div className="stat-label">성별 비율</div>
          {(() => {
            const gb = stats.genderBreakdown || { male: 0, female: 0, unknown: 0 };
            const segments = [
              { key: 'male',    label: '남',   value: gb.male,    color: '#3b82f6' },
              { key: 'female',  label: '여',   value: gb.female,  color: '#ec4899' },
              { key: 'unknown', label: '미상', value: gb.unknown, color: 'var(--text-muted)' },
            ];
            return <GenderDonut segments={segments} />;
          })()}
        </div>

        {/* 평균 연령 (토글: 전체/남/여) */}
        <GenderToggleCard
          title="평균 연령"
          data={stats.avgAgeByGender}
          renderBody={(v) => (
            <div className="stat-value stat-total">
              {v == null ? '-' : v}
              <span className="stat-unit">세</span>
            </div>
          )}
        />

        {/* 연령대 분포 */}
        <GenderToggleCard
          title="연령대 분포"
          data={stats.ageGroupDistribution}
          renderBody={(buckets) => {
            const b = buckets || { '30대↓': 0, '40대': 0, '50대': 0, '60대': 0, '70대↑': 0 };
            const max = Math.max(1, ...Object.values(b));
            const order = ['30대↓', '40대', '50대', '60대', '70대↑'];
            return (
              <div className="age-group-rows">
                {order.map(k => (
                  <div className="age-group-row" key={k}>
                    <div className="age-group-label">{k}</div>
                    <div className="age-group-bar-track">
                      <div className="age-group-bar-fill"
                           style={{ width: `${(b[k] / max) * 100}%` }} />
                    </div>
                    <div className="age-group-count">{b[k]}</div>
                  </div>
                ))}
              </div>
            );
          }}
        />

        {/* 대표 직종 Top 5 */}
        <GenderToggleCard
          title="대표 직종 Top 5"
          data={stats.topJobsByGender}
          renderBody={(items) => Top5List(items)}
        />

        {/* 상병 Top 5 */}
        <GenderToggleCard
          title="상병 Top 5"
          data={stats.topDiagnosesByGender}
          renderBody={(items) => Top5List(items)}
        />
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

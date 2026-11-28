import { useMemo, useState } from 'react';
import { computeDashboardStats, getDoctorPatientCounts, getDoctorOptionsFromRoster, UNASSIGNED_GROUP_KEY } from '../utils/dashboardStats';
import { getAllModules, getModule } from '../moduleRegistry';
import { isMyPatient, getOwnerGroupKey } from '../utils/patientOwnership';
import { isRedactedPatientRecord } from '../services/patientRecords';
import { isPatientComplete } from '../utils/patientCompletion';
import type { PatientRecord } from '../types/patient';

import { hasIntranetSession } from '../../platform/dataMode';
import { BarChart } from './dashboard/BarChart';
import type { BarDatum } from './dashboard/BarChart';
import { GenderDonut } from './dashboard/GenderDonut';
import { GenderToggleCard } from './dashboard/GenderToggle';
import { StackedBarChart } from './dashboard/StackedBarChart';
import type { StackedBarDatum } from './dashboard/StackedBarChart';
import { Top5List } from './dashboard/Top5List';
import type { Top5Item } from './dashboard/Top5List';
interface DashboardSessionUser {
  id?: string;
  role?: string;
  name?: string;
  displayName?: string;
  loginId?: string;
}

interface DashboardSession {
  mode?: string | null;
  user?: DashboardSessionUser | null;
}

interface DoctorRoster {
  doctors?: Array<{ userId?: string; name?: string | null; count?: number }>;
  unassignedCount?: number;
}

interface EvalDatum extends StackedBarDatum {
  patientCount: number;
}

interface RecentActivityItem {
  id: string;
  patientNo: string;
  name: string;
  jobName: string;
  registrationDate: string;
  completionDate: string;
  moduleIds: string[];
  status: string;
  processingDays: number | null;
  totalDiagnoses: number;
  highCount: number;
  lowCount: number;
}

// computeDashboardStats(utils/dashboardStats.js, JS)가 돌려주는 값 가운데 이 화면이 읽는 필드.
interface DashboardStats {
  totalPatients: number;
  completedCount: number;
  inProgressCount: number;
  avgProcessingDays: number | null;
  moduleUsage: Record<string, number>;
  moduleHighLow: Record<string, { high?: number; low?: number } | undefined>;
  topJobs: Array<{ name: string; count: number }>;
  totalHighCount: number;
  totalLowCount: number;
  totalUnassessedCount: number;
  monthlyRegistrations: BarDatum[];
  weeklyRegistrations: BarDatum[];
  dailyRegistrations: BarDatum[];
  monthlyEvaluations: EvalDatum[];
  weeklyEvaluations: EvalDatum[];
  dailyEvaluations: EvalDatum[];
  recentActivity: RecentActivityItem[];
  genderBreakdown: { male: number; female: number; unknown: number };
  avgAgeByGender: Record<string, number | null>;
  ageGroupDistribution: Record<string, Record<string, number>>;
  topJobsByGender: Record<string, Top5Item[]>;
  topDiagnosesByGender: Record<string, Top5Item[]>;
}

export interface DashboardProps {
  patients: PatientRecord[] | null | undefined;
  onSelectPatient?: (id: string) => void;
  session?: DashboardSession | null;
  scope?: string;
  onScopeChange?: (scope: string) => void;
  canUseScope?: boolean;
  doctorRoster?: DoctorRoster | null;
  isScopeLoading?: boolean;
}

const Dashboard = ({
  patients,
  onSelectPatient,
  session,
  scope = 'all',
  onScopeChange,
  canUseScope = false,
  doctorRoster,
  isScopeLoading = false,
}: DashboardProps) => {
  const [period, setPeriod] = useState('monthly');
  const [showJobStats, setShowJobStats] = useState(false);

  const userId = session?.user?.id;
  const isDoctor = session?.user?.role === 'doctor';
  const allPatientsSafe = Array.isArray(patients) ? patients : [];

  const nonRedactedPatients = useMemo(
    () => allPatientsSafe.filter(p => !isRedactedPatientRecord(p)),
    [allPatientsSafe]
  );

  // 통계 드롭다운 옵션은 서버 명부(doctorRoster) 기반 — 로드된 환자와 무관하게 항상 완전.
  // 본인(userId)은 옵션에서 제외하고 그 count는 myCount로 받아 "내 환자 통계 (N명)"에 사용.
  const { options: doctorOptions, myCount } = useMemo(
    () => canUseScope
      ? getDoctorOptionsFromRoster(doctorRoster, { currentUserId: userId })
      : { options: [], myCount: 0 },
    [canUseScope, doctorRoster, userId]
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

  // JS 추론으로 moduleUsage·moduleHighLow가 `{}`(색인 없음)라 바로 단언할 수 없어 unknown을 거친다.
  const stats = useMemo(
    () => computeDashboardStats(scopedPatients) as unknown as DashboardStats,
    [scopedPatients]
  );

  // 'all'을 제외한 포커스 뷰(내 환자 / 특정 의사) 전용: 미완료 평가 건수
  const incompleteCount = useMemo(
    () => scope !== 'all'
      ? scopedPatients.filter(p => !isPatientComplete(p)).length
      : 0,
    [scopedPatients, scope]
  );

  // scope 유효성 가드는 App.jsx에서 사이드바(patientScope)와 함께 통합 관리한다
  // (여기서 별도로 'all' 복귀시키면 App의 'mine' 복귀 정책과 충돌하므로 제거).

  // 'all' 전용: 의사별 환자 수 Top 5
  const doctorCounts = useMemo(
    () => scope === 'all' && canUseScope
      ? getDoctorPatientCounts(scopedPatients, { roster: doctorRoster } as Parameters<typeof getDoctorPatientCounts>[1])
      : null,
    [scopedPatients, scope, canUseScope, doctorRoster]
  );

  const PERIOD_META: Record<string, { caption: string; label: string }> = {
    monthly: { caption: '최근 6개월', label: '월간' },
    weekly:  { caption: '최근 8주',   label: '주간' },
    daily:   { caption: '최근 7일',   label: '일간' },
  };

  const regData: Record<string, BarDatum[]>  = {
    monthly: stats.monthlyRegistrations,
    weekly: stats.weeklyRegistrations,
    daily: stats.dailyRegistrations
  };
  const evalData: Record<string, EvalDatum[]> = {
    monthly: stats.monthlyEvaluations,
    weekly: stats.weeklyEvaluations,
    daily: stats.dailyEvaluations
  };

  const allModules = getAllModules();

  const userBadge = (() => {
    if (!hasIntranetSession(session) || !session?.user) return null;
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
        {canUseScope && (
          <select
            className="patient-scope-select"
            value={scope}
            onChange={e => onScopeChange?.(e.target.value)}
          >
            <option value="all">전체 통계</option>
            {/* "내 환자 통계"는 의사에게만 (admin은 본인 환자 개념 없음). 본인 count 표시. */}
            {isDoctor && <option value="mine">{`내 환자 통계 (${myCount}명)`}</option>}
            {doctorOptions.map(o => (
              <option key={o.key} value={o.key}>{`${o.label} (${o.count}명)`}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );

  const banner = isScopeLoading ? (
    <div className="dashboard-banner dashboard-banner-info">
      선택한 범위의 환자를 불러오는 중입니다…
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
                  <div className="stat-module-label">{m.shortName || m.name}</div>
                  <div
                    className="stat-module-value stat-module-value-tip"
                    style={{ color: m.color || 'var(--accent)' }}
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
              const pct = (n: number) => assessed > 0 ? Math.round(n / assessed * 100) : 0;
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
              <div className="stat-label">{scope === 'mine' ? '내 환자 완료율' : '선택 범위 완료율'}</div>
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
          title={<>평균 연령 <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 400, opacity: 0.7, whiteSpace: 'nowrap' }}>(재해일자 기준)</span></>}
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
          title={<>연령대 분포 <span style={{ display: 'block', fontSize: '0.8em', fontWeight: 400, opacity: 0.7, whiteSpace: 'nowrap' }}>(재해일자 기준)</span></>}
          data={stats.ageGroupDistribution}
          renderBody={(buckets) => {
            const b: Record<string, number> = buckets || { '30대↓': 0, '40대': 0, '50대': 0, '60대': 0, '70대↑': 0 };
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
                    <td>{item.moduleIds.map(id => getModule(id)?.shortName || id).join(', ') || '-'}</td>
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

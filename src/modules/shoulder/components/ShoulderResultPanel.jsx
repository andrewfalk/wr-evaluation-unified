function RatioBar({ ratio }) {
  const pct = Math.min(ratio * 100, 100);
  const level = ratio >= 1.0 ? 'danger' : ratio >= 0.7 ? 'warning' : 'safe';
  return (
    <div className="result-inline-meter">
      <div className="result-inline-track">
        <div className={`result-inline-fill level-${level}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`result-inline-value level-${level}`}>
        {(ratio * 100).toFixed(0)}%
      </span>
    </div>
  );
}

export function ShoulderResultPanel({ calc }) {
  if (!calc?.totals) return null;

  const { totals, jobBurdens, anyRepetitiveExceeded, age, bmi } = calc;
  const jobsWithData = (jobBurdens || []).filter(j => j.jobName);

  return (
    <div className="panel">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>BK2117 노출 분석</h2>
          <p className="section-description">전체 누적 노출, 반복동작 기준 충족 여부, 직력별 기여 상세를 함께 확인합니다.</p>
        </div>
      </div>

      <div className="result-panel">
        <div>
          <div className="result-section-heading">
            <div className="result-section-title">전체 누적 합산 (모든 직력)</div>
            <div className="result-section-caption">노출 유형별 누적 시간과 임계값 비교</div>
          </div>
          <div className="result-table-wrap">
            <table className="result-table">
              <thead>
                <tr>
                  <th>노출 유형</th>
                  <th className="align-right">누적 시간</th>
                  <th className="align-right">임계값</th>
                  <th>비율</th>
                  <th className="align-center">초과</th>
                </tr>
              </thead>
              <tbody>
                {totals.map(t => (
                  <tr key={t.key} className={t.exceeded ? 'is-alert' : ''}>
                    <td>{t.label}</td>
                    <td className={`align-right ${t.exceeded ? 'result-table-emphasis-danger' : ''}`}>
                      {t.totalHours > 0 ? `${t.totalHours.toFixed(1)}시간` : '-'}
                    </td>
                    <td className="align-right result-table-muted">{t.limit.toLocaleString()}시간</td>
                    <td>
                      {t.totalHours > 0 ? <RatioBar ratio={t.ratio} /> : <span className="result-card-meta">-</span>}
                    </td>
                    <td className="align-center">
                      {t.exceeded && <span className="result-checkmark">✓</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="result-note">
          ※ 반복동작은 중간속도 OR 고도 중 하나라도 임계값 초과 시 기준 충족
          {anyRepetitiveExceeded && <strong> → 반복동작 기준 충족</strong>}
        </div>

        {jobsWithData.length > 1 && (
          <div>
            <div className="result-section-heading">
              <div className="result-section-title">직력별 기여 상세</div>
              <div className="result-section-caption">직종별 일평균 노출과 누적 기여 시간</div>
            </div>
            <div className="result-detail-stack">
              {jobsWithData.map((j, idx) => (
                <div key={j.id} className="result-detail-card">
                  <div className="result-card-title">
                    직력 {idx + 1}: {j.jobName}
                  </div>
                  <div className="result-card-meta">
                    {j.periodYears > 0 ? `${j.periodYears.toFixed(1)}년` : '-'} · {j.workDaysPerYear}일/년
                  </div>
                  <div className="result-table-wrap result-table-wrap-spaced">
                    <table className="result-table">
                      <thead>
                        <tr>
                          <th>항목</th>
                          <th className="align-right">일평균</th>
                          <th className="align-right">기여 누적</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(j.exposures || []).map(exp => (
                          <tr key={exp.key}>
                            <td>{exp.label}</td>
                            <td className="align-right">{exp.dailyHours > 0 ? `${parseFloat(exp.dailyHours.toFixed(2))}시간/일` : '-'}</td>
                            <td className="align-right">{exp.cumulativeHours > 0 ? `${exp.cumulativeHours.toFixed(1)}시간` : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="result-detail-card">
          <div className="result-metric-list">
            <div className="result-metric-row"><span>만 나이</span><strong>{age || '-'}세</strong></div>
            <div className="result-metric-row"><span>BMI</span><strong>{bmi || '-'}</strong></div>
          </div>
        </div>
      </div>
    </div>
  );
}

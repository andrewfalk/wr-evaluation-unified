const td = { padding: '5px 8px', borderBottom: '1px solid var(--border)' };
const tdR = { ...td, textAlign: 'right' };
const tdC = { ...td, textAlign: 'center' };

function RatioBar({ ratio }) {
  const pct = Math.min(ratio * 100, 100);
  const color = ratio >= 1.0 ? 'var(--danger, #dc3545)' : ratio >= 0.7 ? 'var(--warning, #f5a623)' : 'var(--primary, #667eea)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: '0.75rem', color, fontWeight: ratio >= 1.0 ? 700 : undefined, minWidth: 38, textAlign: 'right' }}>
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
      <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>BK2117 노출 분석</h2>

      {/* 전체 누적 합산 vs 임계값 */}
      <h3 style={{ fontSize: '0.88rem', marginBottom: 8 }}>전체 누적 합산 (모든 직력)</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', marginBottom: 16 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--border)' }}>
            <th style={{ ...td, textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>노출 유형</th>
            <th style={{ ...tdR, color: 'var(--text-muted)', fontWeight: 500 }}>누적 시간</th>
            <th style={{ ...tdR, color: 'var(--text-muted)', fontWeight: 500 }}>임계값</th>
            <th style={{ ...td, color: 'var(--text-muted)', fontWeight: 500, minWidth: 100 }}>비율</th>
            <th style={{ ...tdC, color: 'var(--text-muted)', fontWeight: 500 }}>초과</th>
          </tr>
        </thead>
        <tbody>
          {totals.map(t => (
            <tr key={t.key} style={{ background: t.exceeded ? 'rgba(220,53,69,0.05)' : undefined }}>
              <td style={td}>{t.label}</td>
              <td style={{ ...tdR, fontWeight: t.exceeded ? 700 : undefined, color: t.exceeded ? 'var(--danger, #dc3545)' : undefined }}>
                {t.totalHours > 0 ? `${t.totalHours.toFixed(1)}시간` : '-'}
              </td>
              <td style={{ ...tdR, color: 'var(--text-muted)' }}>{t.limit.toLocaleString()}시간</td>
              <td style={td}>
                {t.totalHours > 0 ? <RatioBar ratio={t.ratio} /> : <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>-</span>}
              </td>
              <td style={tdC}>
                {t.exceeded && <span style={{ color: 'var(--danger, #dc3545)', fontWeight: 700 }}>✓</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 반복동작 OR 조건 안내 */}
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 16, padding: '6px 10px', background: 'var(--card-bg)', borderRadius: 6 }}>
        ※ 반복동작은 중간속도 OR 고도 중 하나라도 임계값 초과 시 기준 충족
        {anyRepetitiveExceeded && <span style={{ color: 'var(--danger, #dc3545)', fontWeight: 600, marginLeft: 8 }}>→ 반복동작 기준 충족</span>}
      </div>

      {/* 직력별 기여 상세 */}
      {jobsWithData.length > 1 && (
        <>
          <h3 style={{ fontSize: '0.88rem', marginBottom: 8 }}>직력별 기여 상세</h3>
          {jobsWithData.map((j, idx) => (
            <div key={j.id} className="assessment-box" style={{ marginBottom: 10, padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 6 }}>
                직력 {idx + 1}: {j.jobName}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem', marginLeft: 8 }}>
                  {j.periodYears > 0 ? `${j.periodYears.toFixed(1)}년` : '-'} · {j.workDaysPerYear}일/년
                </span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.77rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ ...td, textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>항목</th>
                    <th style={{ ...tdR, color: 'var(--text-muted)', fontWeight: 500 }}>일평균</th>
                    <th style={{ ...tdR, color: 'var(--text-muted)', fontWeight: 500 }}>기여 누적</th>
                  </tr>
                </thead>
                <tbody>
                  {(j.exposures || []).map(exp => (
                    <tr key={exp.key} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={td}>{exp.label}</td>
                      <td style={tdR}>{exp.dailyHours > 0 ? `${parseFloat(exp.dailyHours.toFixed(2))}시간/일` : '-'}</td>
                      <td style={tdR}>{exp.cumulativeHours > 0 ? `${exp.cumulativeHours.toFixed(1)}시간` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      <div className="assessment-box" style={{ marginTop: 8 }}>
        <div className="assessment-row">
          <span>만 나이</span>
          <span className="assessment-value value-neutral">{age || '-'}세</span>
        </div>
        <div className="assessment-row">
          <span>BMI</span>
          <span className="assessment-value value-neutral">{bmi || '-'}</span>
        </div>
      </div>
    </div>
  );
}

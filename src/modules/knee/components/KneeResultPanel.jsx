export function KneeResultPanel({ calc }) {
  if (!calc?.relatedness) return null;

  const avg = ((+calc.relatedness.min + +calc.relatedness.max) / 2).toFixed(1);

  return (
    <div className="panel">
      <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>결과</h2>

      {/* 신체부담기여도 */}
      <div className="result-card" title="직종별 신체부담 합산 기여도 (최소~최대%)">
        <h3>신체부담기여도</h3>
        <div className="result-value">{calc.relatedness.min}% ~ {calc.relatedness.max}%</div>
        <div className="result-sub">평균: {avg}%</div>
      </div>

      {/* 누적신체부담 + 나이 */}
      <div className="assessment-box">
        <div className="assessment-row">
          <span title="평균 기여도 50% 이상이면 충분함">누적신체부담</span>
          <span className={`assessment-value ${calc.cumulativeBurden === '충분함' ? 'value-positive' : 'value-negative'}`}>{calc.cumulativeBurden}</span>
        </div>
        <div className="assessment-row">
          <span>만 나이</span>
          <span className="assessment-value value-neutral">{calc.age || '-'}세</span>
        </div>
      </div>

      {/* 직종별 신체부담 */}
      <h3 style={{ margin: '15px 0 10px', fontSize: '0.9rem' }}>직종별 신체부담</h3>
      {(calc.jobBurdens || []).filter(j => j.jobName).map((j) => {
        const bc = j.burden.level === '고도' ? 'high' : j.burden.level === '중등도상' ? 'medium-high' : j.burden.level === '중등도하' ? 'medium-low' : 'low';
        return (
          <div key={j.id} className="assessment-box" style={{ marginBottom: 8, padding: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem' }}>{j.jobName}</span>
              <span className={`job-badge badge-${bc}`}>{j.burden.level}</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
              {j.period} | {j.weight || '-'}kg | {j.squatting || '-'}분
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function KneeResultPanel({ calc }) {
  if (!calc?.relatedness) return null;

  const avg = ((+calc.relatedness.min + +calc.relatedness.max) / 2).toFixed(1);

  return (
    <div className="panel">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>결과</h2>
          <p className="section-description">무릎 신체부담 기여도와 직종별 부담 수준을 요약합니다.</p>
        </div>
      </div>

      <div className="result-panel">
        <div className="result-summary-grid">
          <div className="result-summary-card" title="직종별 신체부담 합산 기여도 (최소~최대%)">
            <div className="result-summary-label">신체부담기여도</div>
            <div className="result-summary-value">{calc.relatedness.min}% ~ {calc.relatedness.max}% <span className="result-summary-unit">(평균 {avg}%)</span></div>
            <div className="result-summary-sub">직종별 신체부담 합산 기여도입니다.</div>
          </div>
          <div className={`result-summary-card ${calc.cumulativeBurden === '충분함' ? 'is-safe' : 'is-danger'}`}>
            <div className="result-summary-label">누적신체부담</div>
            <div className="result-summary-value">{calc.cumulativeBurden}</div>
            <div className="result-summary-sub">평균 기여도 50% 이상이면 충분함으로 봅니다.</div>
          </div>
          <div className="result-summary-card">
            <div className="result-summary-label">만 나이</div>
            <div className="result-summary-value">{calc.age || '-'}<span className="result-summary-unit">세</span></div>
            <div className="result-summary-sub">공통 정보 탭의 생년월일 기준입니다.</div>
          </div>
        </div>

        <div>
          <div className="result-section-heading">
            <div className="result-section-title">직종별 신체부담</div>
            <div className="result-section-caption">입력한 직력별 부담 수준과 요약값</div>
          </div>
          <div className="result-detail-stack">
            {(calc.jobBurdens || []).filter(j => j.jobName).map((j) => {
        const bc = j.burden.level === '고도' ? 'high' : j.burden.level === '중등도상' ? 'medium-high' : j.burden.level === '중등도하' ? 'medium-low' : 'low';
        return (
          <div key={j.id} className="result-detail-card">
            <div className="result-card-top">
              <div>
                <div className="result-card-title">{j.jobName}</div>
                <div className="result-card-meta">{j.period} | {j.weight || '-'}kg | {j.squatting || '-'}분</div>
              </div>
              <span className={`job-badge badge-${bc}`}>{j.burden.level}</span>
            </div>
          </div>
        );
      })}
          </div>
        </div>
      </div>
    </div>
  );
}

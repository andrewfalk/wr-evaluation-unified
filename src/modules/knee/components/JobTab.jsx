import { calculatePhysicalBurden } from '../utils/calculations';
import { createKneeJobExtras } from '../utils/data';

export function JobTab({ sharedJobs, jobExtras, onChange, errors }) {
  // shared job에 매칭되는 extras 찾기 (없으면 자동 생성)
  const getExtras = (sharedJobId) => {
    return jobExtras.find(e => e.sharedJobId === sharedJobId);
  };

  const handleExtra = (sharedJobId, field, value) => {
    const updated = [...jobExtras];
    const idx = updated.findIndex(e => e.sharedJobId === sharedJobId);
    if (idx >= 0) {
      updated[idx] = { ...updated[idx], [field]: value };
    } else {
      const newExtra = createKneeJobExtras(sharedJobId);
      newExtra[field] = value;
      updated.push(newExtra);
    }
    onChange(updated);
  };

  return (
    <section className="section pattern-surface form-section">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F9B5;</span>무릎 신체부담 평가</h2>
          <p className="section-description">각 직종별 무릎 관련 신체부담을 입력하세요. 직종 추가와 수정은 기본정보 탭에서 할 수 있습니다.</p>
        </div>
      </div>
      {errors?.jobs && <div className="error-message">{errors.jobs}</div>}
      {sharedJobs.map((job, i) => {
        const extras = getExtras(job.id) || createKneeJobExtras(job.id);
        const b = calculatePhysicalBurden(extras.weight, extras.squatting);
        const bc = b.level === '고도' ? 'badge-high' : b.level === '중등도상' ? 'badge-medium-high' : b.level === '중등도하' ? 'badge-medium-low' : 'badge-low';
        return (
          <div key={job.id} className="job-card">
            <div className="job-card-header">
              <div className="card-title-stack">
                <span className="job-card-title">직력 {i + 1}: {job.jobName || '(미입력)'}</span>
                <span className="job-meta-line">직종별 하중과 자세 부담을 따로 기록합니다.</span>
              </div>
              <span className={`job-badge ${bc}`}>{b.level} ({b.minScore}~{b.maxScore})</span>
            </div>
            <div className="form-row">
              <div className="form-group"><label>쪼그려앉기 (분/일)</label><input type="number" value={extras.squatting} onChange={e => handleExtra(job.id, 'squatting', e.target.value)} min="0" /></div>
              <div className="form-group"><label>중량물 (kg/일)</label><input type="number" value={extras.weight} onChange={e => handleExtra(job.id, 'weight', e.target.value)} min="0" /></div>
            </div>
            <div className="job-check-grid">
              {[['stairs', '계단오르내리기'], ['kneeTwist', '무릎 비틀림'], ['startStop', '출발/정지 반복'], ['tightSpace', '좁은 공간'], ['kneeContact', '무릎 접촉/충격'], ['jumpDown', '뛰어내리기']].map(([key, label]) => (
                <label key={key} className="checkbox-label"><input type="checkbox" checked={extras[key] || false} onChange={e => handleExtra(job.id, key, e.target.checked)} /><span>{label}</span></label>
              ))}
            </div>
          </div>
        );
      })}
      {sharedJobs.length === 0 && (
        <div className="evaluation-empty-state">기본정보 탭에서 직종을 추가하세요.</div>
      )}
    </section>
  );
}

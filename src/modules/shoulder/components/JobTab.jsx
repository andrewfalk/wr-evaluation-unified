import { createShoulderJobExtras } from '../utils/data';

const GENERIC_FIELDS = [
  { key: 'overheadHours',        label: '오버헤드/어깨높이 이상 작업', unit: '시간/일' },
  { key: 'repetitiveMediumHours', label: '반복동작 중간속도 (4~14회/분)', unit: '시간/일' },
  { key: 'repetitiveFastHours',  label: '반복동작 고도 (≥15회/분)',     unit: '시간/일' },
  { key: 'vibrationHours',       label: '손-팔 진동 (≥3 m/s²)',        unit: '시간/일' },
];

const inputStyle = {
  width: 72,
  textAlign: 'right',
  padding: '3px 6px',
};

const unitStyle = {
  fontSize: '0.75rem',
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
  minWidth: 36,
};

const labelStyle = {
  flex: 1,
  fontSize: '0.82rem',
  minWidth: 0,
};

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 0',
};

export function JobTab({ sharedJobs, jobExtras, onChange, errors }) {
  const getExtras = (sharedJobId) =>
    jobExtras.find(e => e.sharedJobId === sharedJobId);

  const handleExtra = (sharedJobId, field, value) => {
    const updated = [...jobExtras];
    const idx = updated.findIndex(e => e.sharedJobId === sharedJobId);
    if (idx >= 0) {
      updated[idx] = { ...updated[idx], [field]: value };
    } else {
      const newExtra = createShoulderJobExtras(sharedJobId);
      newExtra[field] = value;
      updated.push(newExtra);
    }
    onChange(updated);
  };

  return (
    <div className="section">
      <h2 className="section-title"><span className="section-icon">&#x1F4AA;</span>어깨 신체부담 평가</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 12 }}>
        각 직종별 일평균 노출 시간을 입력하세요. 누적 기준 비교는 우측 패널에서 확인할 수 있습니다.
      </p>
      {errors?.jobs && <div className="error-message">{errors.jobs}</div>}
      {sharedJobs.map((job, i) => {
        const extras = getExtras(job.id) || createShoulderJobExtras(job.id);
        const hasInput = GENERIC_FIELDS.some(f => extras[f.key] !== '' && extras[f.key] !== undefined)
          || extras.heavyLoadCount !== '' || extras.heavyLoadSeconds !== '';

        return (
          <div key={job.id} className="job-card">
            <div className="job-card-header">
              <span style={{ fontWeight: 600 }}>직력 {i + 1}: {job.jobName || '(미입력)'}</span>
              {!hasInput && (
                <span className="job-badge badge-low" style={{ fontSize: '0.72rem' }}>미입력</span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>

              {/* 일반 필드 */}
              {GENERIC_FIELDS.map(({ key, label, unit }) => (
                <div key={key} style={rowStyle}>
                  <span style={labelStyle}>{label}</span>
                  <input
                    type="number"
                    value={extras[key] ?? ''}
                    onChange={e => handleExtra(job.id, key, e.target.value)}
                    min="0"
                    step="0.1"
                    style={inputStyle}
                  />
                  <span style={unitStyle}>{unit}</span>
                </div>
              ))}

              {/* 중량물 취급 — 횟수 + 시간 */}
              <div style={{ ...rowStyle, borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2 }}>
                <span style={labelStyle}>중량물(≥20kg) 취급</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>횟수</span>
                <input
                  type="number"
                  value={extras.heavyLoadCount ?? ''}
                  onChange={e => handleExtra(job.id, 'heavyLoadCount', e.target.value)}
                  min="0"
                  step="1"
                  style={{ ...inputStyle, width: 60 }}
                />
                <span style={unitStyle}>회/일</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>시간</span>
                <input
                  type="number"
                  value={extras.heavyLoadSeconds ?? ''}
                  onChange={e => handleExtra(job.id, 'heavyLoadSeconds', e.target.value)}
                  min="0"
                  step="1"
                  style={{ ...inputStyle, width: 60 }}
                />
                <span style={unitStyle}>초/회</span>
              </div>

            </div>
          </div>
        );
      })}
      {sharedJobs.length === 0 && (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>기본정보 탭에서 직종을 추가하세요.</p>
      )}
    </div>
  );
}

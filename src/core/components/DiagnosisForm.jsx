import { getDiagnosisModuleHint } from '../utils/diagnosisMapping';

export function DiagnosisForm({ diagnoses, onChange, errors, createDiagnosis, showModuleHints = false }) {
  const handleDiagnosis = (i, field, value) => {
    const updated = [...diagnoses];
    updated[i] = { ...updated[i], [field]: value };
    onChange(updated);
  };

  const addDiagnosis = () => {
    onChange([...diagnoses, createDiagnosis()]);
  };

  const removeDiagnosis = (i) => {
    if (diagnoses.length > 1) {
      onChange(diagnoses.filter((_, x) => x !== i));
    }
  };

  return (
    <section className="section pattern-surface form-section">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1FA7A;</span>신청 상병</h2>
          <p className="section-description">진단코드, 진단명, 방향을 입력해 평가 대상 상병을 구성합니다.</p>
        </div>
        <div className="section-actions">
          <button className="btn btn-primary btn-sm" onClick={addDiagnosis}>+ 상병 추가</button>
        </div>
      </div>
      {errors?.diagnoses && <div className="error-message">{errors.diagnoses}</div>}
      {diagnoses.map((diag, i) => {
        const hint = getDiagnosisModuleHint(diag);
        const isAxial = hint?.moduleId === 'spine' || hint?.moduleId === 'cervical';
        return (
        <div key={diag.id} className="diagnosis-card">
          <div className="diagnosis-card-header">
            <div className="card-title-stack">
              <span className="diagnosis-card-title">상병 #{i + 1}</span>
              <span className="diagnosis-card-subtitle">필수 입력값을 채우면 모듈 추천과 평가 흐름에 반영됩니다.</span>
            </div>
            {showModuleHints && hint && <span className="diagnosis-module-badge">{hint.label}</span>}
            {diagnoses.length > 1 && <button className="btn btn-danger btn-xs" onClick={() => removeDiagnosis(i)}>삭제</button>}
          </div>
          <div className="form-row">
            <div className="form-group"><label>진단코드 *</label><input value={diag.code} onChange={e => handleDiagnosis(i, 'code', e.target.value)} placeholder="M17.0" /></div>
            <div className="form-group"><label>진단명 *</label><input value={diag.name} onChange={e => handleDiagnosis(i, 'name', e.target.value)} placeholder="진단명 입력" /></div>
          </div>
          {!isAxial && (
          <div className="form-group">
            <label>방향</label>
            <div className="radio-group">
              {['right', 'left', 'both'].map(v => (
                <label key={v} className="radio-label">
                  <input type="radio" name={`side_${i}`} value={v} checked={diag.side === v} onChange={e => handleDiagnosis(i, 'side', e.target.value)} />
                  <span>{v === 'right' ? '우측' : v === 'left' ? '좌측' : '양측'}</span>
                </label>
              ))}
            </div>
          </div>
          )}
        </div>
        );
      })}
    </section>
  );
}

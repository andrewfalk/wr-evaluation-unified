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
    <div className="section">
      <h2 className="section-title"><span className="section-icon">&#x1FA7A;</span>신청 상병</h2>
      {errors?.diagnoses && <div className="error-message">{errors.diagnoses}</div>}
      {diagnoses.map((diag, i) => {
        const hint = getDiagnosisModuleHint(diag);
        const isSpine = hint?.moduleId === 'spine';
        return (
        <div key={diag.id} className="diagnosis-card">
          <div className="diagnosis-card-header">
            <span className="diagnosis-card-title">상병 #{i + 1}</span>
            {showModuleHints && hint && <span className="diagnosis-module-badge">{hint.label}</span>}
            {diagnoses.length > 1 && <button className="btn btn-danger btn-xs" onClick={() => removeDiagnosis(i)}>삭제</button>}
          </div>
          <div className="form-row">
            <div className="form-group"><label>진단코드 *</label><input value={diag.code} onChange={e => handleDiagnosis(i, 'code', e.target.value)} placeholder="M17.0" /></div>
            <div className="form-group"><label>진단명 *</label><input value={diag.name} onChange={e => handleDiagnosis(i, 'name', e.target.value)} placeholder="진단명 입력" /></div>
          </div>
          {!isSpine && (
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
      <button className="btn btn-primary btn-sm" onClick={addDiagnosis}>+ 상병 추가</button>
    </div>
  );
}

import { useLayoutEffect, useRef } from 'react';
import { getAllModules } from '../moduleRegistry';
import {
  getDiagnosisModuleHint,
  isValidDiagnosisModuleId,
  resolveDiagnosisModule,
} from '../utils/diagnosisMapping';

// 진단명은 길어질 수 있어 단일행 input은 잘린다 — 내용에 맞춰 높이가 늘어나는 textarea.
// 값은 한 줄 텍스트로 취급(Enter 차단, 붙여넣기 개행은 공백으로).
function DiagnosisNameInput({ value, onChange, placeholder }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="diagnosis-name-input"
      rows="1"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
      onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
    />
  );
}

export function DiagnosisForm({ diagnoses, onChange, errors, createDiagnosis, showModuleHints = false, activeModules = [] }) {
  const moduleOptions = getAllModules().filter(mod => isValidDiagnosisModuleId(mod.id));

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
        const resolved = resolveDiagnosisModule(diag, activeModules);
        const isManual = diag.moduleId != null && diag.moduleId !== '';
        const isExplicitNone = diag.moduleId === '__none__';
        const isAxial = resolved?.moduleId === 'spine' || resolved?.moduleId === 'cervical';
        return (
        <div key={diag.id} id={`diagnosis-card-${diag.id}`} className="diagnosis-card">
          <div className="diagnosis-card-header">
            <div className="card-title-stack">
              <span className="diagnosis-card-title">상병 #{i + 1}</span>
              <span className="diagnosis-card-subtitle">필수 입력값을 채우면 모듈 추천과 평가 흐름에 반영됩니다.</span>
            </div>
            {showModuleHints && (resolved || isExplicitNone) && (
              <span className="diagnosis-module-badge">
                {isExplicitNone ? '해당 없음' : resolved.label}
                {isManual && ' · 수동'}
              </span>
            )}
            {diagnoses.length > 1 && <button className="btn btn-danger btn-xs" onClick={() => removeDiagnosis(i)}>삭제</button>}
          </div>
          <div className="form-row diagnosis-code-name-row">
            <div className="form-group">
              <label>진단코드 *</label>
              <input value={diag.code} onChange={e => handleDiagnosis(i, 'code', e.target.value)} placeholder="M17.0" />
              {errors?.diagnosisRows?.[diag.id]?.code && <div className="error-message">{errors.diagnosisRows[diag.id].code}</div>}
            </div>
            <div className="form-group">
              <label>진단명 *</label>
              <DiagnosisNameInput value={diag.name} onChange={v => handleDiagnosis(i, 'name', v)} placeholder="진단명 입력" />
              {errors?.diagnosisRows?.[diag.id]?.name && <div className="error-message">{errors.diagnosisRows[diag.id].name}</div>}
            </div>
          </div>
          <div className="form-group">
            <label>평가 모듈</label>
            <select
              value={diag.moduleId || ''}
              onChange={e => handleDiagnosis(i, 'moduleId', e.target.value === '' ? null : e.target.value)}
            >
              <option value="">자동 (감지: {hint?.label || '없음'})</option>
              {moduleOptions.map(mod => (
                <option key={mod.id} value={mod.id}>{mod.icon ? `${mod.icon} ` : ''}{mod.name}</option>
              ))}
              <option value="__none__">해당 없음</option>
            </select>
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

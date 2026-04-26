import { useState } from 'react';
import { BasicInfoForm } from './BasicInfoForm';
import { DiagnosisForm } from './DiagnosisForm';
import { getAllModules } from '../moduleRegistry';
import { suggestModules } from '../utils/diagnosisMapping';
import { createDiagnosis } from '../utils/data';

const INTAKE_STEPS = [
  { id: 'info', label: '기본정보' },
  { id: 'diagnosis', label: '상병 입력' },
  { id: 'modules', label: '모듈 선택' },
];

export function IntakeWizard({
  shared,
  onSharedChange,
  hasExistingPatients,
  onCancel,
  onComplete,
  errors,
  presets,
  presetMeta,
  presetError,
}) {
  const [step, setStep] = useState(0);
  const [selectedModules, setSelectedModules] = useState([]);

  const intakeDiagnoses = shared.diagnoses || [createDiagnosis()];
  const suggested = suggestModules(intakeDiagnoses);
  const allModules = getAllModules();

  const goStep = (next) => {
    if (next === 2 && selectedModules.length === 0 && suggested.length > 0) {
      setSelectedModules([...suggested]);
    }
    setStep(next);
  };

  return (
    <div className="app-layout landing-layout">
      <div className="panel intake-panel pattern-surface pattern-surface-hero">
        <div className="intake-header">
          <div className="section-title-row">
            <h1 className="landing-title intake-title">새 환자 평가</h1>
            <p className="landing-description intake-description">기본정보, 상병, 모듈 선택 순서로 신규 환자를 등록합니다.</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>
            {hasExistingPatients ? '돌아가기' : '취소'}
          </button>
        </div>

        <div className="wizard-steps">
          {INTAKE_STEPS.map((s, i) => (
            <div key={s.id} className={`wizard-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => i < step && goStep(i)}>
              <span className="wizard-step-num">{i < step ? '✓' : i + 1}</span>
              <span className="wizard-step-label">{s.label}</span>
            </div>
          ))}
        </div>

        {step === 0 && (
          <>
            <BasicInfoForm shared={shared} onChange={onSharedChange} errors={errors} presets={presets} presetMeta={presetMeta} presetError={presetError} />
            <div className="wizard-actions">
              <span />
              <button className="btn btn-primary" onClick={() => goStep(1)}>다음: 상병 입력 &rarr;</button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <DiagnosisForm
              diagnoses={intakeDiagnoses}
              onChange={newDiag => onSharedChange(prev => ({ ...prev, diagnoses: newDiag }))}
              errors={errors}
              createDiagnosis={createDiagnosis}
              showModuleHints
            />
            <div className="wizard-actions">
              <button className="btn btn-secondary" onClick={() => goStep(0)}>&larr; 이전</button>
              <button className="btn btn-primary" onClick={() => goStep(2)}>다음: 모듈 선택 &rarr;</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <section className="section pattern-surface form-section">
              <div className="section-header">
                <div className="section-title-row">
                  <h2 className="section-title"><span className="section-icon">&#x1F4CB;</span>평가 모듈 선택</h2>
                  <p className="section-description">입력된 상병을 기반으로 평가 모듈이 자동 추천되었습니다.</p>
                </div>
              </div>
              <div className="module-check-cards">
                {allModules.map(mod => {
                  const isSuggested = suggested.includes(mod.id);
                  const isSelected = selectedModules.includes(mod.id);
                  return (
                    <label key={mod.id} className={`module-check-card ${isSelected ? 'active' : ''} ${isSuggested ? 'suggested' : ''}`}>
                      <input type="checkbox" checked={isSelected} onChange={() => {
                        setSelectedModules(prev => prev.includes(mod.id) ? prev.filter(id => id !== mod.id) : [...prev, mod.id]);
                      }} />
                      <span className="module-check-icon">{mod.icon}</span>
                      <div>
                        <div className="module-check-name">{mod.name}</div>
                        <div className="module-check-copy">{mod.description}</div>
                      </div>
                      {isSuggested && <span className="module-check-badge">자동감지</span>}
                    </label>
                  );
                })}
              </div>
            </section>
            <div className="wizard-actions">
              <button className="btn btn-secondary" onClick={() => goStep(1)}>&larr; 이전</button>
              <button className="btn btn-primary" onClick={() => onComplete(selectedModules)}
                disabled={selectedModules.length === 0}>
                평가 시작 ({selectedModules.length}개 모듈)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { BasicInfoForm } from './BasicInfoForm';
import { DiagnosisForm } from './DiagnosisForm';
import { getAllModules } from '../moduleRegistry';
import { isValidDiagnosisModuleId, suggestModules } from '../utils/diagnosisMapping';
import { createDiagnosis } from '../utils/data';
import { validateIntakeStep, listIntakeIssues, INTAKE_STEP_INFO, INTAKE_STEP_DIAGNOSIS } from '../utils/intakeValidation';

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
  session,
}) {
  const [step, setStep] = useState(0);
  const [selectedModules, setSelectedModules] = useState([]);
  // "다음"을 눌러 지나간 단계 — 그 단계의 미해결 항목을 안내한다(이동은 막지 않는다). 오류는 현재 shared에서
  // 매번 다시 계산하므로 값을 고치면 안내가 자동으로 사라진다.
  const [attemptedSteps, setAttemptedSteps] = useState([]);

  const intakeDiagnoses = shared.diagnoses || [createDiagnosis()];
  const suggested = suggestModules(intakeDiagnoses);
  const allModules = getAllModules();
  const explicitModules = intakeDiagnoses
    .map(diag => diag.moduleId)
    .filter(isValidDiagnosisModuleId);
  const finalSelectedModules = Array.from(new Set([...selectedModules, ...explicitModules]));

  const goStep = (next) => {
    if (next === 2 && selectedModules.length === 0 && suggested.length > 0) {
      setSelectedModules([...suggested]);
    }
    setStep(next);
  };

  // "다음": 현재 단계를 안내 대상으로 표시하고 이동한다.
  const goNext = (next) => {
    setAttemptedSteps((prev) => (prev.includes(step) ? prev : [...prev, step]));
    goStep(next);
  };

  const stepErrors = {
    [INTAKE_STEP_INFO]: attemptedSteps.includes(INTAKE_STEP_INFO) ? validateIntakeStep(INTAKE_STEP_INFO, shared) : null,
    [INTAKE_STEP_DIAGNOSIS]: attemptedSteps.includes(INTAKE_STEP_DIAGNOSIS) ? validateIntakeStep(INTAKE_STEP_DIAGNOSIS, shared) : null,
  };
  const issues = [INTAKE_STEP_INFO, INTAKE_STEP_DIAGNOSIS]
    .flatMap((s) => listIntakeIssues(s, stepErrors[s], shared));

  // 요약 항목을 누르면 해당 단계로 이동하고(상병 행이면 그 행으로 스크롤) 필드별 안내를 다시 보여준다.
  const jumpToIssue = (issue) => {
    setStep(issue.step);
    if (issue.rowId) {
      setTimeout(() => {
        const el = document.getElementById(`diagnosis-card-${issue.rowId}`);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
      }, 0);
    }
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

        {issues.length > 0 && (
          <div className="intake-issues" role="status">
            <div className="intake-issues-title">확인이 필요한 항목 {issues.length}개 <span className="intake-issues-note">(입력하지 않아도 다음 단계로 이동할 수 있습니다)</span></div>
            <ul className="intake-issues-list">
              {issues.map((issue) => (
                <li key={issue.key}>
                  <button type="button" className="intake-issue-link" onClick={() => jumpToIssue(issue)}>
                    {issue.label} — {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === 0 && (
          <>
            <BasicInfoForm shared={shared} onChange={onSharedChange} errors={{ ...errors, ...stepErrors[INTAKE_STEP_INFO] }} presets={presets} presetMeta={presetMeta} presetError={presetError} session={session} />
            <div className="wizard-actions">
              <span />
              <button className="btn btn-primary" onClick={() => goNext(1)}>다음: 상병 입력 &rarr;</button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <DiagnosisForm
              diagnoses={intakeDiagnoses}
              onChange={newDiag => onSharedChange(prev => ({ ...prev, diagnoses: newDiag }))}
              errors={{ ...errors, ...stepErrors[INTAKE_STEP_DIAGNOSIS] }}
              createDiagnosis={createDiagnosis}
              showModuleHints
              activeModules={selectedModules}
            />
            <div className="wizard-actions">
              <button className="btn btn-secondary" onClick={() => goStep(0)}>&larr; 이전</button>
              <button className="btn btn-primary" onClick={() => goNext(2)}>다음: 모듈 선택 &rarr;</button>
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
              <button className="btn btn-primary" onClick={() => onComplete(finalSelectedModules)}
                disabled={finalSelectedModules.length === 0}>
                평가 시작 ({finalSelectedModules.length}개 모듈)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { AssessmentTab } from './AssessmentTab';
import { generateUnifiedReport } from '../utils/reportGenerator';

export function AssessmentStep({ patient, activeModules, updateDiagnoses, updateModuleById }) {
  const diagnoses = patient.data.shared.diagnoses || [];

  const handleDiagnosisUpdate = (index, field, value) => {
    const updated = [...diagnoses];
    updated[index] = { ...updated[index], [field]: value };
    updateDiagnoses(updated);
  };

  const hasKnee = activeModules.includes('knee');
  const hasWrist = activeModules.includes('wrist');
  const hasShoulder = activeModules.includes('shoulder');
  const hasElbow = activeModules.includes('elbow');
  const hasCervical = activeModules.includes('cervical');
  const kneeData = patient.data.modules?.knee || {};
  const wristData = patient.data.modules?.wrist || {};
  const shoulderData = patient.data.modules?.shoulder || {};
  const elbowData = patient.data.modules?.elbow || {};
  const cervicalData = patient.data.modules?.cervical || {};
  const returnConsiderations = kneeData.returnConsiderations
    || wristData.returnConsiderations
    || shoulderData.returnConsiderations
    || elbowData.returnConsiderations
    || cervicalData.returnConsiderations
    || '';

  const handleReturnChange = (value) => {
    if (hasKnee) {
      updateModuleById('knee', current => ({ ...current, returnConsiderations: value }));
    }
    if (hasWrist) {
      updateModuleById('wrist', current => ({ ...current, returnConsiderations: value }));
    }
    if (hasShoulder) {
      updateModuleById('shoulder', current => ({ ...current, returnConsiderations: value }));
    }
    if (hasElbow) {
      updateModuleById('elbow', current => ({ ...current, returnConsiderations: value }));
    }
    if (hasCervical) {
      updateModuleById('cervical', current => ({ ...current, returnConsiderations: value }));
    }
  };

  const previewText = generateUnifiedReport(patient);

  return (
    <div className="assessment-step-layout">
      <div className="panel pattern-surface assessment-panel">
        {(hasKnee || hasWrist || hasShoulder || hasElbow || hasCervical || activeModules.includes('spine')) && (
          <AssessmentTab
            diagnoses={diagnoses}
            onDiagnosisUpdate={handleDiagnosisUpdate}
            returnConsiderations={returnConsiderations}
            onReturnChange={handleReturnChange}
            activeModules={activeModules}
          />
        )}
      </div>
      <div className="panel pattern-surface assessment-preview-panel">
        <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>미리보기</h2>
        <p className="preview-caption">
          입력 내용은 오른쪽 미리보기 패널에 즉시 반영됩니다.
        </p>
        <div className="report-preview">
          <div className="report-preview-toolbar">
            <span className="report-preview-label">통합 리포트 초안</span>
            <span className="report-preview-hint">상병 {diagnoses.length}건 기준 자동 생성</span>
          </div>
          <div className="preview-section">{previewText}</div>
        </div>
      </div>
    </div>
  );
}

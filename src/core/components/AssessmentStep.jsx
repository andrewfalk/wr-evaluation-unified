import { AssessmentTab } from '../../modules/knee/components/AssessmentTab';
import { generateUnifiedReport } from '../utils/reportGenerator';

export function AssessmentStep({ patient, activeModules, updateDiagnoses, updateModuleById }) {
  const diagnoses = patient.data.shared.diagnoses || [];

  const handleDiagnosisUpdate = (i, field, value) => {
    const updated = [...diagnoses];
    updated[i] = { ...updated[i], [field]: value };
    updateDiagnoses(updated);
  };

  const hasKnee = activeModules.includes('knee');
  const hasSpine = activeModules.includes('spine');
  const hasShoulder = activeModules.includes('shoulder');
  const kneeData = patient.data.modules?.knee || {};
  const shoulderData = patient.data.modules?.shoulder || {};
  const returnConsiderations = kneeData.returnConsiderations || shoulderData.returnConsiderations || '';
  const handleReturnChange = (value) => {
    if (hasKnee) {
      updateModuleById('knee', m => ({ ...m, returnConsiderations: value }));
    }
    if (hasShoulder) {
      updateModuleById('shoulder', m => ({ ...m, returnConsiderations: value }));
    }
  };

  const previewText = generateUnifiedReport(patient);

  return (
    <div className="assessment-step-layout">
      <div className="panel pattern-surface assessment-panel">
        {(hasKnee || hasSpine || hasShoulder) && (
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
          저장 또는 내보내기 전에 자동 생성된 통합 문안을 확인하세요.
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

import { getModule } from '../moduleRegistry';
import { AssessmentTab } from '../../modules/knee/components/AssessmentTab';
import { generateUnifiedReport } from '../utils/reportGenerator';

export function AssessmentStep({ patient, activeModules, updateDiagnoses, updateModuleById }) {
  const shared = patient.data.shared;
  const diagnoses = shared.diagnoses || [];

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
    <>
      <div className="panel">
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
      <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
        <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>미리보기</h2>
        <div className="preview-section" style={{ flex: 1 }}>{previewText}</div>
      </div>
    </>
  );
}

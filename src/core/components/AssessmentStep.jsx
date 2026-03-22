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
  const kneeData = patient.data.modules?.knee || {};

  const previewText = generateUnifiedReport(patient);

  return (
    <>
      <div className="panel">
        {(hasKnee || hasSpine) && (
          <AssessmentTab
            diagnoses={diagnoses}
            onDiagnosisUpdate={handleDiagnosisUpdate}
            returnConsiderations={kneeData.returnConsiderations || ''}
            onReturnChange={(value) => updateModuleById('knee', m => ({ ...m, returnConsiderations: value }))}
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

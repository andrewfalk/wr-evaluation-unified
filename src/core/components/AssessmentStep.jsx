import { useState } from 'react';
import { AssessmentTab } from './AssessmentTab';
import { generateUnifiedReport } from '../utils/reportGenerator';
import { generateUnifiedEMR } from '../utils/emrReport';
import { EMR_TEXT_LIMIT_BYTES, cp949ByteLength } from '../utils/emrText';

export function AssessmentStep({ patient, activeModules, updateDiagnoses, updateModuleById, updateShared }) {
  const shared = patient.data.shared;
  const diagnoses = shared.diagnoses || [];
  const [previewTab, setPreviewTab] = useState('report');

  const handleDiagnosisUpdate = (index, field, value) => {
    const updated = [...diagnoses];
    updated[index] = { ...updated[index], [field]: value };
    updateDiagnoses(updated);
  };

  const handleReportOptionsChange = nextReportOptions => {
    updateShared?.({ ...shared, reportOptions: nextReportOptions });
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
  const { b8: emrText } = generateUnifiedEMR(patient);
  const emrBytes = cp949ByteLength(emrText);
  const emrPct = Math.min(140, Math.round((emrBytes / EMR_TEXT_LIMIT_BYTES) * 100));
  const emrStatus = emrPct < 90 ? 'ok' : emrPct <= 100 ? 'warn' : 'danger';
  const emrStatusLabel = emrStatus === 'ok' ? '정상' : emrStatus === 'warn' ? '주의' : '초과';

  return (
    <div className="assessment-step-layout">
      <div className="panel pattern-surface assessment-panel">
        {(hasKnee || hasWrist || hasShoulder || hasElbow || hasCervical || activeModules.includes('spine')) && (
          <AssessmentTab
            diagnoses={diagnoses}
            onDiagnosisUpdate={handleDiagnosisUpdate}
            onDiagnosesReplace={updateDiagnoses}
            returnConsiderations={returnConsiderations}
            onReturnChange={handleReturnChange}
            activeModules={activeModules}
            reportOptions={shared.reportOptions}
            onReportOptionsChange={handleReportOptionsChange}
          />
        )}
      </div>
      <div className="panel pattern-surface assessment-preview-panel">
        <h2 className="section-title"><span className="section-icon">&#x1F4CA;</span>미리보기</h2>
        <p className="preview-caption">
          입력 내용은 오른쪽 미리보기 패널에 즉시 반영됩니다.
        </p>
        <div className="report-preview">
          <div className="preview-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === 'report'}
              className={previewTab === 'report' ? 'active' : ''}
              onClick={() => setPreviewTab('report')}
            >
              통합 리포트 초안
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === 'emr'}
              className={previewTab === 'emr' ? 'active' : ''}
              onClick={() => setPreviewTab('emr')}
            >
              EMR 종합소견(6번)
            </button>
          </div>

          {previewTab === 'emr' && (
            <div className="emr-gauge">
              <div className="emr-gauge-top">
                <span className="emr-gauge-label">EMR 6번 종합소견</span>
                <span className="emr-gauge-value">
                  {emrBytes.toLocaleString()} / {EMR_TEXT_LIMIT_BYTES.toLocaleString()} byte
                  <span className={`emr-gauge-status emr-gauge-status-${emrStatus}`}>
                    {emrStatusLabel}{emrStatus === 'danger' ? ` · ${(emrBytes - EMR_TEXT_LIMIT_BYTES).toLocaleString()} byte 초과` : ''}
                  </span>
                </span>
              </div>
              <div className="emr-gauge-bar">
                <div className={`emr-gauge-fill emr-gauge-fill-${emrStatus}`} style={{ width: `${Math.min(100, emrPct)}%` }} />
              </div>
            </div>
          )}

          <div className="report-preview-toolbar">
            <span className="report-preview-label">{previewTab === 'report' ? '통합 리포트 초안' : 'EMR 종합소견(6번)'}</span>
            <span className="report-preview-hint">상병 {diagnoses.length}건 기준 자동 생성</span>
          </div>
          <div className="preview-section">{previewTab === 'report' ? previewText : emrText}</div>
        </div>
      </div>
    </div>
  );
}

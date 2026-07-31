import { useEffect, useState } from 'react';
import { AssessmentTab } from './AssessmentTab';
import { generateUnifiedEMR } from '../utils/emrReport';
import { EMR_TEXT_LIMIT_BYTES, cp949ByteLength, classifyEmrByteStatus } from '../utils/emrText';

const EMR_STATUS_LABELS = { ok: '정상', warn: '주의', danger: '초과' };

function emrGaugeInfo(text) {
  const bytes = cp949ByteLength(text);
  const pct = Math.min(140, Math.round((bytes / EMR_TEXT_LIMIT_BYTES) * 100));
  const status = classifyEmrByteStatus(bytes, EMR_TEXT_LIMIT_BYTES);
  return { bytes, pct, status, statusLabel: EMR_STATUS_LABELS[status] };
}

export function AssessmentStep({ patient, activeModules, updateDiagnoses, updateModuleById, updateShared }) {
  const shared = patient.data.shared;
  const diagnoses = shared.diagnoses || [];
  const groupOutput = !!shared.reportOptions?.groupAssessmentResults;
  const [previewTab, setPreviewTab] = useState(groupOutput ? 'group' : 'individual');

  // 패턴 그룹/개별 카드 토글이 바뀔 때마다 미리보기 탭도 함께 따라간다 — 토글을
  // 그대로 둔 채 사용자가 수동으로 다른 탭을 눌러 비교하는 것은 계속 허용한다.
  useEffect(() => {
    setPreviewTab(groupOutput ? 'group' : 'individual');
  }, [groupOutput]);

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

  // 그룹/개별 두 형식을 항상 같이 계산해 둔다 — 저장된 토글 값과 무관하게 두 탭을
  // 각각 미리 보여주고, byte 게이지도 탭별로 따로 표시하기 위함.
  const { b8: emrTextGroup } = generateUnifiedEMR(patient, true);
  const { b8: emrTextIndividual } = generateUnifiedEMR(patient, false);
  const gaugeGroup = emrGaugeInfo(emrTextGroup);
  const gaugeIndividual = emrGaugeInfo(emrTextIndividual);
  const emrText = previewTab === 'group' ? emrTextGroup : emrTextIndividual;
  const gauge = previewTab === 'group' ? gaugeGroup : gaugeIndividual;
  const previewLabel = previewTab === 'group' ? '종합소견(그룹)' : '종합소견(개별)';

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
              aria-selected={previewTab === 'group'}
              className={previewTab === 'group' ? 'active' : ''}
              onClick={() => setPreviewTab('group')}
            >
              종합소견(그룹)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === 'individual'}
              className={previewTab === 'individual' ? 'active' : ''}
              onClick={() => setPreviewTab('individual')}
            >
              종합소견(개별)
            </button>
          </div>

          <div className="emr-gauge">
            <div className="emr-gauge-top">
              <span className="emr-gauge-label">{previewLabel}</span>
              <span className="emr-gauge-value">
                {gauge.bytes.toLocaleString()} / {EMR_TEXT_LIMIT_BYTES.toLocaleString()} byte
                <span className={`emr-gauge-status emr-gauge-status-${gauge.status}`}>
                  {gauge.statusLabel}{gauge.status === 'danger' ? ` · ${(gauge.bytes - EMR_TEXT_LIMIT_BYTES).toLocaleString()} byte 초과` : ''}
                </span>
              </span>
            </div>
            <div className="emr-gauge-bar">
              <div className={`emr-gauge-fill emr-gauge-fill-${gauge.status}`} style={{ width: `${Math.min(100, gauge.pct)}%` }} />
            </div>
          </div>

          <div className="report-preview-toolbar">
            <span className="report-preview-label">{previewLabel}</span>
            <span className="report-preview-hint">상병 {diagnoses.length}건 기준 자동 생성</span>
          </div>
          <div className="preview-section">{emrText}</div>
        </div>
      </div>
    </div>
  );
}

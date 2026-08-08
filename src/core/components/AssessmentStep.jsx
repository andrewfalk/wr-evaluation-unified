import { useEffect, useMemo, useState } from 'react';
import { AssessmentTab } from './AssessmentTab';
import { generateUnifiedEMR, resolveAssessment } from '../utils/emrReport';
import { EMR_TEXT_LIMIT_BYTES, cp949ByteLength, classifyEmrByteStatus } from '../utils/emrText';
import { selectModuleNote } from '../utils/moduleNotes';
import { showConfirm } from '../utils/platform';

const EMR_STATUS_LABELS = { ok: '정상', warn: '주의', danger: '초과' };

function emrGaugeInfo(text) {
  const bytes = cp949ByteLength(text);
  const pct = Math.min(140, Math.round((bytes / EMR_TEXT_LIMIT_BYTES) * 100));
  const status = classifyEmrByteStatus(bytes, EMR_TEXT_LIMIT_BYTES);
  return { bytes, pct, status, statusLabel: EMR_STATUS_LABELS[status] };
}

// reportOptions에서 assessmentOverride만 제거 — undefined 대입이 아니라 키 자체를
// 지운다("자동 생성으로 되돌리기"는 오버라이드가 아예 없던 상태와 동일해야 한다).
function withoutAssessmentOverride(reportOptions) {
  const { assessmentOverride: _drop, ...rest } = reportOptions || {};
  return rest;
}

export function AssessmentStep({ patient, activeModules, updateDiagnoses, updateModuleById, updateShared, canMutate = true, onEditingChange }) {
  const shared = patient.data.shared;
  const diagnoses = shared.diagnoses || [];
  const groupOutput = !!shared.reportOptions?.groupAssessmentResults;
  const savedOverride = shared.reportOptions?.assessmentOverride;

  // 비교 탭(오버라이드 없음일 때 그룹/개별)과 편집본 비교 탭(오버라이드 있을 때
  // 편집본/현재 자동 생성본)은 서로 다른 상태로 분리한다 — 의미가 다르다.
  const [previewTab, setPreviewTab] = useState(groupOutput ? 'group' : 'individual');
  const [overrideViewTab, setOverrideViewTab] = useState('saved');

  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftBaseText, setDraftBaseText] = useState('');

  // 패턴 그룹/개별 카드 토글이 바뀔 때마다 미리보기 탭도 함께 따라간다 — 토글을
  // 그대로 둔 채 사용자가 수동으로 다른 탭을 눌러 비교하는 것은 계속 허용한다.
  useEffect(() => {
    setPreviewTab(groupOutput ? 'group' : 'individual');
  }, [groupOutput]);

  // 편집 모드 진입/종료(=dirty 여부)를 상위(App.jsx)에 알린다 — 환자 전환·홈 이동·
  // 내보내기·EMR 전송·앱 종료 가드가 이 신호로 미저장 draft를 보호한다.
  useEffect(() => {
    onEditingChange?.(patient.id, editing);
  }, [editing, patient.id, onEditingChange]);

  const handleDiagnosisUpdate = (index, field, value) => {
    const updated = [...diagnoses];
    updated[index] = { ...updated[index], [field]: value };
    updateDiagnoses(updated);
  };

  const handleReportOptionsChange = nextReportOptions => {
    updateShared?.(prevShared => ({ ...prevShared, reportOptions: nextReportOptions }));
  };

  // 메모는 활성 모듈 전체에 같은 값을 팬아웃 저장한다(모듈 하나만 붙잡지 않으므로
  // 향후 모듈 추가 시에도 이 컴포넌트를 손댈 필요가 없다). 읽기는 selectModuleNote가
  // 우선순위를 결정한다.
  const returnConsiderations = selectModuleNote(patient.data.modules, activeModules);

  const handleReturnChange = (value) => {
    activeModules.forEach(id =>
      updateModuleById(id, current => ({ ...current, returnConsiderations: value }))
    );
  };

  // 그룹/개별 두 형식을 항상 같이 계산해 둔다 — 저장된 토글 값과 무관하게 두 탭을
  // 각각 미리 보여주고, byte 게이지도 탭별로 따로 표시하기 위함. patient 참조가 바뀔
  // 때만(=실제 데이터 변경 시에만) 재계산 — 편집/탭 상태 변경만으로는 6개 모듈 계산
  // 트리를 다시 돌리지 않는다.
  const { emrTextGroup, emrTextIndividual } = useMemo(() => ({
    emrTextGroup: generateUnifiedEMR(patient, true).b8,
    emrTextIndividual: generateUnifiedEMR(patient, false).b8,
  }), [patient]);

  // 전송 형식(저장된 reportOptions.groupAssessmentResults 기준) 생성본 — 오버라이드
  // 검증·낡음 판정·편집 진입 시 캡처가 전부 이 값을 기준으로 한다.
  const sendFormatGeneratedB8 = groupOutput ? emrTextGroup : emrTextIndividual;
  const effective = useMemo(
    () => resolveAssessment(patient, sendFormatGeneratedB8),
    [patient, sendFormatGeneratedB8]
  );

  const mode = editing ? 'editing' : effective.hasInvalidOverride ? 'invalid' : effective.isOverride ? 'override' : 'compare';
  const formatLabel = groupOutput ? '종합소견(그룹)' : '종합소견(개별)';
  const lockLostWhileEditing = editing && !canMutate;

  const bodyText = mode === 'editing'
    ? draftText
    : mode === 'override'
      ? (overrideViewTab === 'saved' ? effective.text : sendFormatGeneratedB8)
      : sendFormatGeneratedB8; // invalid | compare(단, compare는 아래에서 탭별로 다시 계산)
  const compareText = previewTab === 'group' ? emrTextGroup : emrTextIndividual;
  const previewText = mode === 'compare' ? compareText : bodyText;
  const gauge = emrGaugeInfo(previewText);

  const previewLabel = mode === 'editing' ? `${formatLabel} · 편집 중`
    : mode === 'override' ? `${formatLabel} · ${overrideViewTab === 'saved' ? '편집본(전송됨)' : '현재 자동 생성본'}`
    : mode === 'invalid' ? `${formatLabel} · 자동 생성본(임시)`
    : (previewTab === 'group' ? '종합소견(그룹)' : '종합소견(개별)');

  const handleEnterEdit = () => {
    if (!canMutate) return;
    // 편집은 항상 저장된 전송 형식 기준으로 시작 — 비교 탭을 보고 있었어도 전송 형식
    // 탭으로 자동 이동.
    setPreviewTab(groupOutput ? 'group' : 'individual');
    if (effective.isOverride) {
      // 재편집 — baseText는 저장된 값 그대로 유지(재캡처 금지, 낡음 표시가 조용히 사라지면 안 됨).
      setDraftText(effective.text);
      setDraftBaseText(savedOverride?.baseText ?? sendFormatGeneratedB8);
    } else {
      // 신규 편집 — 현재 자동 생성본으로 캡처.
      setDraftText(sendFormatGeneratedB8);
      setDraftBaseText(sendFormatGeneratedB8);
    }
    setEditing(true);
  };

  const handleSaveEdit = () => {
    if (!canMutate || !draftText.trim()) return;
    updateShared?.(prevShared => ({
      ...prevShared,
      reportOptions: {
        ...prevShared.reportOptions,
        assessmentOverride: { text: draftText, baseText: draftBaseText, updatedAt: new Date().toISOString() },
      },
    }));
    setEditing(false);
    setDraftText('');
    setDraftBaseText('');
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setDraftText('');
    setDraftBaseText('');
  };

  const handleRevertToAuto = async () => {
    if (!canMutate) return;
    const ok = await showConfirm(
      '직접 편집한 종합소견을 삭제하고 자동 생성본으로 되돌립니다.\n'
      + '편집한 문장은 복구할 수 없습니다.\n\n계속하시겠습니까?'
    );
    if (!ok) return;
    updateShared?.(prevShared => ({ ...prevShared, reportOptions: withoutAssessmentOverride(prevShared.reportOptions) }));
  };

  const handleDeleteInvalid = async () => {
    if (!canMutate) return;
    const ok = await showConfirm('손상된 편집 데이터를 삭제하고 자동 생성본으로 되돌립니다.\n\n계속하시겠습니까?');
    if (!ok) return;
    updateShared?.(prevShared => ({ ...prevShared, reportOptions: withoutAssessmentOverride(prevShared.reportOptions) }));
  };

  const handleConfirmLatest = async () => {
    if (!canMutate) return;
    const ok = await showConfirm(
      '편집한 문장(전송 내용)은 그대로 두고, 낡음 표시만 현재 데이터 기준으로 해제합니다.\n\n계속하시겠습니까?'
    );
    if (!ok) return;
    updateShared?.(prevShared => ({
      ...prevShared,
      reportOptions: {
        ...prevShared.reportOptions,
        assessmentOverride: { ...prevShared.reportOptions.assessmentOverride, baseText: sendFormatGeneratedB8 },
      },
    }));
  };

  return (
    <div className="assessment-step-layout">
      <div className="panel pattern-surface assessment-panel">
        {activeModules.length > 0 && (
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
          {mode === 'compare' && (
            <div className="preview-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={previewTab === 'group'}
                className={previewTab === 'group' ? 'active' : ''}
                onClick={() => setPreviewTab('group')}
              >
                종합소견(그룹){groupOutput && <span className="report-preview-format-badge">전송 형식</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={previewTab === 'individual'}
                className={previewTab === 'individual' ? 'active' : ''}
                onClick={() => setPreviewTab('individual')}
              >
                종합소견(개별){!groupOutput && <span className="report-preview-format-badge">전송 형식</span>}
              </button>
            </div>
          )}

          {mode === 'override' && (
            <div className="preview-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={overrideViewTab === 'saved'}
                className={overrideViewTab === 'saved' ? 'active' : ''}
                onClick={() => setOverrideViewTab('saved')}
              >
                편집본<span className="report-preview-format-badge">전송 형식</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={overrideViewTab === 'current'}
                className={overrideViewTab === 'current' ? 'active' : ''}
                onClick={() => setOverrideViewTab('current')}
              >
                현재 자동 생성본
              </button>
            </div>
          )}

          {mode === 'invalid' && (
            <div className="assessment-override-banner assessment-override-banner-danger">
              ⚠ 저장된 직접 편집 데이터가 손상되어 자동 생성본을 대신 표시합니다. EMR 전송·환자 데이터 내보내기는 삭제 전까지 차단됩니다.
              <button type="button" className="btn btn-danger btn-sm" onClick={handleDeleteInvalid} disabled={!canMutate}>
                깨진 편집 데이터 삭제
              </button>
            </div>
          )}

          {mode === 'override' && effective.isStale && (
            <div className="assessment-override-banner">
              ⚠ 편집 이후 상병·직업·평가 데이터가 변경되어 편집본이 낡았을 수 있습니다. 전송 내용은 편집 시점 그대로 유지됩니다.
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleConfirmLatest} disabled={!canMutate}>
                최신 반영 확인
              </button>
            </div>
          )}

          {editing && !lockLostWhileEditing && (
            <div className="assessment-override-banner">
              ✏ 직접 편집 중입니다. 저장하기 전까지 EMR 전송·환자 데이터 내보내기가 차단됩니다.
            </div>
          )}

          {lockLostWhileEditing && (
            <div className="assessment-override-banner assessment-override-banner-danger">
              ⚠ 환자 편집 권한을 상실했습니다. 편집 내용은 화면에 남아있지만 저장할 수 없습니다 — [취소]로 draft를 폐기한 뒤 잠금을 다시 획득하세요.
            </div>
          )}

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
            {mode === 'compare' && <span className="report-preview-hint">상병 {diagnoses.length}건 기준 자동 생성</span>}
            <div className="assessment-edit-toolbar">
              {!editing && mode !== 'invalid' && (
                <button type="button" className="btn btn-primary btn-sm" onClick={handleEnterEdit} disabled={!canMutate}>
                  ✏ 직접 편집
                </button>
              )}
              {!editing && mode === 'override' && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleRevertToAuto} disabled={!canMutate}>
                  자동 생성으로 되돌리기
                </button>
              )}
              {editing && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleSaveEdit}
                    disabled={!canMutate || !draftText.trim()}
                  >
                    ✓ 편집 완료
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    data-readonly-allow
                    onClick={handleCancelEdit}
                  >
                    취소
                  </button>
                </>
              )}
            </div>
          </div>
          {editing ? (
            <>
              <textarea
                className="preview-textarea"
                value={draftText}
                onChange={e => setDraftText(e.target.value)}
                readOnly={!canMutate}
                aria-label="종합소견 직접 편집"
              />
              {!draftText.trim() && <p className="form-hint assessment-override-hint">공백만으로는 저장할 수 없습니다.</p>}
            </>
          ) : (
            <div className="preview-section">{previewText}</div>
          )}
        </div>
      </div>
    </div>
  );
}

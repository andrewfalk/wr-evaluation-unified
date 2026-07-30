import { useCallback, useEffect, useMemo, useState } from 'react';
import { KLG_OPTIONS, LOW_REASON_OPTIONS } from '../../modules/knee/utils/data';
import { getSideText } from '../../modules/knee/utils/calculations';
import { resolveDiagnosisModule, supportsKlGrade, supportsEllmanClass } from '../utils/diagnosisMapping';
import { normalizeSpineAssessmentFields } from '../utils/spineAssessmentMigration';
import { buildAssessmentUnits } from '../utils/assessmentGroups';
import { AssessmentGroupView } from './AssessmentGroupView';
import { AssessmentIndividualFields } from './AssessmentIndividualFields';

export const ELLMAN_OPTIONS = [
  { value: '', label: '선택' },
  { value: 'N/A', label: '해당없음' },
  { value: 'Grade 1', label: 'Grade 1' },
  { value: 'Grade 2', label: 'Grade 2' },
  { value: 'Grade 3', label: 'Grade 3' },
  { value: 'Full', label: 'Full' },
];

function SideAssessment({ diag, index, side, onUpdate, label }) {
  const isRight = side === 'right';
  const color = label ? 'var(--primary)' : (isRight ? 'var(--color-right)' : 'var(--color-left)');
  const displayLabel = label || (isRight ? '우측' : '좌측');
  const confirmedKey = isRight ? 'confirmedRight' : 'confirmedLeft';
  const assessmentKey = isRight ? 'assessmentRight' : 'assessmentLeft';
  const reasonKey = isRight ? 'reasonRight' : 'reasonLeft';
  const reasonOtherKey = isRight ? 'reasonRightOther' : 'reasonLeftOther';

  return (
    <div className="assessment-side-card">
      <h4 className="assessment-side-title" style={{ color }}>&#9654; {displayLabel}</h4>
      <div className="form-row">
        <div className="form-group">
          <label>상병 상태</label>
          <select value={diag[confirmedKey]} onChange={e => onUpdate(index, confirmedKey, e.target.value)}>
            <option value="">선택</option>
            <option value="confirmed">확인</option>
            <option value="unconfirmed">미확인</option>
          </select>
        </div>
        <div className="form-group">
          <label>업무관련성</label>
          <select value={diag[assessmentKey]} onChange={e => onUpdate(index, assessmentKey, e.target.value)}>
            <option value="">선택</option>
            <option value="high">높음</option>
            <option value="low">낮음</option>
          </select>
        </div>
      </div>
      {diag[assessmentKey] === 'low' && (
        <div className="form-group">
          <label>업무관련성 낮음 사유</label>
          <div className="assessment-reason-list">
            {LOW_REASON_OPTIONS.map(option => (
              <label key={option.value} className="assessment-reason-option">
                <input
                  type="checkbox"
                  checked={(diag[reasonKey] || []).includes(option.value)}
                  onChange={() => {
                    const current = diag[reasonKey] || [];
                    const next = current.includes(option.value)
                      ? current.filter(value => value !== option.value)
                      : [...current, option.value];
                    onUpdate(index, reasonKey, next);
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
          {(diag[reasonKey] || []).includes('other') && (
            <textarea
              className="assessment-reason-other"
              value={diag[reasonOtherKey]}
              onChange={e => {
                onUpdate(index, reasonOtherKey, e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onFocus={e => {
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              rows={1}
              placeholder="기타 사유"
            />
          )}
        </div>
      )}
    </div>
  );
}

export function AssessmentTab({
  diagnoses, onDiagnosisUpdate, onDiagnosesReplace, returnConsiderations, onReturnChange, activeModules,
  reportOptions, onReportOptionsChange,
}) {
  const hasKnee = (activeModules || []).includes('knee');
  const hasWrist = (activeModules || []).includes('wrist');
  const hasShoulder = (activeModules || []).includes('shoulder');
  const hasElbow = (activeModules || []).includes('elbow');
  const hasCervical = (activeModules || []).includes('cervical');

  const [view, setView] = useState('card');
  const [pendingScrollId, setPendingScrollId] = useState(null);
  const groupOutput = !!reportOptions?.groupAssessmentResults;
  const unitCount = useMemo(() => buildAssessmentUnits(diagnoses, activeModules).length, [diagnoses, activeModules]);

  const handleJumpToDiagnosis = useCallback(diagId => {
    setView('card');
    setPendingScrollId(diagId);
  }, []);

  useEffect(() => {
    if (view !== 'card' || !pendingScrollId) return;
    const el = document.getElementById(`assessment-diag-${pendingScrollId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('assessment-card-flash');
      setTimeout(() => el.classList.remove('assessment-card-flash'), 1600);
    }
    setPendingScrollId(null);
  }, [view, pendingScrollId]);

  // 수직분포/동반 척추증: spine 진단 중 첫 번째에만 표시 + 기존 데이터 통합 마이그레이션
  const isSpineDiagnosis = useCallback(
    diag => resolveDiagnosisModule(diag, activeModules)?.moduleId === 'spine',
    [activeModules]
  );
  const firstSpineIndex = useMemo(
    () => diagnoses.findIndex(isSpineDiagnosis),
    [diagnoses, isSpineDiagnosis]
  );
  useEffect(() => {
    if (!onDiagnosesReplace) return;
    const next = normalizeSpineAssessmentFields(diagnoses, isSpineDiagnosis);
    if (next !== diagnoses) onDiagnosesReplace(next);
  }, [diagnoses, isSpineDiagnosis, onDiagnosesReplace]);

  return (
    <section className="section pattern-surface form-section">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CB;</span>종합평가</h2>
          <p className="section-description">상병별 확인 상태와 업무관련성을 정리하고 복귀 관련 고려사항을 기록합니다.</p>
        </div>
      </div>

      {diagnoses.length > 0 && (
        <div className="assessment-output-toggle">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={groupOutput}
              onChange={e => onReportOptionsChange?.({ ...reportOptions, groupAssessmentResults: e.target.checked })}
            />
            패턴 그룹 사용 — 미리보기·내보내기 포함
          </label>
          <div className="assessment-view-toggle" role="group" aria-label="보기 전환">
            <button type="button" className={view === 'group' ? 'active' : ''} onClick={() => setView('group')}>패턴 그룹</button>
            <button type="button" className={view === 'card' ? 'active' : ''} onClick={() => setView('card')}>개별 카드</button>
          </div>
        </div>
      )}
      {view === 'card' && unitCount >= 10 && (
        <div className="assessment-view-hint">
          평가단위가 {unitCount}개입니다.{' '}
          <button type="button" className="assessment-view-hint-link" onClick={() => setView('group')}>패턴 그룹 보기로 전환</button>
          하면 같은 패턴을 한 번에 입력할 수 있습니다.
        </div>
      )}

      {view === 'group' && (
        <>
          <AssessmentIndividualFields
            diagnoses={diagnoses}
            activeModules={activeModules}
            onDiagnosisUpdate={onDiagnosisUpdate}
            onJumpToDiagnosis={handleJumpToDiagnosis}
          />
          <AssessmentGroupView
            diagnoses={diagnoses}
            activeModules={activeModules}
            onDiagnosesReplace={onDiagnosesReplace}
            onJumpToDiagnosis={handleJumpToDiagnosis}
          />
        </>
      )}

      {view === 'card' && diagnoses.map((diag, index) => {
        const resolvedModule = resolveDiagnosisModule(diag, activeModules);
        const isSpine = resolvedModule?.moduleId === 'spine';
        const isCervical = resolvedModule?.moduleId === 'cervical';
        const isAxial = isSpine || isCervical;
        const isShoulder = resolvedModule?.moduleId === 'shoulder';
        const isKnee = resolvedModule?.moduleId === 'knee';
        const isWrist = resolvedModule?.moduleId === 'wrist';
        const isElbow = resolvedModule?.moduleId === 'elbow';

        return (
          <div key={diag.id} id={`assessment-diag-${diag.id}`} className="assessment-card">
            <div className="assessment-card-header">
              <div className="assessment-card-header-top">
                <div className="assessment-card-title">상병 #{index + 1}: {diag.code} {diag.name}</div>

                {!isAxial && isShoulder && diag.side && supportsEllmanClass(diag) && (
                  <div className="klg-inline">
                    <span className="klg-inline-label">Ellman Class</span>
                    {(diag.side === 'right' || diag.side === 'both') && (
                      <select value={diag.ellmanRight || ''} onChange={e => onDiagnosisUpdate(index, 'ellmanRight', e.target.value)}>
                        {ELLMAN_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    )}
                    {(diag.side === 'left' || diag.side === 'both') && (
                      <select value={diag.ellmanLeft || ''} onChange={e => onDiagnosisUpdate(index, 'ellmanLeft', e.target.value)}>
                        {ELLMAN_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    )}
                  </div>
                )}

                {!isAxial && isKnee && diag.side && supportsKlGrade(diag) && (
                  <div className="klg-inline">
                    <span className="klg-inline-label">K-L Grade</span>
                    {(diag.side === 'right' || diag.side === 'both') && (
                      <label className="klg-side-row">
                        {diag.side === 'both' && <span className="klg-side-label">우</span>}
                        <select value={diag.klgRight || ''} onChange={e => onDiagnosisUpdate(index, 'klgRight', e.target.value)}>
                          {KLG_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                    )}
                    {(diag.side === 'left' || diag.side === 'both') && (
                      <label className="klg-side-row">
                        {diag.side === 'both' && <span className="klg-side-label">좌</span>}
                        <select value={diag.klgLeft || ''} onChange={e => onDiagnosisUpdate(index, 'klgLeft', e.target.value)}>
                          {KLG_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                )}

                {!isAxial && isWrist && <span className="diagnosis-module-badge">손목/손가락</span>}
                {!isAxial && isElbow && <span className="diagnosis-module-badge">팔꿈치</span>}
                {isCervical && <span className="diagnosis-module-badge">경추(목)</span>}
              </div>
              {!isAxial && <div className="assessment-card-subtitle">방향: {getSideText(diag.side)}</div>}
            </div>

            {!isAxial && (diag.side === 'right' || diag.side === 'both') && (
              <SideAssessment diag={diag} index={index} side="right" onUpdate={onDiagnosisUpdate} />
            )}
            {!isAxial && (diag.side === 'left' || diag.side === 'both') && (
              <SideAssessment diag={diag} index={index} side="left" onUpdate={onDiagnosisUpdate} />
            )}
            {!isAxial && !diag.side && (
              <div className="evaluation-empty-state assessment-side-empty">요청 상병에서 방향 선택이 필요합니다.</div>
            )}

            {isSpine && (
              <>
                {index === firstSpineIndex && (
                  <div className="klg-inline" style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: '12px', marginTop: 4 }}>
                    <span className="klg-inline-label">수직분포 원리</span>
                    <select value={diag.verticalDistribution || ''} onChange={e => onDiagnosisUpdate(index, 'verticalDistribution', e.target.value)}>
                      <option value="">선택</option>
                      <option value="confirmed">확인</option>
                      <option value="unconfirmed">미확인</option>
                    </select>
                    <span className="klg-inline-label">동반 척추증</span>
                    <select value={diag.concomitantSpondylosis || ''} onChange={e => onDiagnosisUpdate(index, 'concomitantSpondylosis', e.target.value)}>
                      <option value="">선택</option>
                      <option value="confirmed">확인</option>
                      <option value="unconfirmed">미확인</option>
                    </select>
                  </div>
                )}
                <SideAssessment diag={diag} index={index} side="right" onUpdate={onDiagnosisUpdate} label="평가" />
              </>
            )}

            {isCervical && (
              <SideAssessment diag={diag} index={index} side="right" onUpdate={onDiagnosisUpdate} label="평가" />
            )}
          </div>
        );
      })}

      {(hasKnee || hasWrist || hasShoulder || hasElbow || hasCervical) && (
        <section className="assessment-return-section">
          <div className="section-header">
            <div className="section-title-row">
              <h2 className="section-title"><span className="section-icon">&#x1F4BC;</span>복귀 고려사항</h2>
              <p className="section-description">업무 복귀 시 필요한 제한이나 주의사항을 기록합니다.</p>
            </div>
          </div>
          <textarea
            rows="3"
            className="assessment-return-textarea"
            value={returnConsiderations}
            onChange={e => onReturnChange(e.target.value)}
            placeholder="업무 복귀 시 고려사항..."
          />
        </section>
      )}
    </section>
  );
}

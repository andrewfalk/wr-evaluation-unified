import { KLG_OPTIONS, LOW_REASON_OPTIONS } from '../../modules/knee/utils/data';
import { getSideText } from '../../modules/knee/utils/calculations';
import { resolveDiagnosisModule } from '../utils/diagnosisMapping';

const ELLMAN_OPTIONS = [
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

export function AssessmentTab({ diagnoses, onDiagnosisUpdate, returnConsiderations, onReturnChange, activeModules }) {
  const hasKnee = (activeModules || []).includes('knee');
  const hasWrist = (activeModules || []).includes('wrist');
  const hasShoulder = (activeModules || []).includes('shoulder');
  const hasElbow = (activeModules || []).includes('elbow');

  return (
    <section className="section pattern-surface form-section">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CB;</span>종합평가</h2>
          <p className="section-description">상병별 확인 상태와 업무관련성을 정리하고 복귀 관련 고려사항을 기록합니다.</p>
        </div>
      </div>

      {diagnoses.map((diag, index) => {
        const resolvedModule = resolveDiagnosisModule(diag, activeModules);
        const isSpine = resolvedModule?.moduleId === 'spine';
        const isShoulder = resolvedModule?.moduleId === 'shoulder';
        const isKnee = resolvedModule?.moduleId === 'knee';
        const isWrist = resolvedModule?.moduleId === 'wrist';
        const isElbow = resolvedModule?.moduleId === 'elbow';

        return (
          <div key={diag.id} className="assessment-card">
            <div className="assessment-card-header">
              <div className="assessment-card-header-top">
                <div className="assessment-card-title">상병 #{index + 1}: {diag.code} {diag.name}</div>

                {!isSpine && isShoulder && diag.side && (
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

                {!isSpine && isKnee && diag.side && (
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

                {!isSpine && isWrist && <span className="diagnosis-module-badge">손목/손가락</span>}
                {!isSpine && isElbow && <span className="diagnosis-module-badge">팔꿈치</span>}
              </div>
              {!isSpine && <div className="assessment-card-subtitle">방향: {getSideText(diag.side)}</div>}
            </div>

            {!isSpine && (diag.side === 'right' || diag.side === 'both') && (
              <SideAssessment diag={diag} index={index} side="right" onUpdate={onDiagnosisUpdate} />
            )}
            {!isSpine && (diag.side === 'left' || diag.side === 'both') && (
              <SideAssessment diag={diag} index={index} side="left" onUpdate={onDiagnosisUpdate} />
            )}
            {!isSpine && !diag.side && (
              <div className="evaluation-empty-state assessment-side-empty">요청 상병에서 방향 선택이 필요합니다.</div>
            )}

            {isSpine && (
              <>
                <div className="klg-inline" style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: '12px', marginTop: 4 }}>
                  <span className="klg-inline-label">수직분포 정리</span>
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
                <SideAssessment diag={diag} index={index} side="right" onUpdate={onDiagnosisUpdate} label="평가" />
              </>
            )}
          </div>
        );
      })}

      {(hasKnee || hasWrist || hasShoulder || hasElbow) && (
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

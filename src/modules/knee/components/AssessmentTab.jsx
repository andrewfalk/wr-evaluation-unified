import { KLG_OPTIONS, LOW_REASON_OPTIONS } from '../utils/data';
import { getSideText } from '../utils/calculations';
import { resolveDiagnosisModule } from '../../../core/utils/diagnosisMapping';

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
          <label>업무관련성 평가 낮음 사유</label>
          <div className="assessment-reason-list">
            {LOW_REASON_OPTIONS.map(opt => (
              <label key={opt.value} className="assessment-reason-option">
                <input
                  type="checkbox"
                  checked={(diag[reasonKey] || []).includes(opt.value)}
                  onChange={() => {
                    const current = diag[reasonKey] || [];
                    const next = current.includes(opt.value) ? current.filter(v => v !== opt.value) : [...current, opt.value];
                    onUpdate(index, reasonKey, next);
                  }}
                />
                {opt.label}
              </label>
            ))}
          </div>
          {(diag[reasonKey] || []).includes('other') && (
            <input className="assessment-reason-other" value={diag[reasonOtherKey]} onChange={e => onUpdate(index, reasonOtherKey, e.target.value)} placeholder="기타 사유" />
          )}
        </div>
      )}
    </div>
  );
}

export function AssessmentTab({ diagnoses, onDiagnosisUpdate, returnConsiderations, onReturnChange, activeModules }) {
  const hasKnee = (activeModules || []).includes('knee');
  const hasShoulder = (activeModules || []).includes('shoulder');

  return (
    <section className="section pattern-surface form-section">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4CB;</span>종합소견</h2>
          <p className="section-description">상병별 확인 상태와 업무관련성 평가를 정리하고, 복귀 시 고려사항을 함께 기록합니다.</p>
        </div>
      </div>
      {diagnoses.map((diag, i) => {
        const resolvedModule = resolveDiagnosisModule(diag, activeModules);
        const isSpine = resolvedModule?.moduleId === 'spine';
        const isShoulder = resolvedModule?.moduleId === 'shoulder';

        return (
          <div key={diag.id} className="assessment-card">
            <div className="assessment-card-header">
              <div className="assessment-card-header-top">
                <div className="assessment-card-title">상병 #{i + 1}: {diag.code} {diag.name}</div>
                {!isSpine && isShoulder && diag.side && (
                  <div className="klg-inline">
                    <span className="klg-inline-label">Ellman Class</span>
                    {(diag.side === 'right' || diag.side === 'both') && (
                      <select value={diag.ellmanRight || ''} onChange={e => onDiagnosisUpdate(i, 'ellmanRight', e.target.value)}>
                        {ELLMAN_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    )}
                    {(diag.side === 'left' || diag.side === 'both') && (
                      <select value={diag.ellmanLeft || ''} onChange={e => onDiagnosisUpdate(i, 'ellmanLeft', e.target.value)}>
                        {ELLMAN_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    )}
                  </div>
                )}
                {!isSpine && !isShoulder && diag.side && (
                  <div className="klg-inline">
                    <span className="klg-inline-label">K-L Grade</span>
                    {(diag.side === 'right' || diag.side === 'both') && (
                      <select value={diag.klgRight} onChange={e => onDiagnosisUpdate(i, 'klgRight', e.target.value)}>
                        {KLG_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    )}
                    {(diag.side === 'left' || diag.side === 'both') && (
                      <select value={diag.klgLeft} onChange={e => onDiagnosisUpdate(i, 'klgLeft', e.target.value)}>
                        {KLG_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    )}
                  </div>
                )}
              </div>
              {!isSpine && <div className="assessment-card-subtitle">방향: {getSideText(diag.side)}</div>}
            </div>

            {/* 무릎: 좌/우별 SideAssessment */}
            {!isSpine && (diag.side === 'right' || diag.side === 'both') && (
              <SideAssessment diag={diag} index={i} side="right" onUpdate={onDiagnosisUpdate} />
            )}
            {!isSpine && (diag.side === 'left' || diag.side === 'both') && (
              <SideAssessment diag={diag} index={i} side="left" onUpdate={onDiagnosisUpdate} />
            )}
            {!isSpine && !diag.side && <div className="evaluation-empty-state assessment-side-empty">신청상병에서 방향 선택 필요</div>}

            {/* 척추: 단일 상병 상태 + 업무관련성 (좌우 없음) */}
            {isSpine && (
              <SideAssessment diag={diag} index={i} side="right" onUpdate={onDiagnosisUpdate} label="평가" />
            )}
          </div>
        );
      })}
      {(hasKnee || hasShoulder) && (
        <section className="assessment-return-section">
          <div className="section-header">
            <div className="section-title-row">
              <h2 className="section-title"><span className="section-icon">&#x1F4BC;</span>복귀 고려사항</h2>
              <p className="section-description">업무 복귀 시 필요한 제한점이나 유의사항을 정리합니다.</p>
            </div>
          </div>
          <textarea rows="3" className="assessment-return-textarea" value={returnConsiderations} onChange={e => onReturnChange(e.target.value)} placeholder="업무 복귀 시 고려사항..." />
        </section>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { LOW_REASON_OPTIONS } from '../../modules/knee/utils/data';
import { getStatusText } from '../../modules/knee/utils/calculations';
import { assessmentLabel } from '../utils/assessmentGroups';

// 그룹(또는 그룹 내 선택 항목)에 상병 상태·업무관련성·낮음 사유를 일괄 입력하는 모달.
// 실제 diagnoses 배열 조작은 부모(AssessmentGroupView)의 onApply가 담당한다 — 이 컴포넌트는
// 순수 폼 상태만 갖는다.
export function AssessmentPatternEditor({ contextLabel, diagCount, unitCount, beforeText, isIncomplete, onCancel, onApply }) {
  const [confirmed, setConfirmed] = useState('');
  const [assessment, setAssessment] = useState('');
  const [reasons, setReasons] = useState([]);
  const [other, setOther] = useState('');

  useEffect(() => {
    const handleKeyDown = e => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const toggleReason = value => {
    setReasons(prev => (prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]));
  };

  const canApply = !!confirmed && !!assessment && (assessment !== 'low' || reasons.length > 0);

  const afterParts = [];
  if (confirmed) afterParts.push(getStatusText(confirmed));
  if (assessment) afterParts.push(assessmentLabel(assessment));
  let afterText = afterParts.length ? afterParts.join(' / ') : '(선택 필요)';
  if (assessment === 'low' && reasons.length) {
    const labels = reasons.map(r => LOW_REASON_OPTIONS.find(o => o.value === r)?.label || r);
    afterText += ` (${labels.join(', ')})`;
  }

  const handleApply = () => {
    if (!canApply) return;
    onApply({ confirmed, assessment, reasons, other });
  };

  return (
    <div className="assessment-editor-overlay" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="assessment-editor" role="dialog" aria-modal="true" aria-label={`그룹 값 ${isIncomplete ? '입력' : '변경'}`}>
        <h3 className="assessment-editor-title">그룹 값 {isIncomplete ? '입력' : '변경'}</h3>
        <div className="assessment-editor-target">
          대상: {contextLabel}<br />
          상병 {diagCount}건 · 평가단위 {unitCount}개
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>상병 상태</label>
            <select value={confirmed} onChange={e => setConfirmed(e.target.value)}>
              <option value="">선택</option>
              <option value="confirmed">확인</option>
              <option value="unconfirmed">미확인</option>
            </select>
          </div>
          <div className="form-group">
            <label>업무관련성</label>
            <select value={assessment} onChange={e => setAssessment(e.target.value)}>
              <option value="">선택</option>
              <option value="high">높음</option>
              <option value="low">낮음</option>
            </select>
          </div>
        </div>

        {assessment === 'low' && (
          <div className="form-group">
            <label>업무관련성 낮음 사유</label>
            <div className="assessment-reason-list">
              {LOW_REASON_OPTIONS.map(option => (
                <label key={option.value} className="assessment-reason-option">
                  <input type="checkbox" checked={reasons.includes(option.value)} onChange={() => toggleReason(option.value)} />
                  {option.label}
                </label>
              ))}
            </div>
            {reasons.includes('other') && (
              <textarea
                className="assessment-reason-other"
                placeholder="기타 사유"
                value={other}
                onChange={e => setOther(e.target.value)}
                rows={1}
              />
            )}
          </div>
        )}

        <div className="assessment-editor-diff">
          <div className="assessment-editor-diff-row"><span className="assessment-editor-diff-key">변경 전</span><span>{beforeText}</span></div>
          <div className="assessment-editor-diff-row"><span className="assessment-editor-diff-key">변경 후</span><b>{afterText}</b></div>
        </div>

        <div className="assessment-editor-footer">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>취소</button>
          <button type="button" className="btn btn-primary" disabled={!canApply} onClick={handleApply}>
            {unitCount}개 평가단위에 {isIncomplete ? '입력' : '적용'}
          </button>
        </div>
      </div>
    </div>
  );
}

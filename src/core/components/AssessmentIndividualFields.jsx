import { KLG_OPTIONS } from '../../modules/knee/utils/data';
import { getSideText } from '../../modules/knee/utils/calculations';
import { resolveDiagnosisModule, supportsKlGrade, supportsEllmanClass } from '../utils/diagnosisMapping';
import { ELLMAN_OPTIONS } from './AssessmentTab';

// 패턴 그룹 뷰에서는 그룹 카드에 K-L Grade·Ellman Class·척추 공통(수직분포 원리/동반
// 척추증)이 보이지 않는다 — 그룹은 상병 상태·업무관련성만 묶기 때문이다. 그렇다고 이
// 필드들을 입력하려고 개별 카드 뷰로 통째로 전환해야 하면 그룹 뷰의 의미가 없어지므로,
// 해당하는 진단만 모아 그룹 뷰에서도 바로 입력할 수 있게 한다.
export function AssessmentIndividualFields({ diagnoses, activeModules, onDiagnosisUpdate, onJumpToDiagnosis }) {
  const rows = [];
  let spineRowAdded = false;

  diagnoses.forEach((diag, index) => {
    const moduleId = resolveDiagnosisModule(diag, activeModules)?.moduleId;
    if (moduleId === 'knee' && diag.side && supportsKlGrade(diag)) {
      rows.push({ type: 'klg', diag, index });
    }
    if (moduleId === 'shoulder' && diag.side && supportsEllmanClass(diag)) {
      rows.push({ type: 'ellman', diag, index });
    }
    if (moduleId === 'spine' && !spineRowAdded) {
      rows.push({ type: 'spine', diag, index });
      spineRowAdded = true;
    }
  });

  if (!rows.length) return null;

  return (
    <div className="assessment-ifield-panel">
      <div className="assessment-ifield-head">
        🔧 개별 입력 항목 — K-L Grade · Ellman Class · 척추 공통 <span className="assessment-ifield-count">({rows.length}건)</span>
      </div>
      <p className="assessment-ifield-sub">
        패턴 그룹은 상병 상태·업무관련성만 묶습니다. 이 항목들은 그룹으로 묶이지 않고 상병별로 개별 입력합니다.
      </p>
      <div className="assessment-ifield-list">
        {rows.map(row => (
          <div className="assessment-ifield-row" key={`${row.type}-${row.diag.id}`}>
            <button type="button" className="assessment-ifield-meta" onClick={() => onJumpToDiagnosis(row.diag.id)}>
              <span className="assessment-ifield-tag">#{row.index + 1}</span>
              <span className="assessment-ifield-name">{row.diag.code} {row.diag.name}</span>
              {row.type !== 'spine' && <span className="assessment-ifield-side">({getSideText(row.diag.side)})</span>}
            </button>

            {row.type === 'klg' && (
              <div className="klg-inline klg-inline-row">
                <span className="klg-inline-label">K-L Grade</span>
                {(row.diag.side === 'right' || row.diag.side === 'both') && (
                  <label className="klg-side-row">
                    {row.diag.side === 'both' && <span className="klg-side-label">우</span>}
                    <select value={row.diag.klgRight || ''} onChange={e => onDiagnosisUpdate(row.index, 'klgRight', e.target.value)}>
                      {KLG_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                )}
                {(row.diag.side === 'left' || row.diag.side === 'both') && (
                  <label className="klg-side-row">
                    {row.diag.side === 'both' && <span className="klg-side-label">좌</span>}
                    <select value={row.diag.klgLeft || ''} onChange={e => onDiagnosisUpdate(row.index, 'klgLeft', e.target.value)}>
                      {KLG_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}

            {row.type === 'ellman' && (
              <div className="klg-inline klg-inline-row">
                <span className="klg-inline-label">Ellman Class</span>
                {(row.diag.side === 'right' || row.diag.side === 'both') && (
                  <select value={row.diag.ellmanRight || ''} onChange={e => onDiagnosisUpdate(row.index, 'ellmanRight', e.target.value)}>
                    {ELLMAN_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                )}
                {(row.diag.side === 'left' || row.diag.side === 'both') && (
                  <select value={row.diag.ellmanLeft || ''} onChange={e => onDiagnosisUpdate(row.index, 'ellmanLeft', e.target.value)}>
                    {ELLMAN_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                )}
              </div>
            )}

            {row.type === 'spine' && (
              <div className="klg-inline klg-inline-row">
                <span className="klg-inline-label">수직분포 원리</span>
                <select value={row.diag.verticalDistribution || ''} onChange={e => onDiagnosisUpdate(row.index, 'verticalDistribution', e.target.value)}>
                  <option value="">선택</option>
                  <option value="confirmed">확인</option>
                  <option value="unconfirmed">미확인</option>
                </select>
                <span className="klg-inline-label">동반 척추증</span>
                <select value={row.diag.concomitantSpondylosis || ''} onChange={e => onDiagnosisUpdate(row.index, 'concomitantSpondylosis', e.target.value)}>
                  <option value="">선택</option>
                  <option value="confirmed">확인</option>
                  <option value="unconfirmed">미확인</option>
                </select>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

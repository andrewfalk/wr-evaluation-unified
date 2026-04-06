import { formulaDB } from '../utils/formulaDB';
import { calculateCompressiveForce } from '../utils/calculations';

export function TaskEditor({ task, gender, onChange }) {
  if (!task) return <div className="evaluation-empty-state">작업을 선택하거나 추가하세요.</div>;

  const update = (field, value) => {
    const updated = { ...task, [field]: value };
    const r = calculateCompressiveForce(updated.posture, updated.weight, updated.correctionFactor);
    updated.force = r ? r.force : 0;
    onChange(updated);
  };

  return (
    <div className="task-editor-stack">
      <section className="task-editor-section">
        <div className="section-header">
          <div className="section-title-row">
            <div className="result-section-title">작업 기본정보</div>
            <p className="section-description">작업명과 기본 입력값을 먼저 설정합니다.</p>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label>작업명</label>
            <input value={task.name} onChange={e => update('name', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>취급 중량 (kg)</label>
            <input type="number" min="0.1" max="100" step="0.1" value={task.weight} onChange={e => update('weight', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="form-group">
            <label>작업 횟수 (회/일)</label>
            <input type="number" min="1" max="10000" value={task.frequency} onChange={e => update('frequency', parseInt(e.target.value) || 0)} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>1회 소요시간</label>
            <input type="number" min="0.1" max="3600" step="0.1" value={task.timeValue} onChange={e => update('timeValue', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="form-group">
            <label>시간 단위</label>
            <select value={task.timeUnit} onChange={e => update('timeUnit', e.target.value)}>
              <option value="sec">초</option>
              <option value="min">분</option>
              <option value="hr">시간</option>
            </select>
          </div>
        </div>
      </section>

      <section className="task-editor-section">
        <div className="section-header">
          <div className="section-title-row">
            <div className="result-section-title">자세 선택 (G1-G11)</div>
            <p className="section-description">자세 그룹별로 해당 작업에 맞는 자세를 선택합니다.</p>
          </div>
        </div>
        <div className="posture-group-stack">
          {[
            { category: 'lifting', label: '들기 (Lifting)', codes: ['G1','G2','G3','G4','G5','G6'] },
            { category: 'carrying', label: '운반 (Carrying)', codes: ['G7','G8','G9'] },
            { category: 'holding', label: '들고 있기 (Holding)', codes: ['G10','G11'] },
          ].map(group => (
            <div key={group.category}>
              <div className="posture-group-title">{group.label}</div>
              <div className="posture-option-grid">
                {group.codes.map(code => {
                  const p = formulaDB[code];
                  const isSelected = task.posture === code;
                  return (
                    <label key={code} className={`posture-option ${isSelected ? 'is-selected' : ''}`}>
                      <input type="radio" name="posture" value={code} checked={isSelected} onChange={() => update('posture', code)} />
                      <div className="posture-option-visual">
                        {p.images.from ? (
                          <>
                            <img src={p.images.from} alt="" />
                            <span className="posture-option-arrow">→</span>
                            <img src={p.images.to} alt="" />
                          </>
                        ) : (
                          <img src={p.images.single} alt="" />
                        )}
                      </div>
                      <span className="posture-option-label"><strong>{code}</strong> {p.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {formulaDB[task.posture]?.applyCorrectionFactor && (
        <section className="task-editor-section">
          <div className="section-header">
            <div className="section-title-row">
              <div className="result-section-title">보정계수</div>
              <p className="section-description">해당 작업 조건에 맞는 보정계수를 선택합니다.</p>
            </div>
          </div>
          <div className="radio-group">
            {[
              { key: 'none', value: 1.0, label: '없음 (기본)' },
              { key: 'F1', value: 1.9, label: 'F1: 한 손 작업 (×1.9)' },
              { key: 'F2', value: 1.9, label: 'F2: 비대칭 작업 (×1.9)' },
              { key: 'F3', value: 1.3, label: 'F3: 몸에서 멀리 - 똑바로~약간 굴곡 (×1.3)' },
              { key: 'F4', value: 1.1, label: 'F4: 몸에서 멀리 - 심한 굴곡 (×1.1)' }
            ].map(opt => (
              <label key={opt.key} className="radio-label">
                <input type="radio" name="correction" value={opt.value} checked={task.correctionFactor === opt.value} onChange={() => update('correctionFactor', opt.value)} />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

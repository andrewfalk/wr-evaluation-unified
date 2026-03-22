import { formulaDB, POSTURE_CODES } from '../utils/formulaDB';
import { calculateCompressiveForce } from '../utils/calculations';

export function TaskEditor({ task, gender, onChange }) {
  if (!task) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>작업을 선택하거나 추가하세요</div>;

  const update = (field, value) => {
    const updated = { ...task, [field]: value };
    const r = calculateCompressiveForce(updated.posture, updated.weight, updated.correctionFactor);
    updated.force = r ? r.force : 0;
    onChange(updated);
  };

  return (
    <div>
      <div className="form-row">
        <div className="form-group" style={{ flex: 2 }}>
          <label>작업명</label>
          <input value={task.name} onChange={e => update('name', e.target.value)} />
        </div>
      </div>

      <div className="section">
        <h3 style={{ fontSize: '0.9rem', marginBottom: 10, color: 'var(--text-primary)' }}>자세 선택 (G1-G11)</h3>
        {[
          { category: 'lifting', label: '들기 (Lifting)', codes: ['G1','G2','G3','G4','G5','G6'] },
          { category: 'carrying', label: '운반 (Carrying)', codes: ['G7','G8','G9'] },
          { category: 'holding', label: '들고 있기 (Holding)', codes: ['G10','G11'] },
        ].map(group => (
          <div key={group.category} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, paddingLeft: 2 }}>{group.label}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6 }}>
              {group.codes.map(code => {
                const p = formulaDB[code];
                const isSelected = task.posture === code;
                return (
                  <label key={code} className="radio-label" style={{
                    fontSize: '0.8rem', padding: 8, flexDirection: 'column', alignItems: 'center', gap: 6,
                    border: isSelected ? '2px solid var(--primary)' : '2px solid transparent',
                    background: isSelected ? 'rgba(102,126,234,0.08)' : undefined,
                    borderRadius: 8, cursor: 'pointer'
                  }}>
                    <input type="radio" name="posture" value={code} checked={isSelected} onChange={() => update('posture', code)} style={{ display: 'none' }} />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 70 }}>
                      {p.images.from ? (
                        <>
                          <img src={p.images.from} alt="" style={{ height: 65, objectFit: 'contain' }} />
                          <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>→</span>
                          <img src={p.images.to} alt="" style={{ height: 65, objectFit: 'contain' }} />
                        </>
                      ) : (
                        <img src={p.images.single} alt="" style={{ height: 78, objectFit: 'contain' }} />
                      )}
                    </div>
                    <span><strong>{code}</strong> {p.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
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

      {formulaDB[task.posture]?.applyCorrectionFactor && (
        <div className="section">
          <label style={{ fontSize: '0.85rem', fontWeight: 500, marginBottom: 6, display: 'block' }}>보정계수</label>
          <div className="radio-group">
            {[
              { key: 'none', value: 1.0, label: '없음 (기본)' },
              { key: 'F1', value: 1.9, label: 'F1: 한 손 작업 (\u00D71.9)' },
              { key: 'F2', value: 1.9, label: 'F2: 비대칭 작업 (\u00D71.9)' },
              { key: 'F3', value: 1.3, label: 'F3: 몸에서 멀리 - 똑바로~약간 굴곡 (\u00D71.3)' },
              { key: 'F4', value: 1.1, label: 'F4: 몸에서 멀리 - 심한 굴곡 (\u00D71.1)' }
            ].map(opt => (
              <label key={opt.key} className="radio-label" style={{ fontSize: '0.8rem' }}>
                <input type="radio" name="correction" value={opt.value} checked={task.correctionFactor === opt.value} onChange={() => update('correctionFactor', opt.value)} />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

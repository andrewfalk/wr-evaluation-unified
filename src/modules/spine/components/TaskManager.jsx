import { formulaDB } from '../utils/formulaDB';

export function TaskManager({ tasks, selectedIndex, onSelect, onAdd, onRemove }) {

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>작업 목록 ({tasks.length})</h3>
        <button className="btn btn-primary btn-sm" onClick={onAdd}>+ 작업 추가</button>
      </div>
      {tasks.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--card-bg)', borderRadius: 8 }}>
          작업을 추가하세요
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tasks.map((task, i) => {
            const formula = formulaDB[task.posture];
            const forceColor = task.force >= 6000 ? 'var(--color-danger)' : task.force >= 2700 ? 'var(--color-warning)' : 'var(--color-safe)';
            return (
              <div
                key={task.id}
                className={`patient-item ${i === selectedIndex ? 'active' : ''}`}
                onClick={() => onSelect(i)}
                style={{ padding: '10px 12px' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{task.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                      {task.posture} ({formula?.name}) | {task.weight}kg | {task.frequency}회/일
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, color: forceColor, fontSize: '0.85rem' }}>{task.force.toLocaleString()} N</span>
                    {tasks.length > 0 && (
                      <button className="btn btn-danger btn-xs" onClick={e => { e.stopPropagation(); onRemove(i); }}>삭제</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

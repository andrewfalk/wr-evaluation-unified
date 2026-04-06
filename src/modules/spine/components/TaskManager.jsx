import { formulaDB } from '../utils/formulaDB';

export function TaskManager({ tasks, selectedIndex, onSelect, onAdd, onRemove }) {
  return (
    <section className="evaluation-section">
      <div className="task-toolbar">
        <div>
          <div className="task-toolbar-title">작업 목록 ({tasks.length})</div>
          <div className="task-toolbar-subtitle">직업별 작업을 선택하거나 새 작업을 추가해 편집할 수 있습니다.</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={onAdd}>+ 작업 추가</button>
      </div>
      {tasks.length === 0 ? (
        <div className="evaluation-empty-state">작업을 추가하세요.</div>
      ) : (
        <div className="task-list">
          {tasks.map((task, i) => {
            const formula = formulaDB[task.posture];
            const forceColor = task.force >= 6000 ? 'var(--color-danger)' : task.force >= 2700 ? 'var(--color-warning)' : 'var(--color-safe)';
            return (
              <div
                key={task.id}
                className={`task-item ${i === selectedIndex ? 'active' : ''}`}
                onClick={() => onSelect(i)}
              >
                <div className="task-item-main">
                  <div className="task-item-title">{task.name}</div>
                  <div className="task-item-meta">
                    {task.posture} ({formula?.name}) | {task.weight}kg | {task.frequency}회/일
                  </div>
                </div>
                <div className="task-item-side">
                  <span className="task-item-force" style={{ color: forceColor }}>{task.force.toLocaleString()} N</span>
                  {tasks.length > 0 && (
                    <button className="btn btn-danger btn-xs" onClick={e => { e.stopPropagation(); onRemove(i); }}>삭제</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

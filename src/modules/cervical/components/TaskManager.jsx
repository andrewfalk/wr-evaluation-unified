import { EXPOSURE_TYPE_LABELS } from '../utils/data';

function formatExposureTypes(task) {
  return (task.exposure_types || []).map(type => EXPOSURE_TYPE_LABELS[type] || type).join(', ') || '노출 유형 미선택';
}

export function TaskManager({ tasks, selectedIndex, onSelect, onAdd, onRemove }) {
  return (
    <section className="evaluation-section">
      <div className="task-toolbar">
        <div>
          <div className="task-toolbar-title">작업 목록 ({tasks.length})</div>
          <div className="task-toolbar-subtitle">경추 부담 작업을 추가하고, 각 작업의 노출 특성을 입력합니다.</div>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>+ 작업 추가</button>
      </div>

      {tasks.length === 0 ? (
        <div className="evaluation-empty-state">작업을 추가하세요.</div>
      ) : (
        <div className="task-list">
          {tasks.map((task, index) => (
            <div
              key={task.id}
              className={`task-item ${index === selectedIndex ? 'active' : ''}`}
              onClick={() => onSelect(index)}
            >
              <div className="task-item-main">
                <div className="task-item-title">{task.name || `작업 ${index + 1}`}</div>
                <div className="task-item-meta">{formatExposureTypes(task)}</div>
              </div>
              <div className="task-item-side">
                <span className="task-item-force">
                  운반 {task.carry_hours_per_shift || '-'}h / 비중립 {task.neck_nonneutral_hours_per_day || '-'}h
                </span>
                <button
                  type="button"
                  className="btn btn-danger btn-xs"
                  onClick={event => {
                    event.stopPropagation();
                    onRemove(task.id);
                  }}
                >
                  삭제
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

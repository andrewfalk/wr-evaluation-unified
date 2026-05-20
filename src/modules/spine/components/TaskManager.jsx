import { useState } from 'react';
import { formulaDB } from '../utils/formulaDB';

export function TaskManager({ tasks, selectedIndex, onSelect, onAdd, onRemove, onReorder }) {
  const [dragSourceIndex, setDragSourceIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const draggable = tasks.length > 1;

  const handleDragStart = (e, i) => {
    setDragSourceIndex(i);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox는 dataTransfer.setData가 있어야 드래그 시작됨
    try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ }
  };

  const handleDragOver = (e, i) => {
    if (dragSourceIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== i) setDragOverIndex(i);
  };

  const handleDragLeave = (i) => {
    if (dragOverIndex === i) setDragOverIndex(null);
  };

  const handleDrop = (e, i) => {
    e.preventDefault();
    if (dragSourceIndex !== null && dragSourceIndex !== i && onReorder) {
      onReorder(dragSourceIndex, i);
    }
    setDragSourceIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragSourceIndex(null);
    setDragOverIndex(null);
  };

  return (
    <section className="evaluation-section">
      <div className="task-toolbar">
        <div>
          <div className="task-toolbar-title">작업 목록 ({tasks.length})</div>
          <div className="task-toolbar-subtitle">
            직업별 작업을 선택하거나 새 작업을 추가해 편집할 수 있습니다.
            {draggable && ' 항목을 드래그해 순서를 바꿀 수 있습니다.'}
          </div>
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
            const isDragging = dragSourceIndex === i;
            const isDragOver = dragOverIndex === i && dragSourceIndex !== null && dragSourceIndex !== i;
            // 위/아래 방향에 따라 indicator 위치 결정 — source가 위에서 내려오면 target 아래, 아래에서 올라오면 target 위
            const dragOverClass = isDragOver
              ? (dragSourceIndex < i ? 'task-item--drag-over-after' : 'task-item--drag-over-before')
              : '';
            const classes = [
              'task-item',
              i === selectedIndex ? 'active' : '',
              isDragging ? 'task-item--dragging' : '',
              dragOverClass,
            ].filter(Boolean).join(' ');
            return (
              <div
                key={task.id}
                className={classes}
                draggable={draggable}
                onDragStart={e => handleDragStart(e, i)}
                onDragOver={e => handleDragOver(e, i)}
                onDragLeave={() => handleDragLeave(i)}
                onDrop={e => handleDrop(e, i)}
                onDragEnd={handleDragEnd}
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

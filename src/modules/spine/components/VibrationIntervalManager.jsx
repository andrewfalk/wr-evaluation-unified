import { isIntervalValid } from '../utils/vibrationCalc';

// 전신진동 구간 목록 — TaskManager 간소 클론. 드래그 정렬은 에너지합이 순서 무관이라 생략.
export function VibrationIntervalManager({ intervals, selectedIndex, onSelect, onAdd, onRemove, disabled = false }) {
  return (
    <section className="evaluation-section">
      <div className="task-toolbar">
        <div>
          <div className="task-toolbar-title">진동작업 구간 ({intervals.length})</div>
          <div className="task-toolbar-subtitle">
            진동 노출 구간을 선택하거나 새 구간을 추가해 편집할 수 있습니다.
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={onAdd}
          disabled={disabled}
          title={disabled ? '직업력 등록 후 입력 가능' : undefined}
        >
          + 진동작업 추가
        </button>
      </div>
      {intervals.length === 0 ? (
        <div className="evaluation-empty-state">
          {disabled ? '직업력 등록 후 입력 가능 (기본정보 → 직업력)' : '진동작업 구간을 추가하세요.'}
        </div>
      ) : (
        <div className="task-list">
          {intervals.map((iv, i) => {
            const valid = isIntervalValid(iv);
            const unit = iv.timeUnit === 'hr' ? '시간' : iv.timeUnit === 'min' ? '분' : '초';
            const classes = ['task-item', i === selectedIndex ? 'active' : ''].filter(Boolean).join(' ');
            return (
              <div key={iv.id} className={classes} onClick={() => onSelect(i)}>
                <div className="task-item-main">
                  <div className="task-item-title">
                    {iv.name}
                    {!valid && <span style={{ color: 'var(--color-danger)', marginLeft: 6 }}>⚠ 입력 오류</span>}
                  </div>
                  <div className="task-item-meta">
                    aw {iv.awMin}~{iv.awMax} m/s² | 1일 {iv.timeValue}{unit}
                  </div>
                </div>
                <div className="task-item-side">
                  <button className="btn btn-danger btn-xs" onClick={e => { e.stopPropagation(); onRemove(i); }}>삭제</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// 전신진동 구간 편집 — TaskEditor 마크업 재사용.
// aw는 하한/상한 범위로 입력. timeValue는 1일 총 노출시간(frequency 없음).
export function VibrationIntervalEditor({ interval, onChange }) {
  if (!interval) return <div className="evaluation-empty-state">진동작업 구간을 선택하거나 추가하세요.</div>;

  const update = (field, value) => {
    onChange({ ...interval, [field]: value });
  };

  const awMin = Number(interval.awMin);
  const awMax = Number(interval.awMax);
  const rangeInverted = Number.isFinite(awMin) && Number.isFinite(awMax) && awMax < awMin;
  // 노출시간 max는 단위별로 다르다 (1일 기준): 시간 24 / 분 1440 / 초 86400.
  const timeMax = { hr: 24, min: 1440, sec: 86400 }[interval.timeUnit] ?? 24;

  return (
    <div className="task-editor-stack">
      <section className="task-editor-section">
        <div className="section-header">
          <div className="section-title-row">
            <div className="result-section-title">진동작업 기본정보</div>
            <p className="section-description">작업명과 진동가속도 범위, 1일 노출시간을 설정합니다.</p>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label>작업명</label>
            <input value={interval.name} onChange={e => update('name', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>진동가속도 aw 하한 (m/s²)</label>
            <input type="number" min="0" max="20" step="0.01" value={interval.awMin}
              onChange={e => update('awMin', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="form-group">
            <label>진동가속도 aw 상한 (m/s²)</label>
            <input type="number" min="0" max="20" step="0.01" value={interval.awMax}
              onChange={e => update('awMax', parseFloat(e.target.value) || 0)} />
          </div>
        </div>
        {rangeInverted && (
          <div className="form-row">
            <div style={{ color: 'var(--color-danger)', fontSize: '0.85em' }}>
              ⚠ aw 상한이 하한보다 작습니다. 이 구간은 계산에서 제외되며 평가를 완료할 수 없습니다.
            </div>
          </div>
        )}
        <div className="form-row">
          <div className="form-group">
            <label>1일 노출시간</label>
            <input type="number" min="0" max={timeMax} step="0.1" value={interval.timeValue}
              onChange={e => update('timeValue', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="form-group">
            <label>시간 단위</label>
            <select value={interval.timeUnit} onChange={e => update('timeUnit', e.target.value)}>
              <option value="sec">초</option>
              <option value="min">분</option>
              <option value="hr">시간</option>
            </select>
          </div>
        </div>
        <p className="section-description" style={{ marginTop: 4 }}>
          ※ 1일 노출시간은 해당 작업의 하루 총 진동 노출시간입니다 (MDDM의 1회 소요시간×횟수와 다름).
        </p>
      </section>
    </div>
  );
}

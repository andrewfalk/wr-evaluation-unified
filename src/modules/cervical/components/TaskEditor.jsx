import { EXPOSURE_TYPE_OPTIONS } from '../utils/data';

function NumberField({ label, value, onChange, min = 0, step = 0.5 }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}

function YesNoField({ label, name, value, onChange }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <div className="radio-group">
        {[
          { value: 'yes', label: '예' },
          { value: 'no', label: '아니오' },
        ].map(option => (
          <label key={option.value} className="radio-label">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={event => onChange(event.target.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function TaskEditor({ task, onChange }) {
  if (!task) {
    return <div className="evaluation-empty-state">작업을 선택하거나 추가하세요.</div>;
  }

  const update = (field, value) => {
    onChange({ ...task, [field]: value });
  };

  const toggleExposureType = value => {
    const current = task.exposure_types || [];
    const next = current.includes(value)
      ? current.filter(item => item !== value)
      : [...current, value];
    update('exposure_types', next);
  };

  return (
    <div className="task-editor-stack">
      <section className="task-editor-section">
        <div className="section-header">
          <div className="section-title-row">
            <div className="result-section-title">작업 기본정보</div>
            <p className="section-description">작업명과 노출 유형을 먼저 설정합니다.</p>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label>작업명</label>
            <input value={task.name} onChange={event => update('name', event.target.value)} />
          </div>
        </div>

        <div className="form-group">
          <div className="result-section-title">노출 유형</div>
          <div className="result-section-caption">한 작업에서 해당되는 경추 부담 노출을 모두 선택합니다.</div>
          <div className="checkbox-group">
            {EXPOSURE_TYPE_OPTIONS.map(option => (
              <label key={option.value} className="assessment-reason-option">
                <input
                  type="checkbox"
                  checked={(task.exposure_types || []).includes(option.value)}
                  onChange={() => toggleExposureType(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      {(task.exposure_types || []).includes('shoulder_heavy_load') && (
        <section className="task-editor-section">
          <div className="section-header">
            <div className="section-title-row">
              <div className="result-section-title">A. 어깨에 무거운 하중 운반</div>
              <p className="section-description">BK2109형 정량 평가에 사용하는 핵심 입력입니다.</p>
            </div>
          </div>

          <div className="form-row">
            <NumberField
              label="하중 (kg)"
              value={task.load_weight_kg}
              onChange={value => update('load_weight_kg', value)}
              step={1}
            />
            <NumberField
              label="한 작업 교대(shift)당 노출 시간 (시간)"
              value={task.carry_hours_per_shift}
              onChange={value => update('carry_hours_per_shift', value)}
            />
          </div>

          <YesNoField
            label="운반 시 목의 부자연스러운 자세(굴곡, 신전, 꺾임 20도 초과)가 강제됨"
            name={`forced_neck_posture_${task.id}`}
            value={task.forced_neck_posture}
            onChange={value => update('forced_neck_posture', value)}
          />
        </section>
      )}

      {(task.exposure_types || []).includes('awkward_static_neck_load') && (
        <section className="task-editor-section">
          <div className="section-header">
            <div className="section-title-row">
              <div className="result-section-title">B. 장시간 비중립·정적 목 부하</div>
              <p className="section-description">20도 이상의 자세가 1분 이상 지속적으로 유지되었던 시간만을 합산합니다.</p>
            </div>
          </div>

          <div className="form-row">
            <NumberField
              label="굴곡/신전/회전/측굴을 모두 포함한 비중립 정적 자세 수행 시간 (시간/일)"
              value={task.neck_nonneutral_hours_per_day}
              onChange={value => update('neck_nonneutral_hours_per_day', value)}
            />
          </div>

          <div className="form-row">
            <YesNoField
              label="굴곡/신전과 회전/측굴이 동시에 발생"
              name={`combined_flexion_rotation_posture_${task.id}`}
              value={task.combined_flexion_rotation_posture}
              onChange={value => update('combined_flexion_rotation_posture', value)}
            />
            <YesNoField
              label="고도의 정밀(precision) 작업(예시: 미세 가공, 수술 등) 여부"
              name={`precision_work_${task.id}`}
              value={task.precision_work}
              onChange={value => update('precision_work', value)}
            />
          </div>
        </section>
      )}

      <section className="task-editor-section">
        <div className="section-header">
          <div className="section-title-row">
            <div className="result-section-title">메모</div>
            <p className="section-description">필요한 경우 작업 특이사항을 기록합니다.</p>
          </div>
        </div>

        <div className="form-group">
          <textarea
            rows="3"
            value={task.notes}
            onChange={event => update('notes', event.target.value)}
            placeholder="작업 특이사항"
          />
        </div>
      </section>
    </div>
  );
}

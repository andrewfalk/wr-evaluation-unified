function NumberField({ label, value, onChange, min = 0, step = 0.5, placeholder = '' }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
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
              onChange={e => onChange(e.target.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function DiseaseSpecificFields({ diagnosisId, entry, onChange }) {
  const exposureTypes = entry.exposure_types || [];

  return (
    <>
      {exposureTypes.includes('shoulder_heavy_load') && (
        <div className="result-detail-card">
          <div className="result-section-title">A. 어깨에 무거운 하중 운반</div>
          <div className="result-section-caption">BK2109형 정량 평가에 사용하는 핵심 입력입니다.</div>
          <div className="form-row">
            <NumberField
              label="하중 (kg)"
              value={entry.load_weight_kg}
              onChange={value => onChange('load_weight_kg', value)}
              step={1}
            />
            <NumberField
              label="한 작업 교대(shift)당 노출 시간 (시간)"
              value={entry.carry_hours_per_shift}
              onChange={value => onChange('carry_hours_per_shift', value)}
            />
          </div>
          <YesNoField
            label="운반 시 목의 부자연스러운 자세(굴곡, 신전, 꺾임 20도 초과)가 강제됨"
            name={`forced_neck_posture_${diagnosisId}`}
            value={entry.forced_neck_posture}
            onChange={value => onChange('forced_neck_posture', value)}
          />
        </div>
      )}

      {exposureTypes.includes('awkward_static_neck_load') && (
        <div className="result-detail-card">
          <div className="result-section-title">B. 장시간 비중립·정적 목 부하</div>
          <div className="result-section-caption">20도 이상의 자세가 1분 이상 지속적으로 유지되었던 시간만을 합산합니다.</div>
          <div className="form-row">
            <NumberField
              label="굴곡/신전/회전/측굴을 모두 포함한 비중립 정적 자세 수행 시간 (시간/일)"
              value={entry.neck_flexion_hours_per_day}
              onChange={value => onChange('neck_flexion_hours_per_day', value)}
            />
          </div>
          <div className="form-row">
            <YesNoField
              label="굴곡/신전과 회전/측굴이 동시에 발생"
              name={`combined_flexion_rotation_posture_${diagnosisId}`}
              value={entry.combined_flexion_rotation_posture}
              onChange={value => onChange('combined_flexion_rotation_posture', value)}
            />
            <YesNoField
              label="고도의 정밀(precision) 작업(예시: 미세 가공, 수술 등) 여부"
              name={`precision_work_${diagnosisId}`}
              value={entry.precision_work}
              onChange={value => onChange('precision_work', value)}
            />
          </div>
        </div>
      )}
    </>
  );
}

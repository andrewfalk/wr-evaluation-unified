import { PRESSURE_SOURCE_OPTIONS, VIBRATION_TOOL_OPTIONS } from '../utils/data';
import { getBk2101RepetitionPerHour } from '../utils/calculations';

function RadioField({ label, name, value, options, onChange, groupClassName = '', labelClassName = '' }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <div className={`radio-group ${groupClassName}`.trim()}>
        {options.map(option => (
          <label key={option.value} className={`radio-label ${labelClassName}`.trim()}>
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

function CheckboxGroup({ label, values, options, onToggle }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <div className="checkbox-group">
        {options.map(option => (
          <label key={option.value} className="assessment-reason-option">
            <input
              type="checkbox"
              checked={(values || []).includes(option.value)}
              onChange={() => onToggle(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

const YES_NO_OPTIONS = [
  { value: 'yes', label: '예' },
  { value: 'no', label: '아니오' },
];

const FREQUENCY_OPTIONS = [
  { value: 'none', label: '없음' },
  { value: 'occasional', label: '가끔' },
  { value: 'frequent', label: '빈번' },
];

const VIBRATION_OPTIONS = [
  { value: 'none', label: '없음' },
  { value: 'present', label: '있음' },
];

export function DiseaseSpecificFields({ diagnosisId, selectedBkType, evaluation, onChange, onToggleMultiValue }) {
  const branchRadioGroupClass = 'wrist-branch-radio-grid';
  const branchRadioLabelClass = 'wrist-branch-radio-label';
  const showBk2103VibrationDetails = evaluation.vibration_exposure === 'present';
  const showBk2106PressureSource = evaluation.direct_pressure_level && evaluation.direct_pressure_level !== 'none';

  if (!selectedBkType) {
    return <div className="evaluation-empty-state">BK 유형을 먼저 선택해 주세요.</div>;
  }

  if (selectedBkType === 'BK2113') {
    return (
      <>
        <RadioField
          label="반복적인 손목 굴신 동작"
          name={`bk2113_repetitive_wrist_motion_${diagnosisId}`}
          value={evaluation.bk2113_repetitive_wrist_motion}
          options={YES_NO_OPTIONS}
          onChange={value => onChange('bk2113_repetitive_wrist_motion', value)}
          groupClassName={branchRadioGroupClass}
          labelClassName={branchRadioLabelClass}
        />
        <div className="result-section-caption">
          CTS는 공통 입력의 반복, 힘 사용, 진동 항목과 함께 해석됩니다.
        </div>
      </>
    );
  }

  if (selectedBkType === 'BK2101') {
    const repetitionPerHour = getBk2101RepetitionPerHour(evaluation);

    return (
      <>
        <div className="form-row">
          <div className="form-group">
            <label>1회 동작 주기(초)</label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={evaluation.bk2101_cycle_seconds}
              onChange={e => onChange('bk2101_cycle_seconds', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>예상 시간당 반복 횟수</label>
            <input
              value={repetitionPerHour > 0 ? repetitionPerHour : ''}
              readOnly
              placeholder="주기를 입력하면 자동 계산"
            />
            <div className="result-section-caption">3600초를 주기로 나누어 자동 계산합니다.</div>
          </div>
        </div>
        <RadioField
          label="단조로운 반복 패턴 여부"
          name={`bk2101_monotony_${diagnosisId}`}
          value={evaluation.bk2101_monotony}
          options={YES_NO_OPTIONS}
          onChange={value => onChange('bk2101_monotony', value)}
          groupClassName={branchRadioGroupClass}
          labelClassName={branchRadioLabelClass}
        />
        <RadioField
          label="같은 자세 유지"
          name={`static_holding_level_${diagnosisId}`}
          value={evaluation.static_holding_level}
          options={FREQUENCY_OPTIONS}
          onChange={value => onChange('static_holding_level', value)}
          groupClassName={branchRadioGroupClass}
          labelClassName={branchRadioLabelClass}
        />
        <div className="form-row">
          <RadioField
            label="강제 손목 배굴"
            name={`bk2101_forced_dorsal_extension_${diagnosisId}`}
            value={evaluation.bk2101_forced_dorsal_extension}
            options={YES_NO_OPTIONS}
            onChange={value => onChange('bk2101_forced_dorsal_extension', value)}
            groupClassName={branchRadioGroupClass}
            labelClassName={branchRadioLabelClass}
          />
          <RadioField
            label="반복 회내/회외"
            name={`bk2101_prosupination_${diagnosisId}`}
            value={evaluation.bk2101_prosupination}
            options={YES_NO_OPTIONS}
            onChange={value => onChange('bk2101_prosupination', value)}
            groupClassName={branchRadioGroupClass}
            labelClassName={branchRadioLabelClass}
          />
        </div>
      </>
    );
  }

  if (selectedBkType === 'BK2103') {
    return (
      <>
        <RadioField
          label="진동 공구 사용"
          name={`vibration_exposure_${diagnosisId}`}
          value={evaluation.vibration_exposure}
          options={VIBRATION_OPTIONS}
          onChange={value => onChange('vibration_exposure', value)}
          groupClassName={branchRadioGroupClass}
          labelClassName={branchRadioLabelClass}
        />
        {showBk2103VibrationDetails && (
          <>
            <CheckboxGroup
              label="진동 공구 종류"
              values={evaluation.bk2103_vibration_tool_type}
              options={VIBRATION_TOOL_OPTIONS}
              onToggle={value => onToggleMultiValue('bk2103_vibration_tool_type', value)}
            />
            <div className="form-row">
              <div className="form-group wrist-short-number-field">
                <label>진동 공구 1일 사용 시간</label>
                <div className="wrist-input-with-unit">
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={evaluation.bk2103_daily_vibration_hours}
                    onChange={e => onChange('bk2103_daily_vibration_hours', e.target.value)}
                  />
                  <span className="wrist-input-unit">시간</span>
                </div>
              </div>
            </div>
          </>
        )}
        <div className="form-row">
          <RadioField
            label="공구를 강하게 쥐거나 누르며 사용하는 작업"
            name={`bk2103_tool_pressing_${diagnosisId}`}
            value={evaluation.bk2103_tool_pressing}
            options={YES_NO_OPTIONS}
            onChange={value => onChange('bk2103_tool_pressing', value)}
            groupClassName={branchRadioGroupClass}
            labelClassName={branchRadioLabelClass}
          />
        </div>
      </>
    );
  }

  if (selectedBkType === 'BK2106') {
    return (
      <>
        <RadioField
          label="직접 압박/마찰/충격"
          name={`direct_pressure_level_${diagnosisId}`}
          value={evaluation.direct_pressure_level}
          options={FREQUENCY_OPTIONS}
          onChange={value => onChange('direct_pressure_level', value)}
          groupClassName={branchRadioGroupClass}
          labelClassName={branchRadioLabelClass}
        />
        {showBk2106PressureSource && (
          <CheckboxGroup
            label="압박 원인"
            values={evaluation.bk2106_pressure_source}
            options={PRESSURE_SOURCE_OPTIONS}
            onToggle={value => onToggleMultiValue('bk2106_pressure_source', value)}
          />
        )}
        <RadioField
          label="같은 자세 유지"
          name={`static_holding_level_${diagnosisId}`}
          value={evaluation.static_holding_level}
          options={FREQUENCY_OPTIONS}
          onChange={value => onChange('static_holding_level', value)}
          groupClassName={branchRadioGroupClass}
          labelClassName={branchRadioLabelClass}
        />
      </>
    );
  }

  return null;
}

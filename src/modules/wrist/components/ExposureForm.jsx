import {
  BK_TYPE_LABELS,
  BK_TYPE_OPTIONS,
  EXPOSURE_TYPE_OPTIONS,
  resetWristBranchFields,
} from '../utils/data';
import { DiseaseSpecificFields } from './DiseaseSpecificFields';

const DIRECT_LINK_OPTIONS = [
  { value: 'yes', label: '예' },
  { value: 'no', label: '아니오' },
];

const WORK_PATTERN_OPTIONS = [
  { value: 'continuous', label: '연속' },
  { value: 'intermittent', label: '간헐' },
  { value: 'mixed', label: '혼합' },
];

const REST_OPTIONS = [
  { value: 'adequate', label: '충분' },
  { value: 'moderate', label: '보통' },
  { value: 'insufficient', label: '부족' },
];

const COMMON_FORCE_OPTIONS = [
  { value: 'mild', label: '경도' },
  { value: 'moderate', label: '중등도' },
  { value: 'high', label: '고강도' },
];

const COMMON_FREQUENCY_OPTIONS = [
  { value: 'occasional', label: '가끔' },
  { value: 'frequent', label: '빈번' },
];

const EXPOSURE_DETAIL_CONFIG = {
  repetition: {
    label: '반복 동작 정도',
    field: 'repetition_level',
    options: COMMON_FREQUENCY_OPTIONS,
  },
  force: {
    label: '힘 사용 정도',
    field: 'force_level',
    options: COMMON_FORCE_OPTIONS,
    twoByTwo: true,
  },
  awkward_posture: {
    label: '부자연스러운 자세 정도',
    field: 'awkward_posture_level',
    options: COMMON_FREQUENCY_OPTIONS,
  },
};

function RadioGroup({ label, name, value, options, onChange, groupClassName = '', labelClassName = '' }) {
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

function getSideLabel(side) {
  return side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';
}

function EntryCard({ jobId, diagnosis, entry, onChangeEntry }) {
  const inputKey = `${jobId}_${diagnosis.id}`;
  const shouldShowExposureFields = entry.direct_anatomic_link === 'yes';
  const selectionModeLabel = entry.bkSelectionMode === 'manual'
    ? '수동 선택'
    : (entry.selectedBkType ? '자동 제안' : '자동 제안 없음');

  const patchEntry = (patch) => onChangeEntry(jobId, diagnosis.id, patch);

  const toggleExposureType = (value) => {
    const current = entry.exposure_types || [];
    const next = current.includes(value)
      ? current.filter(item => item !== value)
      : [...current, value];

    const detailConfig = EXPOSURE_DETAIL_CONFIG[value];
    const patch = { exposure_types: next };

    if (detailConfig && !next.includes(value)) {
      patch[detailConfig.field] = '';
    }

    patchEntry(patch);
  };

  return (
    <div className="diagnosis-card wrist-diagnosis-card">
      <div className="diagnosis-card-header">
        <div className="card-title-stack">
          <span className="diagnosis-card-title">{diagnosis.code || '-'} {diagnosis.name || '손목 상병'}</span>
          <span className="diagnosis-card-subtitle">방향: {getSideLabel(diagnosis.side)}</span>
        </div>
        <div className="wrist-entry-badges">
          <span className="diagnosis-module-badge">{BK_TYPE_LABELS[entry.selectedBkType] || 'BK 유형 미선택'}</span>
          <span className={`job-badge ${entry.bkSelectionMode === 'manual' ? 'badge-medium-high' : 'badge-low'}`}>{selectionModeLabel}</span>
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>BK 유형</label>
          <select
            value={entry.selectedBkType}
            onChange={e => {
              const nextValue = e.target.value;
              const nextEntry = resetWristBranchFields(entry, nextValue);
              patchEntry({
                ...nextEntry,
                selectedBkType: nextValue,
                bkSelectionMode: nextValue ? 'manual' : 'auto',
              });
            }}
          >
            {BK_TYPE_OPTIONS.map(option => (
              <option key={option.value || 'empty'} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      <RadioGroup
        label="병변 부위와 직접 연결되는 핵심 작업/자세가 있는가"
        name={`direct_anatomic_link_${inputKey}`}
        value={entry.direct_anatomic_link}
        options={DIRECT_LINK_OPTIONS}
        onChange={value => patchEntry({ direct_anatomic_link: value })}
      />

      {shouldShowExposureFields && (
        <>
          <div className="form-group wrist-task-name-group">
            <label>문제 작업명</label>
            <input
              value={entry.main_task_name}
              onChange={e => patchEntry({ main_task_name: e.target.value })}
              placeholder="해당 직업에서 손목 부담이 큰 대표 작업"
            />
          </div>

          <div className="form-row wrist-task-metrics-row">
            <div className="form-group">
              <label>1일 총 노출시간(시간)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={entry.daily_exposure_hours}
                onChange={e => patchEntry({ daily_exposure_hours: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>근무시간 비중(%)</label>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={entry.shift_share_percent}
                onChange={e => patchEntry({ shift_share_percent: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>주당 근무일수</label>
              <input
                type="number"
                min="0"
                max="7"
                step="0.5"
                value={entry.days_per_week}
                onChange={e => patchEntry({ days_per_week: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group wrist-common-exposure-group">
            <div className="result-section-title">[질환 공통] 핵심 노출 축</div>
            <div className="result-section-caption">체크한 항목만 아래에서 세부 강도를 입력합니다.</div>
            <div className="checkbox-group">
              {EXPOSURE_TYPE_OPTIONS.map(option => (
                <div key={option.value} className="wrist-exposure-option">
                  <label className="assessment-reason-option">
                    <input
                      type="checkbox"
                      checked={(entry.exposure_types || []).includes(option.value)}
                      onChange={() => toggleExposureType(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                  {(entry.exposure_types || []).includes(option.value) && EXPOSURE_DETAIL_CONFIG[option.value] && (
                    <div className="wrist-exposure-detail">
                      <RadioGroup
                        label={EXPOSURE_DETAIL_CONFIG[option.value].label}
                        name={`${EXPOSURE_DETAIL_CONFIG[option.value].field}_${inputKey}`}
                        value={entry[EXPOSURE_DETAIL_CONFIG[option.value].field]}
                        options={EXPOSURE_DETAIL_CONFIG[option.value].options}
                        onChange={value => patchEntry({ [EXPOSURE_DETAIL_CONFIG[option.value].field]: value })}
                        groupClassName={EXPOSURE_DETAIL_CONFIG[option.value].twoByTwo ? 'wrist-radio-grid-2' : ''}
                        labelClassName={EXPOSURE_DETAIL_CONFIG[option.value].twoByTwo ? 'wrist-radio-label-grid' : ''}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="form-row">
            <RadioGroup
              label="작업 형태"
              name={`work_pattern_${inputKey}`}
              value={entry.work_pattern}
              options={WORK_PATTERN_OPTIONS}
              onChange={value => patchEntry({ work_pattern: value })}
            />
            <RadioGroup
              label="휴식 분포"
              name={`rest_distribution_${inputKey}`}
              value={entry.rest_distribution}
              options={REST_OPTIONS}
              onChange={value => patchEntry({ rest_distribution: value })}
            />
          </div>

          <div className="result-detail-card wrist-branch-card">
            <div className="result-section-title">질환별 분기</div>
            <div className="result-section-caption">선택한 BK 유형에 따라 필요한 항목이 달라집니다.</div>
            <div className="wrist-branch-fields">
              <DiseaseSpecificFields
                diagnosisId={inputKey}
                selectedBkType={entry.selectedBkType}
                evaluation={entry}
                onChange={(field, value) => patchEntry({ [field]: value })}
                onToggleMultiValue={(field, value) => {
                  const current = entry[field] || [];
                  const next = current.includes(value)
                    ? current.filter(item => item !== value)
                    : [...current, value];
                  patchEntry({ [field]: next });
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function ExposureForm({
  job,
  jobIndex,
  wristDiagnoses,
  jobEvaluation,
  errors,
  onChangeEntry,
}) {
  return (
    <div className="job-card wrist-job-card">
      <div className="job-card-header">
        <div className="card-title-stack">
          <span className="job-card-title">직력 {jobIndex + 1}: {job.jobName || '(미입력)'}</span>
          <span className="job-card-subtitle">이 직업에서 손목/손가락 상병별 노출 특성과 BK 분기 정보를 입력합니다.</span>
        </div>
        <span className="job-badge badge-low">{wristDiagnoses.length}개 상병</span>
      </div>

      {errors?.jobs && <div className="error-message">{errors.jobs}</div>}

      <div className="wrist-entry-grid">
        {wristDiagnoses.map(diagnosis => {
          const entry = jobEvaluation.diagnosisEntries.find(item => item.diagnosisId === diagnosis.id);
          if (!entry) return null;

          return (
            <EntryCard
              key={diagnosis.id}
              jobId={job.id}
              diagnosis={diagnosis}
              entry={entry}
              onChangeEntry={onChangeEntry}
            />
          );
        })}
      </div>
    </div>
  );
}

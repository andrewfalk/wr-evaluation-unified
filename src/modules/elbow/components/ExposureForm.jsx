import {
  BK_TYPE_LABELS,
  BK_TYPE_OPTIONS,
  EXPOSURE_TYPE_OPTIONS,
  resetElbowBranchFields,
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
  { value: 'mild', label: '경미' },
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
    label: '비중립 자세 정도',
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
    <div className="diagnosis-card elbow-diagnosis-card">
      <div className="diagnosis-card-header">
        <div className="card-title-stack">
          <span className="diagnosis-card-title">{diagnosis.code || '-'} {diagnosis.name || '팔꿈치 상병'}</span>
          <span className="diagnosis-card-subtitle">방향: {getSideLabel(diagnosis.side)}</span>
        </div>
        <div className="elbow-entry-badges">
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
              const nextEntry = resetElbowBranchFields(entry, nextValue);
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
        label="병변 부위와 직접 연결되는 핵심 동작/자세가 있는가"
        name={`direct_anatomic_link_${inputKey}`}
        value={entry.direct_anatomic_link}
        options={DIRECT_LINK_OPTIONS}
        onChange={value => patchEntry({ direct_anatomic_link: value })}
      />

      {shouldShowExposureFields && (
        <>
          <div className="form-group elbow-task-name-group">
            <label>문제 작업명</label>
            <input
              value={entry.main_task_name}
              onChange={e => patchEntry({ main_task_name: e.target.value })}
              placeholder="해당 직업에서 문제가 되는 작업명을 입력하세요"
            />
          </div>

          <div className="form-row elbow-task-metrics-row">
            <div className="form-group">
              <label>1일 총시간(시간)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={entry.daily_exposure_hours}
                onChange={e => patchEntry({ daily_exposure_hours: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>하루 작업 비중(%)</label>
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
              <label>주당 수행일수</label>
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

          <div className="form-group elbow-common-exposure-group">
            <div className="result-section-title">[질환 공통] 핵심 노출 지표</div>
            <div className="result-section-caption">체크한 항목만 아래에서 세부 정도를 선택합니다</div>
            <div className="checkbox-group">
              {EXPOSURE_TYPE_OPTIONS.map(option => (
                <div key={option.value} className="elbow-exposure-option">
                  <label className="assessment-reason-option">
                    <input
                      type="checkbox"
                      checked={(entry.exposure_types || []).includes(option.value)}
                      onChange={() => toggleExposureType(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                  {(entry.exposure_types || []).includes(option.value) && EXPOSURE_DETAIL_CONFIG[option.value] && (
                    <div className="elbow-exposure-detail">
                      <RadioGroup
                        label={EXPOSURE_DETAIL_CONFIG[option.value].label}
                        name={`${EXPOSURE_DETAIL_CONFIG[option.value].field}_${inputKey}`}
                        value={entry[EXPOSURE_DETAIL_CONFIG[option.value].field]}
                        options={EXPOSURE_DETAIL_CONFIG[option.value].options}
                        onChange={value => patchEntry({ [EXPOSURE_DETAIL_CONFIG[option.value].field]: value })}
                        groupClassName={EXPOSURE_DETAIL_CONFIG[option.value].twoByTwo ? 'elbow-radio-grid-2' : ''}
                        labelClassName={EXPOSURE_DETAIL_CONFIG[option.value].twoByTwo ? 'elbow-radio-label-grid' : ''}
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

          <div className="result-detail-card elbow-branch-card">
            <div className="result-section-title">질환별 세부 분기</div>
            <div className="result-section-caption">선택한 BK 유형에 따라 필요한 항목이 달라집니다</div>
            <div className="elbow-branch-fields">
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
  elbowDiagnoses,
  jobEvaluation,
  errors,
  onChangeEntry,
}) {
  return (
    <div className="job-card elbow-job-card">
      <div className="job-card-header">
        <div className="card-title-stack">
          <span className="job-card-title">직력 {jobIndex + 1}: {job.jobName || '(미입력)'}</span>
          <span className="job-card-subtitle">이 직업에서 팔꿈치 상병별 노출 특성과 BK 분기 정보를 입력합니다</span>
        </div>
        <span className="job-badge badge-low">{elbowDiagnoses.length}개 상병</span>
      </div>

      {errors?.jobs && <div className="error-message">{errors.jobs}</div>}

      <div className="elbow-entry-grid">
        {elbowDiagnoses.map(diagnosis => {
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

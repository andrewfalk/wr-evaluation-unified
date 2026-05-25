import {
  BK_TYPE_LABELS,
  BK_TYPE_OPTIONS,
  EXPOSURE_TYPE_OPTIONS,
  resetElbowBranchFields,
} from '../utils/data';
import {
  groupDiagnosesByBkType,
  pickRepresentativeEntry,
} from '../utils/calculations';
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

function hasEntryMismatch(items) {
  if (items.length < 2) return false;
  const first = items[0]?.entry;
  if (!first) return false;
  const SKIP = new Set(['diagnosisId', 'selectedBkType', 'bkSelectionMode']);
  const keys = Object.keys(first).filter(k => !SKIP.has(k));
  return items.slice(1).some(({ entry }) =>
    entry && keys.some(k => {
      const a = first[k]; const b = entry[k];
      return JSON.stringify(a) !== JSON.stringify(b);
    })
  );
}

function BkGroupCard({ jobId, bkType, items, allGroups, onChangeEntry }) {
  const representativeEntry = pickRepresentativeEntry(items);
  const inputKey = `${jobId}_bk_${bkType || 'none'}`;
  const shouldShowExposureFields = representativeEntry.direct_anatomic_link === 'yes';
  const selectionModeLabel = representativeEntry.bkSelectionMode === 'manual' ? '수동 선택' : (representativeEntry.selectedBkType ? '자동 제안' : '자동 제안 없음');
  const diagSubtitle = items.map(({ diagnosis }) => `${diagnosis.code || '-'} ${diagnosis.name || ''}`.trim()).join(' / ');
  const mismatch = hasEntryMismatch(items);

  const patchAll = (patch) => {
    items.forEach(({ diagnosis }) => onChangeEntry(jobId, diagnosis.id, patch));
  };

  const handleBkChange = (nextBk) => {
    const existingGroup = nextBk && allGroups.find(g => g.bkType === nextBk && g.bkType !== bkType);
    if (existingGroup) {
      const repEntry = pickRepresentativeEntry(existingGroup.items);
      const SKIP = new Set(['diagnosisId', 'selectedBkType', 'bkSelectionMode']);
      const copied = Object.fromEntries(
        Object.entries(repEntry).filter(([k]) => !SKIP.has(k))
      );
      items.forEach(({ diagnosis }) =>
        onChangeEntry(jobId, diagnosis.id, { ...copied, selectedBkType: nextBk, bkSelectionMode: 'manual' })
      );
    } else {
      items.forEach(({ diagnosis }) => {
        const cur = (allGroups.flatMap(g => g.items).find(i => i.diagnosis.id === diagnosis.id)?.entry) || {};
        const reset = resetElbowBranchFields(cur, nextBk);
        onChangeEntry(jobId, diagnosis.id, { ...reset, selectedBkType: nextBk, bkSelectionMode: 'manual' });
      });
    }
  };

  const toggleExposureType = (value) => {
    const current = representativeEntry.exposure_types || [];
    const next = current.includes(value) ? current.filter(i => i !== value) : [...current, value];
    const detailConfig = EXPOSURE_DETAIL_CONFIG[value];
    const patch = { exposure_types: next };
    if (detailConfig && !next.includes(value)) patch[detailConfig.field] = '';
    patchAll(patch);
  };

  return (
    <div className="diagnosis-card elbow-diagnosis-card">
      <div className="diagnosis-card-header">
        <div className="card-title-stack">
          <span className="diagnosis-card-title">{BK_TYPE_LABELS[bkType] || 'BK 유형 미선택'}</span>
          <span className="diagnosis-card-subtitle">{diagSubtitle}</span>
        </div>
        <div className="elbow-entry-badges">
          <span className="diagnosis-module-badge">{items.length}개 상병 공통 입력</span>
          <span className={`job-badge ${representativeEntry.bkSelectionMode === 'manual' ? 'badge-medium-high' : 'badge-low'}`}>{selectionModeLabel}</span>
        </div>
      </div>
      {mismatch && (
        <div className="result-note" style={{ color: 'var(--warning-color, #b45309)' }}>
          ⚠ 기존 상병별 입력값이 통합되었습니다. 대표값(가장 많이 입력된 값)으로 표시됩니다.
        </div>
      )}
      {items.length > 1 && (
        <div className="result-note">
          BK 유형 변경 시 {items.length}개 상병 전체에 적용됩니다.
        </div>
      )}

      <div className="form-row">
        <div className="form-group">
          <label>BK 유형</label>
          <select value={representativeEntry.selectedBkType || ''} onChange={e => handleBkChange(e.target.value)}>
            {BK_TYPE_OPTIONS.map(option => (
              <option key={option.value || 'empty'} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      <RadioGroup
        label="병변 부위와 직접 연결되는 핵심 동작/자세가 있는가"
        name={`direct_anatomic_link_${inputKey}`}
        value={representativeEntry.direct_anatomic_link}
        options={DIRECT_LINK_OPTIONS}
        onChange={value => patchAll({ direct_anatomic_link: value })}
      />

      {shouldShowExposureFields && (
        <>
          <div className="form-group elbow-task-name-group">
            <label>문제 작업명</label>
            <input
              value={representativeEntry.main_task_name}
              onChange={e => patchAll({ main_task_name: e.target.value })}
              placeholder="해당 직업에서 문제가 되는 작업명을 입력하세요"
            />
          </div>

          <div className="form-row elbow-task-metrics-row">
            <div className="form-group">
              <label>1일 총시간(시간)</label>
              <input type="number" min="0" step="0.5" value={representativeEntry.daily_exposure_hours} onChange={e => patchAll({ daily_exposure_hours: e.target.value })} />
            </div>
            <div className="form-group">
              <label>하루 작업 비중(%)</label>
              <input type="number" min="0" max="100" step="1" value={representativeEntry.shift_share_percent} onChange={e => patchAll({ shift_share_percent: e.target.value })} />
            </div>
            <div className="form-group">
              <label>주당 수행일수</label>
              <input type="number" min="0" max="7" step="0.5" value={representativeEntry.days_per_week} onChange={e => patchAll({ days_per_week: e.target.value })} />
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
                      checked={(representativeEntry.exposure_types || []).includes(option.value)}
                      onChange={() => toggleExposureType(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                  {(representativeEntry.exposure_types || []).includes(option.value) && EXPOSURE_DETAIL_CONFIG[option.value] && (
                    <div className="elbow-exposure-detail">
                      <RadioGroup
                        label={EXPOSURE_DETAIL_CONFIG[option.value].label}
                        name={`${EXPOSURE_DETAIL_CONFIG[option.value].field}_${inputKey}`}
                        value={representativeEntry[EXPOSURE_DETAIL_CONFIG[option.value].field]}
                        options={EXPOSURE_DETAIL_CONFIG[option.value].options}
                        onChange={value => patchAll({ [EXPOSURE_DETAIL_CONFIG[option.value].field]: value })}
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
            <RadioGroup label="작업 형태" name={`work_pattern_${inputKey}`} value={representativeEntry.work_pattern} options={WORK_PATTERN_OPTIONS} onChange={value => patchAll({ work_pattern: value })} />
            <RadioGroup label="휴식 분포" name={`rest_distribution_${inputKey}`} value={representativeEntry.rest_distribution} options={REST_OPTIONS} onChange={value => patchAll({ rest_distribution: value })} />
          </div>

          <div className="result-detail-card elbow-branch-card">
            <div className="result-section-title">질환별 세부 분기</div>
            <div className="result-section-caption">선택한 BK 유형에 따라 필요한 항목이 달라집니다</div>
            <div className="elbow-branch-fields">
              <DiseaseSpecificFields
                diagnosisId={inputKey}
                selectedBkType={representativeEntry.selectedBkType}
                evaluation={representativeEntry}
                onChange={(field, value) => patchAll({ [field]: value })}
                onToggleMultiValue={(field, value) => {
                  const current = representativeEntry[field] || [];
                  const next = current.includes(value) ? current.filter(i => i !== value) : [...current, value];
                  patchAll({ [field]: next });
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
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
  const groups = groupDiagnosesByBkType(elbowDiagnoses, jobEvaluation);
  const groupCount = groups.filter(g => g.isGrouped).length + groups.filter(g => !g.isGrouped).length;

  return (
    <div className="job-card elbow-job-card">
      <div className="job-card-header">
        <div className="card-title-stack">
          <span className="job-card-title">직력 {jobIndex + 1}: {job.jobName || '(미입력)'}</span>
          <span className="job-card-subtitle">이 직업에서 BK 유형별 노출 특성과 분기 정보를 입력합니다</span>
        </div>
        <span className="job-badge badge-low">{groupCount}개 항목 / {elbowDiagnoses.length}개 상병</span>
      </div>

      {errors?.jobs && <div className="error-message">{errors.jobs}</div>}

      <div className="elbow-entry-grid">
        {groups.map(group => {
          if (group.isGrouped) {
            return (
              <BkGroupCard
                key={group.bkType}
                jobId={job.id}
                bkType={group.bkType}
                items={group.items}
                allGroups={groups}
                onChangeEntry={onChangeEntry}
              />
            );
          }
          const { diagnosis, entry } = group.items[0];
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

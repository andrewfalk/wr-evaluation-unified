import {
  CERVICAL_SUBTYPE_LABELS,
  EXPOSURE_TYPE_OPTIONS,
  inferCervicalSubtypeFromDiagnosis,
} from '../utils/data';
import { DiseaseSpecificFields } from './DiseaseSpecificFields';

function getExposureLabel(value) {
  return EXPOSURE_TYPE_OPTIONS.find(option => option.value === value)?.label || value;
}

function EntryCard({ jobId, diagnosis, entry, onChangeEntry }) {
  const inputKey = `${jobId}_${diagnosis.id}`;
  const subtype = inferCervicalSubtypeFromDiagnosis(diagnosis);
  const subtypeLabel = CERVICAL_SUBTYPE_LABELS[subtype] || CERVICAL_SUBTYPE_LABELS.cervical_other;

  const patchEntry = patch => onChangeEntry(jobId, diagnosis.id, patch);

  const toggleExposureType = value => {
    const current = entry.exposure_types || [];
    const next = current.includes(value)
      ? current.filter(item => item !== value)
      : [...current, value];

    patchEntry({ exposure_types: next });
  };

  return (
    <div className="diagnosis-card">
      <div className="diagnosis-card-header">
        <div className="card-title-stack">
          <span className="diagnosis-card-title">{diagnosis.code || '-'} {diagnosis.name || '경추 상병'}</span>
          <span className="diagnosis-card-subtitle">질환군: {subtypeLabel}</span>
        </div>
        <span className="diagnosis-module-badge">{subtypeLabel}</span>
      </div>

      <div className="form-group">
        <label>문제 작업명</label>
        <input
          value={entry.main_task_name}
          onChange={e => patchEntry({ main_task_name: e.target.value })}
          placeholder="해당 직업에서 경추 부담이 가장 큰 작업"
        />
      </div>

      <div className="form-group">
        <div className="result-section-title">노출 유형</div>
        <div className="result-section-caption">선택한 노출 유형에 맞는 세부 입력만 아래에 표시됩니다.</div>
        <div className="checkbox-group">
          {EXPOSURE_TYPE_OPTIONS.map(option => (
            <label key={option.value} className="assessment-reason-option">
              <input
                type="checkbox"
                checked={(entry.exposure_types || []).includes(option.value)}
                onChange={() => toggleExposureType(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      {(entry.exposure_types || []).length > 0 && (
        <DiseaseSpecificFields
          diagnosisId={inputKey}
          entry={entry}
          onChange={(field, value) => patchEntry({ [field]: value })}
        />
      )}

      <div className="form-group">
        <label>메모</label>
        <textarea
          rows="2"
          value={entry.notes}
          onChange={e => patchEntry({ notes: e.target.value })}
          placeholder={(entry.exposure_types || []).length > 0
            ? `선택 노출: ${(entry.exposure_types || []).map(getExposureLabel).join(', ')}`
            : '노출 근거 또는 특이사항'}
        />
      </div>
    </div>
  );
}

export function ExposureForm({ job, jobIndex, cervicalDiagnoses, jobEvaluation, onChangeEntry }) {
  return (
    <div className="job-card">
      <div className="job-card-header">
        <div className="card-title-stack">
          <span className="job-card-title">직력 {jobIndex + 1}: {job.jobName || '(미입력)'}</span>
          <span className="job-card-subtitle">이 직업에서 경추 상병별 노출 특성을 시간 기준으로 입력합니다.</span>
        </div>
        <span className="job-badge badge-low">{cervicalDiagnoses.length}개 상병</span>
      </div>

      <div className="result-detail-stack">
        {cervicalDiagnoses.map(diagnosis => {
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

import { calculateBMI, calculateAge } from '../utils/common';
import { formatWorkPeriod } from '../utils/workPeriod';
import { createSharedJob } from '../utils/data';
import { PresetSearch } from './PresetSearch';

export function BasicInfoForm({ shared, onChange, errors, refDateField = 'injuryDate', refDateLabel = '재해일자', presets, presetMeta, presetError, onPresetSelect }) {
  const handleInput = (field, value) => {
    onChange({ ...shared, [field]: value });
  };

  const jobs = shared.jobs || [];

  const handleJob = (i, field, value) => {
    const updated = [...jobs];
    updated[i] = { ...updated[i], [field]: value };
    onChange({ ...shared, jobs: updated });
  };

  const handlePresetSelectInternal = (i, preset) => {
    const updated = [...jobs];
    updated[i] = { ...updated[i], presetId: preset.id, jobName: preset.jobName };
    onChange({ ...shared, jobs: updated });
    if (onPresetSelect) onPresetSelect(updated[i].id, preset);
  };

  const addJob = () => {
    onChange({ ...shared, jobs: [...jobs, createSharedJob()] });
  };

  const removeJob = (i) => {
    if (jobs.length > 1) {
      onChange({ ...shared, jobs: jobs.filter((_, x) => x !== i) });
    }
  };

  const bmi = calculateBMI(shared.height, shared.weight);
  const age = calculateAge(shared.birthDate, shared[refDateField]);

  return (
    <>
      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">1</span>인적사항</h2>
            <p className="section-description">기본 신상 정보와 평가 기준 날짜를 입력합니다.</p>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>이름 *</label>
            <input value={shared.name} onChange={e => handleInput('name', e.target.value)} />
            {errors?.name && <div className="error-message">{errors.name}</div>}
          </div>
          <div className="form-group">
            <label>성별</label>
            <div className="radio-group">
              <label className="radio-label">
                <input type="radio" name="gender" value="male" checked={shared.gender === 'male'} onChange={e => handleInput('gender', e.target.value)} />
                <span>남</span>
              </label>
              <label className="radio-label">
                <input type="radio" name="gender" value="female" checked={shared.gender === 'female'} onChange={e => handleInput('gender', e.target.value)} />
                <span>여</span>
              </label>
            </div>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>키 (cm)</label><input type="number" value={shared.height} onChange={e => handleInput('height', e.target.value)} /></div>
          <div className="form-group"><label>몸무게 (kg)</label><input type="number" value={shared.weight} onChange={e => handleInput('weight', e.target.value)} /></div>
          <div className="form-group"><label>BMI</label><input value={bmi || '-'} readOnly /></div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>생년월일 *</label>
            <input type="date" max="9999-12-31" value={shared.birthDate} onChange={e => handleInput('birthDate', e.target.value)} />
            {errors?.birthDate && <div className="error-message">{errors.birthDate}</div>}
          </div>
          <div className="form-group">
            <label>{refDateLabel} *</label>
            <input type="date" max="9999-12-31" value={shared[refDateField]} onChange={e => handleInput(refDateField, e.target.value)} />
            {errors?.[refDateField] && <div className="error-message">{errors[refDateField]}</div>}
          </div>
          <div className="form-group"><label>만 나이</label><input value={age ? `${age}세` : '-'} readOnly /></div>
        </div>
      </section>

      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">2</span>직업력</h2>
            <p className="section-description">직종, 근무 기간, 연간 근무일수를 기록합니다.</p>
          </div>
          <div className="section-actions">
            <button className="btn btn-primary btn-sm" onClick={addJob}>+ 직종 추가</button>
          </div>
        </div>
        {presetMeta && <div className="preset-meta form-meta-card">Preset: {presetMeta.count}개 직종{presetError && <span className="form-meta-warning">{presetError}</span>}</div>}
        {errors?.jobs && <div className="error-message">{errors.jobs}</div>}
        {jobs.map((job, i) => (
          <div key={job.id} className="job-card">
            <div className="job-card-header">
              <div className="card-title-stack">
                <span className="job-card-title">직력 {i + 1}</span>
                <span className="job-card-subtitle">해당 직무의 기간과 근무 조건을 입력합니다.</span>
              </div>
              {jobs.length > 1 && <button className="btn btn-danger btn-xs" onClick={() => removeJob(i)}>삭제</button>}
            </div>
            <div className="form-row">
              <div className="form-group form-group-wide">
                <label>직종명</label>
                {presets ? (
                  <PresetSearch
                    presets={presets}
                    value={job.jobName}
                    onChange={v => handleJob(i, 'jobName', v)}
                    onSelect={p => handlePresetSelectInternal(i, p)}
                  />
                ) : (
                  <input value={job.jobName} onChange={e => handleJob(i, 'jobName', e.target.value)} placeholder="직종명 입력" />
                )}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group"><label>시작일</label><input type="date" max="9999-12-31" value={job.startDate} onChange={e => handleJob(i, 'startDate', e.target.value)} /></div>
              <div className="form-group"><label>종료일</label><input type="date" max="9999-12-31" value={job.endDate} onChange={e => handleJob(i, 'endDate', e.target.value)} /></div>
              <div className="form-group">
                <label>기간 {job.workPeriodOverride ? '(수동)' : '(자동)'}</label>
                {(() => {
                  const auto = formatWorkPeriod(job.startDate, job.endDate);
                  const src = job.workPeriodOverride || auto;
                  const yVal = src.match(/(\d+)\s*년/)?.[1] || '';
                  const mVal = src.match(/(\d+)\s*개월/)?.[1] || '';
                  return (
                    <div className="work-period-editor">
                      <input type="number" min="0" className={`work-period-input ${job.workPeriodOverride ? 'is-overridden' : ''}`} value={yVal}
                        onChange={e => {
                          const y = parseInt(e.target.value) || 0;
                          const m = parseInt(job.workPeriodOverride?.match(/(\d+)\s*개월/)?.[1]) || 0;
                          handleJob(i, 'workPeriodOverride', (y || m) ? `${y}년 ${m}개월` : '');
                        }} />
                      <span>년</span>
                      <input type="number" min="0" max="11" className={`work-period-input ${job.workPeriodOverride ? 'is-overridden' : ''}`} value={mVal}
                        onChange={e => {
                          const m = parseInt(e.target.value) || 0;
                          const y = parseInt(job.workPeriodOverride?.match(/(\d+)\s*년/)?.[1]) || 0;
                          handleJob(i, 'workPeriodOverride', (y || m) ? `${y}년 ${m}개월` : '');
                        }} />
                      <span>개월</span>
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>연간 근무일수</label>
                <input type="number" min="1" max="365" value={job.workDaysPerYear || 250} onChange={e => handleJob(i, 'workDaysPerYear', parseInt(e.target.value) || 250)} />
              </div>
            </div>
          </div>
        ))}
      </section>

    </>
  );
}

export function BasicInfoSidePanel({ shared, onChange }) {
  const handleInput = (field, value) => {
    onChange({ ...shared, [field]: value });
  };

  return (
    <>
      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">3</span>특이사항</h2>
            <p className="section-description">산재 이력이나 현재 상태처럼 참고가 필요한 메모를 남깁니다.</p>
          </div>
        </div>
        <div className="form-group">
          <textarea rows="4" value={shared.specialNotes} onChange={e => handleInput('specialNotes', e.target.value)} placeholder="산재이력, 상병상태 등" />
        </div>
      </section>
      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">4</span>평가기관</h2>
            <p className="section-description">병원과 담당 진료 정보를 함께 기록합니다.</p>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>병원명</label><input value={shared.hospitalName} onChange={e => handleInput('hospitalName', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>진료과</label><input value={shared.department} onChange={e => handleInput('department', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>담당의</label><input value={shared.doctorName} onChange={e => handleInput('doctorName', e.target.value)} /></div>
        </div>
      </section>
    </>
  );
}

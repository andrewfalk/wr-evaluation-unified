import { useRef, useCallback } from 'react';
import { calculateBMI, calculateAge } from '../utils/common';
import { formatWorkPeriod } from '../utils/workPeriod';
import { createSharedJob } from '../utils/data';
import { PresetSearch } from './PresetSearch';

export function BasicInfoForm({
  shared,
  onChange,
  errors,
  refDateField = 'injuryDate',
  refDateLabel = '재해일자',
  presets,
  presetMeta,
  presetError,
  onPresetSelect,
  onSavePreset,
  onBrowsePreset,
  activeModules,
  session,
}) {
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
            <label>환자등록번호</label>
            <input
              value={shared.patientNo || ''}
              onChange={e => handleInput('patientNo', e.target.value)}
              placeholder="등록번호"
            />
          </div>
          <div className="form-group">
            <label>이름 *</label>
            <input value={shared.name} onChange={e => handleInput('name', e.target.value)} />
            {errors?.name && <div className="error-message">{errors.name}</div>}
          </div>
          <div className="form-group">
            <label>성별</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="gender"
                  value="male"
                  checked={shared.gender === 'male'}
                  onChange={e => handleInput('gender', e.target.value)}
                />
                <span>남</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="gender"
                  value="female"
                  checked={shared.gender === 'female'}
                  onChange={e => handleInput('gender', e.target.value)}
                />
                <span>여</span>
              </label>
            </div>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>키(cm)</label>
            <input type="number" value={shared.height} onChange={e => handleInput('height', e.target.value)} />
          </div>
          <div className="form-group">
            <label>몸무게(kg)</label>
            <input type="number" value={shared.weight} onChange={e => handleInput('weight', e.target.value)} />
          </div>
          <div className="form-group">
            <label>BMI</label>
            <input value={bmi || '-'} readOnly />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>생년월일 *</label>
            <input
              type="date"
              max="9999-12-31"
              value={shared.birthDate}
              onChange={e => handleInput('birthDate', e.target.value)}
            />
            {errors?.birthDate && <div className="error-message">{errors.birthDate}</div>}
          </div>
          <div className="form-group">
            <label>{refDateLabel} *</label>
            <input
              type="date"
              max="9999-12-31"
              value={shared[refDateField]}
              onChange={e => handleInput(refDateField, e.target.value)}
            />
            {errors?.[refDateField] && <div className="error-message">{errors[refDateField]}</div>}
          </div>
          <div className="form-group">
            <label>만 나이</label>
            <input value={age ? `${age}세` : '-'} readOnly />
          </div>
        </div>
      </section>

      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">2</span>직업력</h2>
            <p className="section-description">직종, 근무 기간, 연간 근무일수를 기록합니다.</p>
          </div>
          <div className="section-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={addJob}>+ 직종 추가</button>
          </div>
        </div>
        {presetMeta && (
          <div className="preset-meta form-meta-card">
            Preset: {presetMeta.count}개 직종
            {presetError && <span className="form-meta-warning">{presetError}</span>}
          </div>
        )}
        {errors?.jobs && <div className="error-message">{errors.jobs}</div>}
        {jobs.map((job, i) => (
          <div key={job.id} className="job-card">
            <div className="job-card-header">
              <div className="card-title-stack">
                <span className="job-card-title">직력 {i + 1}</span>
                <span className="job-card-subtitle">해당 직무의 기간과 근무 조건을 입력합니다.</span>
              </div>
              <div className="job-card-actions">
                {onSavePreset && <button type="button" className="btn btn-outline btn-xs" onClick={() => onSavePreset(job.id)}>프리셋 저장</button>}
                {onBrowsePreset && <button type="button" className="btn btn-outline btn-xs" onClick={() => onBrowsePreset(job.id)}>프리셋 조회</button>}
                {jobs.length > 1 && <button type="button" className="btn btn-danger btn-xs" onClick={() => removeJob(i)}>삭제</button>}
              </div>
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
                  <input value={job.jobName} onChange={e => handleJob(i, 'jobName', e.target.value)} placeholder="직종명을 입력하세요" />
                )}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>시작일</label>
                <input type="date" max="9999-12-31" value={job.startDate} onChange={e => handleJob(i, 'startDate', e.target.value)} />
              </div>
              <div className="form-group">
                <label>종료일</label>
                <input type="date" max="9999-12-31" value={job.endDate} onChange={e => handleJob(i, 'endDate', e.target.value)} />
              </div>
              <div className="form-group">
                <label>기간 {job.workPeriodOverride ? '(수동)' : '(자동)'}</label>
                {(() => {
                  const auto = formatWorkPeriod(job.startDate, job.endDate);
                  const src = job.workPeriodOverride || auto;
                  const yVal = src.match(/(\d+)\s*년/)?.[1] || '';
                  const mVal = src.match(/(\d+)\s*개월/)?.[1] || '';
                  return (
                    <div className="work-period-editor">
                      <input
                        type="number"
                        min="0"
                        className={`work-period-input ${job.workPeriodOverride ? 'is-overridden' : ''}`}
                        value={yVal}
                        onChange={e => {
                          const y = parseInt(e.target.value, 10) || 0;
                          const m = parseInt(job.workPeriodOverride?.match(/(\d+)\s*개월/)?.[1], 10) || 0;
                          handleJob(i, 'workPeriodOverride', (y || m) ? `${y}년 ${m}개월` : '');
                        }}
                      />
                      <span>년</span>
                      <input
                        type="number"
                        min="0"
                        max="11"
                        className={`work-period-input ${job.workPeriodOverride ? 'is-overridden' : ''}`}
                        value={mVal}
                        onChange={e => {
                          const m = parseInt(e.target.value, 10) || 0;
                          const y = parseInt(job.workPeriodOverride?.match(/(\d+)\s*년/)?.[1], 10) || 0;
                          handleJob(i, 'workPeriodOverride', (y || m) ? `${y}년 ${m}개월` : '');
                        }}
                      />
                      <span>개월</span>
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>연간 근무일수</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={job.workDaysPerYear || 250}
                  onChange={e => handleJob(i, 'workDaysPerYear', parseInt(e.target.value, 10) || 250)}
                />
              </div>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function AutoResizeTextarea({ value, onChange, placeholder, maxHeight = '50vh' }) {
  const ref = useRef(null);
  const handleChange = useCallback((e) => {
    onChange(e);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [onChange]);

  const handleRef = useCallback((el) => {
    ref.current = el;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  return (
    <textarea
      ref={handleRef}
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      rows="2"
      style={{ resize: 'none', maxHeight, overflowY: 'auto' }}
    />
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
            <h2 className="section-title"><span className="section-icon">3</span>EMR 연동 데이터</h2>
            <p className="section-description">진료기록과 기저질환, 수진 이력을 기록합니다.</p>
          </div>
        </div>
        <div className="form-group">
          <label>진료기록 / 타과 회신 요약</label>
          <AutoResizeTextarea
            value={shared.medicalRecord || ''}
            onChange={e => handleInput('medicalRecord', e.target.value)}
            placeholder="외래 기록, 영상 검사, 수술 이력 등을 입력하세요"
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>고혈압</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="highBloodPressure"
                  value="유"
                  checked={shared.highBloodPressure === '유'}
                  onChange={e => handleInput('highBloodPressure', e.target.value)}
                />
                <span>유</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="highBloodPressure"
                  value="무"
                  checked={shared.highBloodPressure === '무'}
                  onChange={e => handleInput('highBloodPressure', e.target.value)}
                />
                <span>무</span>
              </label>
            </div>
          </div>
          <div className="form-group">
            <label>당뇨병</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="diabetes"
                  value="유"
                  checked={shared.diabetes === '유'}
                  onChange={e => handleInput('diabetes', e.target.value)}
                />
                <span>유</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="diabetes"
                  value="무"
                  checked={shared.diabetes === '무'}
                  onChange={e => handleInput('diabetes', e.target.value)}
                />
                <span>무</span>
              </label>
            </div>
          </div>
        </div>
        <div className="form-group">
          <label>수진 이력</label>
          <AutoResizeTextarea
            value={shared.visitHistory || ''}
            onChange={e => handleInput('visitHistory', e.target.value)}
            placeholder="부위별 수진 이력 예: 무릎 부위 2024-01-01 이후 15회"
          />
        </div>
      </section>

      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">4</span>타과 회신</h2>
            <p className="section-description">관련 과별 회신 내용을 기록합니다.</p>
          </div>
        </div>
        <div className="form-group">
          <label>정형외과</label>
          <AutoResizeTextarea
            value={shared.consultReplyOrtho || ''}
            onChange={e => handleInput('consultReplyOrtho', e.target.value)}
            placeholder="정형외과 회신 내용을 입력하세요"
          />
        </div>
        <div className="form-group">
          <label>신경외과</label>
          <AutoResizeTextarea
            value={shared.consultReplyNeuro || ''}
            onChange={e => handleInput('consultReplyNeuro', e.target.value)}
            placeholder="신경외과 회신 내용을 입력하세요"
          />
        </div>
        <div className="form-group">
          <label>재활의학과</label>
          <AutoResizeTextarea
            value={shared.consultReplyRehab || ''}
            onChange={e => handleInput('consultReplyRehab', e.target.value)}
            placeholder="재활의학과 회신 내용을 입력하세요"
          />
        </div>
        <div className="form-group">
          <label>기타</label>
          <AutoResizeTextarea
            value={shared.consultReplyOther || ''}
            onChange={e => handleInput('consultReplyOther', e.target.value)}
            placeholder="기타 과목 회신 내용을 입력하세요"
          />
        </div>
      </section>

      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">5</span>특이사항</h2>
            <p className="section-description">산재 이력이나 현재 상태처럼 참고가 필요한 메모를 남깁니다.</p>
          </div>
        </div>
        <div className="form-group">
          <textarea
            rows="4"
            value={shared.specialNotes}
            onChange={e => handleInput('specialNotes', e.target.value)}
            placeholder="산재 이력, 현재 상태 등을 입력하세요"
          />
        </div>
      </section>

      <section className="section pattern-surface form-section">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">6</span>평가기관</h2>
            <p className="section-description">병원과 담당 진료 정보를 함께 기록합니다.</p>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>병원명</label>
            <input value={shared.hospitalName} onChange={e => handleInput('hospitalName', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>진료과</label>
            <input value={shared.department} onChange={e => handleInput('department', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>담당의</label>
            {session?.mode === 'intranet' ? (
              <>
                <div className="readonly-field">{shared.doctorName || '미배정'}</div>
                <div className="form-hint">인트라넷 모드에서는 관리자 콘솔에서 담당의를 배정합니다.</div>
              </>
            ) : (
              <input value={shared.doctorName} onChange={e => handleInput('doctorName', e.target.value)} />
            )}
          </div>
        </div>
      </section>
    </>
  );
}

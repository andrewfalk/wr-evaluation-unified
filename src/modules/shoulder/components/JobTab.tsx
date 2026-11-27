import type { SharedJob } from '@wr/contracts';
import { createShoulderJobExtras } from '../utils/data';
import { upsertJobExtra } from '../../../core/utils/jobExtras';

type ShoulderHourKey = 'overheadHours' | 'repetitiveMediumHours' | 'repetitiveFastHours' | 'vibrationHours';

/** 직력별 어깨 입력(createShoulderJobExtras의 모양 — JS 팩토리의 추론 타입은 evidenceSources가 never[]라 따로 적는다). */
export interface ShoulderJobExtras extends Record<ShoulderHourKey, string> {
  sharedJobId: string;
  heavyLoadCount: string;
  heavyLoadSeconds: string;
  evidenceSources: unknown[];
}

const GENERIC_FIELDS: Array<{ key: ShoulderHourKey; label: string; unit: string }> = [
  { key: 'overheadHours',        label: '오버헤드/어깨높이 이상 작업', unit: '시간/일' },
  { key: 'repetitiveMediumHours', label: '반복동작 중간속도 (4~14회/분)', unit: '시간/일' },
  { key: 'repetitiveFastHours',  label: '반복동작 고도 (≥15회/분)',     unit: '시간/일' },
  { key: 'vibrationHours',       label: '손-팔 진동 (≥3 m/s²)',        unit: '시간/일' },
];

export interface JobTabProps {
  sharedJobs: Array<Pick<SharedJob, 'id' | 'jobName'>>;
  jobExtras: ShoulderJobExtras[];
  onChange: (extras: ShoulderJobExtras[]) => void;
  errors?: { jobs?: string } | null;
}

export function JobTab({ sharedJobs, jobExtras, onChange, errors }: JobTabProps) {
  const getExtras = (sharedJobId: string) =>
    jobExtras.find(e => e.sharedJobId === sharedJobId);

  const handleExtra = (sharedJobId: string, field: keyof ShoulderJobExtras, value: string) => {
    onChange(upsertJobExtra(jobExtras, sharedJobId, createShoulderJobExtras, { [field]: value } as Partial<ShoulderJobExtras>));
  };

  return (
    <section className="section pattern-surface form-section">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x1F4AA;</span>어깨 신체부담 평가</h2>
          <p className="section-description">각 직종별 일평균 노출 시간을 입력하세요. 누적 기준 비교는 결과 패널에서 바로 확인할 수 있습니다.</p>
        </div>
      </div>
      {errors?.jobs && <div className="error-message">{errors.jobs}</div>}
      {sharedJobs.map((job, i) => {
        const extras = getExtras(job.id) || createShoulderJobExtras(job.id);
        const hasInput = GENERIC_FIELDS.some(f => extras[f.key] !== '' && extras[f.key] !== undefined)
          || extras.heavyLoadCount !== '' || extras.heavyLoadSeconds !== '';

        return (
          <div key={job.id} className="job-card">
            <div className="job-card-header">
              <div className="card-title-stack">
                <span className="job-card-title">직력 {i + 1}: {job.jobName || '(미입력)'}</span>
                <span className="job-meta-line">시간 기반 노출과 중량물 취급 빈도를 함께 기록합니다.</span>
              </div>
              {!hasInput && (
                <span className="job-badge badge-low">미입력</span>
              )}
            </div>
            <div className="exposure-list">

              {GENERIC_FIELDS.map(({ key, label, unit }) => (
                <div key={key} className="exposure-row">
                  <span className="exposure-label">{label}</span>
                  <input
                    className="exposure-input"
                    type="number"
                    value={extras[key] ?? ''}
                    onChange={e => handleExtra(job.id, key, e.target.value)}
                    min="0"
                    step="0.1"
                  />
                  <span className="exposure-unit">{unit}</span>
                </div>
              ))}

              <div className="exposure-row exposure-row-heavy">
                <span className="exposure-label">중량물(≥20kg) 취급</span>
                <span className="exposure-mini-label">횟수</span>
                <input
                  className="exposure-input"
                  type="number"
                  value={extras.heavyLoadCount ?? ''}
                  onChange={e => handleExtra(job.id, 'heavyLoadCount', e.target.value)}
                  min="0"
                  step="1"
                />
                <span className="exposure-unit">회/일</span>
                <span className="exposure-mini-label">시간</span>
                <input
                  className="exposure-input"
                  type="number"
                  value={extras.heavyLoadSeconds ?? ''}
                  onChange={e => handleExtra(job.id, 'heavyLoadSeconds', e.target.value)}
                  min="0"
                  step="1"
                />
                <span className="exposure-unit">초/회</span>
              </div>

            </div>
          </div>
        );
      })}
      {sharedJobs.length === 0 && (
        <div className="evaluation-empty-state">기본정보 탭에서 직종을 추가하세요.</div>
      )}
    </section>
  );
}

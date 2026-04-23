import { useEffect, useMemo } from 'react';
import { ExposureForm } from './components/ExposureForm';
import { CervicalResultPanel } from './components/CervicalResultPanel';
import { syncCervicalModuleData } from './utils/data';

export function CervicalEvaluation({ patient, calc, updateModule }) {
  const shared = patient.data.shared || {};
  const mod = patient.data.module || {};
  const diagnoses = shared.diagnoses || [];
  const sharedJobs = shared.jobs || [];

  const synced = useMemo(() => syncCervicalModuleData(mod, sharedJobs, diagnoses), [mod, sharedJobs, diagnoses]);

  useEffect(() => {
    if (synced.changed) {
      updateModule(() => synced.moduleData);
    }
  }, [synced, updateModule]);

  if (synced.cervicalDiagnoses.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          경추(목)로 분류되는 상병이 없습니다. 진단명 또는 코드에 맞는 경추 상병을 입력하면 이 모듈을 사용할 수 있습니다.
        </div>
      </div>
    );
  }

  if (sharedJobs.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          기본정보에서 직업력을 먼저 입력해 주세요. 경추 모듈은 직업별 노출 평가 구조를 사용합니다.
        </div>
      </div>
    );
  }

  const jobEvaluations = synced.moduleData.jobEvaluations || [];

  const updateDiagnosisEntry = (sharedJobId, diagnosisId, patch) => {
    updateModule(current => {
      const normalized = syncCervicalModuleData(current, sharedJobs, diagnoses).moduleData;
      return {
        ...normalized,
        jobEvaluations: normalized.jobEvaluations.map(jobEvaluation => {
          if (jobEvaluation.sharedJobId !== sharedJobId) return jobEvaluation;
          return {
            ...jobEvaluation,
            diagnosisEntries: jobEvaluation.diagnosisEntries.map(entry => (
              entry.diagnosisId === diagnosisId
                ? { ...entry, ...patch, diagnosisId }
                : entry
            )),
          };
        }),
      };
    });
  };

  return (
    <>
      <div className="panel">
        <section className="section pattern-surface form-section">
          <div className="section-header">
            <div className="section-title-row">
              <h2 className="section-title"><span className="section-icon">&#x1F9E0;</span>직업별 경추 노출 평가</h2>
              <p className="section-description">기본정보에서 입력한 직업 순서대로 경추 관련 상병의 노출 특성을 입력합니다.</p>
            </div>
          </div>

          {jobEvaluations.map((jobEvaluation, index) => {
            const job = sharedJobs.find(item => item.id === jobEvaluation.sharedJobId);
            if (!job) return null;

            return (
              <ExposureForm
                key={job.id}
                job={job}
                jobIndex={index}
                cervicalDiagnoses={synced.cervicalDiagnoses}
                jobEvaluation={jobEvaluation}
                onChangeEntry={updateDiagnosisEntry}
              />
            );
          })}
        </section>
      </div>

      <CervicalResultPanel calc={calc} />
    </>
  );
}

import { useEffect, useMemo } from 'react';
import { ExposureForm } from './components/ExposureForm';
import { ElbowResultPanel } from './components/ElbowResultPanel';
import { createElbowTemporalSequence, syncElbowModuleData } from './utils/data';

export function ElbowEvaluation({ patient, calc, updateModule, errors }) {
  const shared = patient.data.shared || {};
  const mod = patient.data.module || {};
  const diagnoses = shared.diagnoses || [];
  const sharedJobs = shared.jobs || [];

  const synced = useMemo(() => syncElbowModuleData(mod, sharedJobs, diagnoses), [mod, sharedJobs, diagnoses]);

  useEffect(() => {
    if (synced.changed) {
      updateModule(() => synced.moduleData);
    }
  }, [synced, updateModule]);

  const elbowDiagnoses = synced.elbowDiagnoses;
  const temporalSequence = synced.moduleData.temporalSequence || createElbowTemporalSequence();
  const jobEvaluations = synced.moduleData.jobEvaluations || [];

  const updateTemporalSequence = (field, value) => {
    updateModule(current => {
      const normalized = syncElbowModuleData(current, sharedJobs, diagnoses).moduleData;
      return {
        ...normalized,
        temporalSequence: {
          ...createElbowTemporalSequence(),
          ...(normalized.temporalSequence || {}),
          [field]: value,
        },
      };
    });
  };

  const updateDiagnosisEntry = (sharedJobId, diagnosisId, patch) => {
    updateModule(current => {
      const normalized = syncElbowModuleData(current, sharedJobs, diagnoses).moduleData;
      return {
        ...normalized,
        jobEvaluations: normalized.jobEvaluations.map(jobEvaluation => {
          if (jobEvaluation.sharedJobId !== sharedJobId) return jobEvaluation;
          return {
            ...jobEvaluation,
            diagnosisEntries: jobEvaluation.diagnosisEntries.map(entry => {
              if (entry.diagnosisId !== diagnosisId) return entry;
              return {
                ...entry,
                ...patch,
                diagnosisId,
              };
            }),
          };
        }),
      };
    });
  };

  if (elbowDiagnoses.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          팔꿈치로 분류된 상병이 없습니다. 진단명 또는 코드에 맞는 팔꿈치 상병을 입력하면 이 모듈을 활용할 수 있습니다.
        </div>
      </div>
    );
  }

  if (sharedJobs.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          기본정보 탭에서 직업을 먼저 입력하세요. 팔꿈치 평가는 직업별로 정리됩니다.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <section className="section pattern-surface form-section">
          <div className="section-header">
            <div className="section-title-row">
              <h2 className="section-title"><span className="section-icon">&#x1F4AA;</span>직업별 팔꿈치 신체부담 평가</h2>
              <p className="section-description">기본정보에서 입력한 직업 순서대로 팔꿈치 상병의 노출 특성을 정리합니다.</p>
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
                elbowDiagnoses={elbowDiagnoses}
                jobEvaluation={jobEvaluation}
                errors={errors}
                onChangeEntry={updateDiagnosisEntry}
              />
            );
          })}
        </section>
      </div>
      <ElbowResultPanel
        calc={calc}
        temporalSequence={temporalSequence}
        onTemporalChange={updateTemporalSequence}
      />
    </>
  );
}

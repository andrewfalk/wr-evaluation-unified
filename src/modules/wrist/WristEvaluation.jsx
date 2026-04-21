import { useEffect, useMemo } from 'react';
import { ExposureForm } from './components/ExposureForm';
import { WristResultPanel } from './components/WristResultPanel';
import { syncWristModuleData } from './utils/data';

export function WristEvaluation({ patient, calc, updateModule }) {
  const shared = patient.data.shared || {};
  const mod = patient.data.module || {};
  const diagnoses = shared.diagnoses || [];
  const sharedJobs = shared.jobs || [];

  const synced = useMemo(() => syncWristModuleData(mod, sharedJobs, diagnoses), [mod, sharedJobs, diagnoses]);

  useEffect(() => {
    if (synced.changed) {
      updateModule(() => synced.moduleData);
    }
  }, [synced, updateModule]);

  if (synced.wristDiagnoses.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          손목/손가락으로 분류되는 상병이 없습니다. 진단명 또는 코드에 맞는 손목/손가락 상병을 입력하면 이 모듈을 활용할 수 있습니다.
        </div>
      </div>
    );
  }

  if (sharedJobs.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          기본정보에서 직업력을 먼저 입력해 주세요. 손목 모듈은 직업별 노출 평가 구조를 사용합니다.
        </div>
      </div>
    );
  }

  const temporalSequence = synced.moduleData.temporalSequence;
  const jobEvaluations = synced.moduleData.jobEvaluations || [];

  const updateTemporalSequence = (field, value) => {
    updateModule(current => {
      const normalized = syncWristModuleData(current, sharedJobs, diagnoses).moduleData;
      return {
        ...normalized,
        temporalSequence: {
          ...normalized.temporalSequence,
          [field]: value,
        },
      };
    });
  };

  const updateDiagnosisEntry = (sharedJobId, diagnosisId, patch) => {
    updateModule(current => {
      const normalized = syncWristModuleData(current, sharedJobs, diagnoses).moduleData;
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

  return (
    <>
      <div className="panel">
        <section className="section pattern-surface form-section">
          <div className="section-header">
            <div className="section-title-row">
              <h2 className="section-title"><span className="section-icon">&#x270B;</span>직업별 손목/손가락 노출평가</h2>
              <p className="section-description">기본정보에서 입력한 직업 순서대로 손목 관련 상병의 노출 특성을 입력합니다.</p>
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
                wristDiagnoses={synced.wristDiagnoses}
                jobEvaluation={jobEvaluation}
                errors={null}
                onChangeEntry={updateDiagnosisEntry}
              />
            );
          })}
        </section>
      </div>

      <WristResultPanel
        calc={calc}
        temporalSequence={temporalSequence}
        onTemporalChange={updateTemporalSequence}
      />
    </>
  );
}

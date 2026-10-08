import { useEffect } from 'react';
import { JobTab } from './components/JobTab';
import { ShoulderResultPanel } from './components/ShoulderResultPanel';
import { createShoulderJobExtras } from './utils/data';
import { NoEvaluableJobsNotice } from '../../core/components/NoEvaluableJobsNotice';
import { filterAnalysisJobs, hasNoEvaluableJobs } from '@analytics-core/jobScope';

export function ShoulderEvaluation({ patient, calc, activeTab, updateModule, errors }) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const sharedJobs = shared.jobs || [];
  // 화면에는 "신체부담평가 미포함" 직력을 보이지 않는다(jobExtras 자동 생성은 전체 직력 기준 유지).
  const evaluatedJobs = filterAnalysisJobs(sharedJobs);

  // 누락된 직업의 jobExtras 자동 생성
  useEffect(() => {
    const extras = mod.jobExtras || [];
    const missing = sharedJobs.filter(j => !extras.find(e => e.sharedJobId === j.id));
    if (missing.length > 0) {
      updateModule(m => ({
        ...m,
        jobExtras: [...(m.jobExtras || []), ...missing.map(j => createShoulderJobExtras(j.id))]
      }));
    }
  }, [sharedJobs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleJobExtrasChange = (newExtras) => {
    updateModule(m => ({ ...m, jobExtras: newExtras }));
  };

  return (
    <>
      <div className="panel">
        {hasNoEvaluableJobs(sharedJobs) ? (
          <NoEvaluableJobsNotice />
        ) : (
          <JobTab
            sharedJobs={evaluatedJobs}
            jobExtras={mod.jobExtras || []}
            onChange={handleJobExtrasChange}
            errors={errors}
          />
        )}
      </div>
      <ShoulderResultPanel calc={calc} />
    </>
  );
}

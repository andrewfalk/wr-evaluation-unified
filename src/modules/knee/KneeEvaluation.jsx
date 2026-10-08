import { useEffect } from 'react';
import { JobTab } from './components/JobTab';
import { KneeResultPanel } from './components/KneeResultPanel';
import { createKneeJobExtras } from './utils/data';
import { NoEvaluableJobsNotice } from '../../core/components/NoEvaluableJobsNotice';
import { filterAnalysisJobs, hasNoEvaluableJobs } from '@analytics-core/jobScope';

export function KneeEvaluation({ patient, calc, activeTab, updateModule, errors }) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const sharedJobs = shared.jobs || [];
  // 화면에는 "신체부담평가 미포함" 직력을 보이지 않는다. 아래 jobExtras 자동 생성은 전체 직력 기준으로 두어
  // 미포함 직력의 입력값을 유지한다(다시 '포함'으로 바꾸면 그대로 돌아와야 함).
  const evaluatedJobs = filterAnalysisJobs(sharedJobs);

  // 누락된 직업의 jobExtras 자동 생성
  useEffect(() => {
    const extras = mod.jobExtras || [];
    const missing = sharedJobs.filter(j => !extras.find(e => e.sharedJobId === j.id));
    if (missing.length > 0) {
      updateModule(m => ({
        ...m,
        jobExtras: [...(m.jobExtras || []), ...missing.map(j => createKneeJobExtras(j.id))]
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
      <KneeResultPanel calc={calc} />
    </>
  );
}

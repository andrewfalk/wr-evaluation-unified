import { useEffect } from 'react';
import { JobTab } from './components/JobTab';
import { ShoulderResultPanel } from './components/ShoulderResultPanel';
import { createShoulderJobExtras } from './utils/data';

export function ShoulderEvaluation({ patient, calc, activeTab, updateModule, errors }) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const sharedJobs = shared.jobs || [];

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
        <JobTab
          sharedJobs={sharedJobs}
          jobExtras={mod.jobExtras || []}
          onChange={handleJobExtrasChange}
          errors={errors}
        />
      </div>
      <ShoulderResultPanel calc={calc} />
    </>
  );
}

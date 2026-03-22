import { JobTab } from './components/JobTab';
import { KneeResultPanel } from './components/KneeResultPanel';

export function KneeEvaluation({ patient, calc, activeTab, updateModule, errors }) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const sharedJobs = shared.jobs || [];

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
      <KneeResultPanel calc={calc} />
    </>
  );
}

// 무릎·어깨 평가 화면의 공통 틀(REFACTORING_ROADMAP Phase 2 C8, P2-68b) — 두 모듈의 Evaluation은 이름·주석만 다른
// 같은 코드였다. 모듈의 Evaluation은 자기 createJobExtras·JobTab·ResultPanel을 넘기는 얇은 래퍼로 남는다(래퍼가 자기
// ./components/JobTab을 import해 넘기므로 테스트의 vi.mock 경로가 그대로 듣는다).
import { useEffect } from 'react';
import type { ComponentType } from 'react';
import type { SharedJob } from '@wr/contracts';
import { NoEvaluableJobsNotice } from '../../core/components/NoEvaluableJobsNotice';
import { filterAnalysisJobs, hasNoEvaluableJobs } from '@wr/analytics-core/jobScope';

export interface JobExtrasModuleData<T> {
  jobExtras?: T[];
  [field: string]: unknown;
}

export type JobExtrasJob = Pick<SharedJob, 'id' | 'jobName'>;
export type JobExtrasErrors = { jobs?: string } | null;

export interface JobExtrasJobTabProps<T> {
  sharedJobs: JobExtrasJob[];
  jobExtras: T[];
  onChange: (extras: T[]) => void;
  errors?: JobExtrasErrors;
}

export interface JobExtrasEvaluationProps<T extends { sharedJobId: string }> {
  patient: { data: { shared: { jobs?: JobExtrasJob[] }; module: JobExtrasModuleData<T> } };
  calc: unknown;
  updateModule: (updater: (m: JobExtrasModuleData<T>) => JobExtrasModuleData<T>) => void;
  errors?: JobExtrasErrors;
  createJobExtras: (sharedJobId: string) => T;
  JobTab: ComponentType<JobExtrasJobTabProps<T>>;
  ResultPanel: ComponentType<{ calc: unknown }>;
}

export function JobExtrasEvaluation<T extends { sharedJobId: string }>({
  patient, calc, updateModule, errors, createJobExtras, JobTab, ResultPanel,
}: JobExtrasEvaluationProps<T>) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const sharedJobs = shared.jobs || [];
  // 화면에는 "신체부담평가 미포함" 직력을 보이지 않는다. 아래 jobExtras 자동 생성은 전체 직력 기준으로 두어
  // 미포함 직력의 입력값을 유지한다(다시 '포함'으로 바꾸면 그대로 돌아와야 함).
  const evaluatedJobs = filterAnalysisJobs(sharedJobs);

  // 누락된 직업의 jobExtras 자동 생성 — 직력 수가 바뀔 때만 돈다(의존 배열을 채우면 매 렌더 실행 횟수가 바뀐다).
  useEffect(() => {
    const extras = mod.jobExtras || [];
    const missing = sharedJobs.filter(j => !extras.find(e => e.sharedJobId === j.id));
    if (missing.length > 0) {
      updateModule(m => ({
        ...m,
        jobExtras: [...(m.jobExtras || []), ...missing.map(j => createJobExtras(j.id))]
      }));
    }
  }, [sharedJobs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleJobExtrasChange = (newExtras: T[]) => {
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
      <ResultPanel calc={calc} />
    </>
  );
}

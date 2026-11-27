// 어깨 평가 화면 — 공통 틀(_shared/JobExtrasEvaluation, P2-68b)에 이 모듈의 extras 팩토리·JobTab·결과 패널을 넘기는 얇은 래퍼.
// JobTab·결과 패널을 여기서 import해 넘기므로 테스트의 vi.mock('./components/JobTab') 경로가 그대로 듣는다.
import type { ComponentType } from 'react';
import { JobExtrasEvaluation } from '../_shared/JobExtrasEvaluation';
import type { JobExtrasEvaluationProps } from '../_shared/JobExtrasEvaluation';
import { JobTab } from './components/JobTab';
import type { ShoulderJobExtras } from './components/JobTab';
import { ShoulderResultPanel } from './components/ShoulderResultPanel';
import { createShoulderJobExtras } from './utils/data';

export type ShoulderEvaluationProps = Pick<JobExtrasEvaluationProps<ShoulderJobExtras>, 'patient' | 'calc' | 'updateModule' | 'errors'> & {
  activeTab?: string;
};

export function ShoulderEvaluation({ patient, calc, updateModule, errors }: ShoulderEvaluationProps) {
  return (
    <JobExtrasEvaluation
      patient={patient}
      calc={calc}
      updateModule={updateModule}
      errors={errors}
      createJobExtras={createShoulderJobExtras}
      JobTab={JobTab}
      ResultPanel={ShoulderResultPanel as ComponentType<{ calc: unknown }>}
    />
  );
}

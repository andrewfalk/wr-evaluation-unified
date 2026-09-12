export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { JOB_METADATA } from './metadata';
import {
  extractJobIdentityJobNameNormalized,
  extractJobIdentityTenureYears,
  extractJobRollupLongestTenureJobNameNormalized,
} from './extractors';

registerAnalyticsModule({
  moduleId: 'job',
  metadata: JOB_METADATA,
  extractors: {
    'job.identity.jobNameNormalized': extractJobIdentityJobNameNormalized,
    'job.identity.tenureYears': extractJobIdentityTenureYears,
    'job.rollup.longestTenureJobNameNormalized': extractJobRollupLongestTenureJobNameNormalized,
  },
  // 'job'은 실제 UI 모듈이 아니라 shared.jobs[] 자체를 가리키는 pseudo-moduleId다 — 어떤
  // patient의 activeModules에도 'job'이 들어가지 않으므로 completion.ts의
  // verifyAllModulesComplete()(활성 모듈만 순회)가 이 항목을 절대 호출하지 않는다.
  // isComplete가 형식상 필요해서 만드는 자리표시자일 뿐 실제로 실행되지 않는다.
  isComplete: () => true,
});

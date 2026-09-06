// derived.ts가 constants.ts/legacyNormalize.ts를 이미 재export하므로 여기서 또 겹쳐
// export하지 않는다(중복 `export *`는 이름이 모호해져 소비자가 어느 쪽인지 알 수 없다).
export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { ELBOW_METADATA } from './metadata';
import { extractElbowBurdenGradeMax } from './extractors';
import { isElbowAssessmentComplete } from './derived';

registerAnalyticsModule({
  moduleId: 'elbow',
  metadata: ELBOW_METADATA,
  extractors: {
    'elbow.assessment.burdenGradeMax': extractElbowBurdenGradeMax,
  },
  isComplete: isElbowAssessmentComplete,
});

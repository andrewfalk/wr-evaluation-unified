export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { KNEE_METADATA } from './metadata';
import {
  extractKneeRelatednessMax,
  extractKneeDiagnosisSideKlGrade,
  extractKneeDiagnosisSideConfirmedStatus,
  extractKneeDiagnosisSideAppliedConfirmedMismatch,
} from './extractors';
import { isKneeAssessmentComplete } from './derived';

registerAnalyticsModule({
  moduleId: 'knee',
  metadata: KNEE_METADATA,
  extractors: {
    'knee.relatedness.max': extractKneeRelatednessMax,
    'knee.diagnosisSide.klGrade': extractKneeDiagnosisSideKlGrade,
    'knee.diagnosisSide.confirmedStatus': extractKneeDiagnosisSideConfirmedStatus,
    'knee.diagnosisSide.appliedConfirmedMismatch': extractKneeDiagnosisSideAppliedConfirmedMismatch,
  },
  isComplete: isKneeAssessmentComplete,
});

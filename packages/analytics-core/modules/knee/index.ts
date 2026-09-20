export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { KNEE_METADATA } from './metadata';
import {
  extractKneeRelatednessMax,
  extractKneeDiagnosisSideKlGrade,
  extractKneeDiagnosisSideConfirmedStatus,
  extractKneeJobWeight,
  extractKneeJobSquatting,
  extractKneeJobStairs,
  extractKneeJobKneeTwist,
  extractKneeJobStartStop,
  extractKneeJobTightSpace,
  extractKneeJobKneeContact,
  extractKneeJobJumpDown,
} from './extractors';
import { isKneeAssessmentComplete } from './derived';

registerAnalyticsModule({
  moduleId: 'knee',
  metadata: KNEE_METADATA,
  extractors: {
    'knee.relatedness.max': extractKneeRelatednessMax,
    'knee.diagnosisSide.klGrade': extractKneeDiagnosisSideKlGrade,
    'knee.diagnosisSide.confirmedStatus': extractKneeDiagnosisSideConfirmedStatus,
    'knee.job.dailyLoadKg': extractKneeJobWeight,
    'knee.job.squattingMinutesPerDay': extractKneeJobSquatting,
    'knee.job.stairs': extractKneeJobStairs,
    'knee.job.kneeTwist': extractKneeJobKneeTwist,
    'knee.job.startStop': extractKneeJobStartStop,
    'knee.job.tightSpace': extractKneeJobTightSpace,
    'knee.job.kneeContact': extractKneeJobKneeContact,
    'knee.job.jumpDown': extractKneeJobJumpDown,
  },
  isComplete: isKneeAssessmentComplete,
});

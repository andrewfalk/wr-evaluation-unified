export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { SHOULDER_METADATA } from './metadata';
import {
  extractShoulderExposureAnyExceeded,
  extractShoulderDiagnosisSideEllmanClass,
  extractShoulderJobOverheadHours,
  extractShoulderJobRepetitiveMediumHours,
  extractShoulderJobRepetitiveFastHours,
  extractShoulderJobHeavyLoadCount,
  extractShoulderJobHeavyLoadSeconds,
  extractShoulderJobVibrationHours,
} from './extractors';
import { isShoulderAssessmentComplete } from './derived';

registerAnalyticsModule({
  moduleId: 'shoulder',
  metadata: SHOULDER_METADATA,
  extractors: {
    'shoulder.exposure.anyExceeded': extractShoulderExposureAnyExceeded,
    'shoulder.diagnosisSide.ellmanClass': extractShoulderDiagnosisSideEllmanClass,
    'shoulder.job.overheadHours': extractShoulderJobOverheadHours,
    'shoulder.job.repetitiveMediumHours': extractShoulderJobRepetitiveMediumHours,
    'shoulder.job.repetitiveFastHours': extractShoulderJobRepetitiveFastHours,
    'shoulder.job.heavyLoadCount': extractShoulderJobHeavyLoadCount,
    'shoulder.job.heavyLoadSeconds': extractShoulderJobHeavyLoadSeconds,
    'shoulder.job.vibrationHours': extractShoulderJobVibrationHours,
  },
  isComplete: isShoulderAssessmentComplete,
});

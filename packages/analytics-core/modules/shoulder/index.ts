export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { SHOULDER_METADATA } from './metadata';
import { extractShoulderExposureAnyExceeded, extractShoulderDiagnosisSideEllmanClass } from './extractors';
import { isShoulderAssessmentComplete } from './derived';

registerAnalyticsModule({
  moduleId: 'shoulder',
  metadata: SHOULDER_METADATA,
  extractors: {
    'shoulder.exposure.anyExceeded': extractShoulderExposureAnyExceeded,
    'shoulder.diagnosisSide.ellmanClass': extractShoulderDiagnosisSideEllmanClass,
  },
  isComplete: isShoulderAssessmentComplete,
});

// derived.ts가 constants.ts/mddm.ts/vibration.ts를 이미 재export하므로 여기서 또 겹쳐
// export하지 않는다(중복 `export *`는 이름이 모호해져 소비자가 어느 쪽인지 알 수 없다).
export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { SPINE_METADATA } from './metadata';
import { extractSpineMddmLifetimeDoseMNh, extractSpineVibrationDvMax } from './extractors';
import { isSpineAssessmentComplete } from './derived';

registerAnalyticsModule({
  moduleId: 'spine',
  metadata: SPINE_METADATA,
  extractors: {
    'spine.mddm.lifetimeDoseMNh': extractSpineMddmLifetimeDoseMNh,
    'spine.vibration.dvMax': extractSpineVibrationDvMax,
  },
  isComplete: isSpineAssessmentComplete,
});

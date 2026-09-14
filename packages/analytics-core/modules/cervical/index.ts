// derived.ts가 legacyNormalize.ts를 이미 재export하므로 여기서 또 겹쳐 export하지 않는다
// (중복 `export *`는 이름이 모호해져 소비자가 어느 쪽인지 알 수 없다).
export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { CERVICAL_METADATA } from './metadata';
import {
  extractCervicalCaseMaxJobCumulativeKgHours,
  extractCervicalTaskName,
  extractCervicalTaskExposureTypeShoulderHeavyLoad,
  extractCervicalTaskExposureTypeAwkwardStaticNeckLoad,
  extractCervicalTaskLoadWeightKg,
  extractCervicalTaskCarryHoursPerShift,
  extractCervicalTaskForcedNeckPosture,
  extractCervicalTaskNeckNonneutralHoursPerDay,
  extractCervicalTaskCombinedFlexionRotationPosture,
  extractCervicalTaskPrecisionWork,
} from './extractors';
import { isCervicalAssessmentComplete } from './derived';

registerAnalyticsModule({
  moduleId: 'cervical',
  metadata: CERVICAL_METADATA,
  extractors: {
    'cervical.case.maxJobCumulativeKgHours': extractCervicalCaseMaxJobCumulativeKgHours,
    'cervical.task.name': extractCervicalTaskName,
    'cervical.task.exposureType.shoulderHeavyLoad': extractCervicalTaskExposureTypeShoulderHeavyLoad,
    'cervical.task.exposureType.awkwardStaticNeckLoad': extractCervicalTaskExposureTypeAwkwardStaticNeckLoad,
    'cervical.task.loadWeightKg': extractCervicalTaskLoadWeightKg,
    'cervical.task.carryHoursPerShift': extractCervicalTaskCarryHoursPerShift,
    'cervical.task.forcedNeckPosture': extractCervicalTaskForcedNeckPosture,
    'cervical.task.neckNonneutralHoursPerDay': extractCervicalTaskNeckNonneutralHoursPerDay,
    'cervical.task.combinedFlexionRotationPosture': extractCervicalTaskCombinedFlexionRotationPosture,
    'cervical.task.precisionWork': extractCervicalTaskPrecisionWork,
  },
  isComplete: isCervicalAssessmentComplete,
});

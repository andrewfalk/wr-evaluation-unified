export * from './derived';
export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { KNEE_METADATA } from './metadata';
import { extractKneeRelatednessMax } from './extractors';

registerAnalyticsModule({
  moduleId: 'knee',
  metadata: KNEE_METADATA,
  extractors: {
    'knee.relatedness.max': extractKneeRelatednessMax,
  },
});

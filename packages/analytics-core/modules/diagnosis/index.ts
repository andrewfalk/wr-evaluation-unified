export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { DIAGNOSIS_METADATA } from './metadata';
import { extractDiagnosisIdentityModuleGroup } from './extractors';

registerAnalyticsModule({
  moduleId: 'diagnosis',
  metadata: DIAGNOSIS_METADATA,
  extractors: {
    'diagnosis.identity.moduleGroup': extractDiagnosisIdentityModuleGroup,
  },
  // 'diagnosis'는 job과 마찬가지로 실제 UI 모듈이 아니라 shared.diagnoses[] 자체를
  // 가리키는 pseudo-moduleId다 — 어떤 patient의 activeModules에도 'diagnosis'가 들어가지
  // 않으므로 completion.ts의 verifyAllModulesComplete()가 이 항목을 절대 호출하지 않는다.
  isComplete: () => true,
});

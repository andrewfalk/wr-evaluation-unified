export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { DIAGNOSIS_METADATA } from './metadata';
import {
  extractDiagnosisIdentityModuleGroup,
  extractDiagnosisIdentityCode,
  extractDiagnosisIdentityName,
  extractDiagnosisAssessmentStatus,
  extractDiagnosisAssessmentLowReasonUnrelated,
  extractDiagnosisAssessmentLowReasonUnconfirmed,
  extractDiagnosisAssessmentLowReasonAgeMild,
  extractDiagnosisAssessmentLowReasonDelayed,
  extractDiagnosisAssessmentLowReasonLowBurden,
  extractDiagnosisAssessmentLowReasonBelowThreshold,
  extractDiagnosisAssessmentLowReasonOther,
  extractDiagnosisRollupAnyHighRelatedness,
  extractDiagnosisRollupHasKnee,
  extractDiagnosisRollupHasWrist,
  extractDiagnosisRollupHasElbow,
  extractDiagnosisRollupHasShoulder,
  extractDiagnosisRollupHasSpine,
  extractDiagnosisRollupHasCervical,
} from './extractors';

registerAnalyticsModule({
  moduleId: 'diagnosis',
  metadata: DIAGNOSIS_METADATA,
  extractors: {
    'diagnosis.identity.moduleGroup': extractDiagnosisIdentityModuleGroup,
    'diagnosis.identity.code': extractDiagnosisIdentityCode,
    'diagnosis.identity.name': extractDiagnosisIdentityName,
    'diagnosis.assessment.status': extractDiagnosisAssessmentStatus,
    'diagnosis.assessment.lowReason.unrelated': extractDiagnosisAssessmentLowReasonUnrelated,
    'diagnosis.assessment.lowReason.unconfirmed': extractDiagnosisAssessmentLowReasonUnconfirmed,
    'diagnosis.assessment.lowReason.ageMild': extractDiagnosisAssessmentLowReasonAgeMild,
    'diagnosis.assessment.lowReason.delayed': extractDiagnosisAssessmentLowReasonDelayed,
    'diagnosis.assessment.lowReason.lowBurden': extractDiagnosisAssessmentLowReasonLowBurden,
    'diagnosis.assessment.lowReason.belowThreshold': extractDiagnosisAssessmentLowReasonBelowThreshold,
    'diagnosis.assessment.lowReason.other': extractDiagnosisAssessmentLowReasonOther,
    'diagnosis.rollup.anyHighRelatedness': extractDiagnosisRollupAnyHighRelatedness,
    'diagnosis.rollup.hasKnee': extractDiagnosisRollupHasKnee,
    'diagnosis.rollup.hasWrist': extractDiagnosisRollupHasWrist,
    'diagnosis.rollup.hasElbow': extractDiagnosisRollupHasElbow,
    'diagnosis.rollup.hasShoulder': extractDiagnosisRollupHasShoulder,
    'diagnosis.rollup.hasSpine': extractDiagnosisRollupHasSpine,
    'diagnosis.rollup.hasCervical': extractDiagnosisRollupHasCervical,
  },
  // 'diagnosis'는 job과 마찬가지로 실제 UI 모듈이 아니라 shared.diagnoses[] 자체를
  // 가리키는 pseudo-moduleId다 — 어떤 patient의 activeModules에도 'diagnosis'가 들어가지
  // 않으므로 completion.ts의 verifyAllModulesComplete()가 이 항목을 절대 호출하지 않는다.
  isComplete: () => true,
});

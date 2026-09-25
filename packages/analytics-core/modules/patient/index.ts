export * from './extractors';
export * from './metadata';

import { registerAnalyticsModule } from '../../analyticsRegistry';
import { PATIENT_METADATA } from './metadata';
import {
  extractPatientIdentityGender,
  extractPatientIdentityHeightCm,
  extractPatientIdentityWeightKg,
  extractPatientIdentityBirthDate,
  extractPatientIdentityInjuryDate,
  extractPatientIdentityEvaluationDate,
  extractPatientIdentityHighBloodPressure,
  extractPatientIdentityDiabetes,
  extractPatientIdentityBmi,
  extractPatientIdentityAgeAtEvaluation,
} from './extractors';

registerAnalyticsModule({
  moduleId: 'patient',
  metadata: PATIENT_METADATA,
  extractors: {
    'patient.identity.gender': extractPatientIdentityGender,
    'patient.identity.heightCm': extractPatientIdentityHeightCm,
    'patient.identity.weightKg': extractPatientIdentityWeightKg,
    'patient.identity.birthDate': extractPatientIdentityBirthDate,
    'patient.identity.injuryDate': extractPatientIdentityInjuryDate,
    'patient.identity.evaluationDate': extractPatientIdentityEvaluationDate,
    'patient.identity.highBloodPressure': extractPatientIdentityHighBloodPressure,
    'patient.identity.diabetes': extractPatientIdentityDiabetes,
    'patient.identity.bmi': extractPatientIdentityBmi,
    'patient.identity.ageAtEvaluation': extractPatientIdentityAgeAtEvaluation,
  },
  // job과 동일한 이유 — 'patient'는 실제 UI 모듈이 아니라 shared.* 인적사항 자체를
  // 가리키는 pseudo-moduleId다. 어떤 patient의 activeModules에도 'patient'가 들어가지
  // 않으므로 completion.ts의 verifyAllModulesComplete()가 이 항목을 호출하지 않는다.
  isComplete: () => true,
});

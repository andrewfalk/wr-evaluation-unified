// PR0-B3 Part C — diagnosis는 job과 마찬가지로 어떤 임상 모듈에도 속하지 않는 공유 개념
// (shared.diagnoses[])이라 pseudo-moduleId('diagnosis')를 쓴다. §5.5 ④ "신청상병 부위군"은
// diagnosisMapping.ts의 요추 정규식 빈 대안 버그(2026-09-12 수정)에 직접 의존하므로, 그
// 버그를 고치기 전에는 신뢰할 수 있는 통계 변수로 낼 수 없었다.

export type { AnalyticsVariableMetadata } from '../../types';
import type { AnalyticsVariableMetadata } from '../../types';

// statsOrdinalOrder.ts가 재사용 — 부위군은 값 자체에 의학적 순서가 없지만(명목형),
// 이변량 방법(chi_square/fisher_exact 등)이 groupPairsByLevel()로 값을 순회하려면 고정
// 순서 선언이 필요하다(server/src/statsBivariateRoles.ts의 resolveLevelOrder — categorical
// 타입은 선언된 순서가 없으면 null을 반환해 어떤 이변량 방법도 못 쓴다). 순서 자체의
// 의미는 없고 결정성만 필요하므로 MODULE_LABELS(diagnosisMapping.ts) 선언 순서를 그대로 쓴다.
export const DIAGNOSIS_MODULE_GROUP_ORDER = ['knee', 'wrist', 'elbow', 'shoulder', 'spine', 'cervical'] as const;

export const DIAGNOSIS_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'diagnosis.identity.moduleGroup',
    label: '신청상병 부위군',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'diagnosis_side',
    type: 'categorical',
    provenance: 'derived',
    dependsOn: [
      'shared.diagnoses[].id',
      'shared.diagnoses[].code',
      'shared.diagnoses[].name',
      'shared.diagnoses[].moduleId',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_module_group',
    supportedFormulaPolicies: [],
  },
];

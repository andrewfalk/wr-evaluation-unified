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
    grain: 'disease',
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

  // PR0-B4 Slice 6 — coverage 잔여 필드(매핑표 §1 shared.diagnoses[]).
  {
    key: 'diagnosis.identity.code',
    label: '신청상병 코드',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'disease',
    type: 'high_cardinality',
    provenance: 'raw',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].code'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_identity_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'diagnosis.identity.name',
    label: '신청상병명',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'disease',
    type: 'high_cardinality',
    provenance: 'raw',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].name'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_identity_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'diagnosis.assessment.status',
    label: '업무관련성',
    group: '신청상병 · 판정',
    moduleId: 'diagnosis',
    grain: 'disease',
    type: 'categorical',
    provenance: 'clinician_judgment',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].side', 'shared.diagnoses[].assessmentRight', 'shared.diagnoses[].assessmentLeft'],
    availableAt: 'post_decision',
    shownToAssessor: true,
    // PR4-B2 — 예측 outcome(disease grain, 계획서 §0단계/§2단계 PREDICTION_OUTCOME_SPECS
    // — 허용값 high/low). post_decision이지만 outcome 자체는 availableAt 재검사
    // 대상이 아니다(predictor만 재검사 — 판정 이전 정보만 입력으로 허용하는 게 목적).
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'outcome',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_assessment_status',
    supportedFormulaPolicies: [],
  },

  // case grain 롤업 — "업무관련성" 판정을 mode가 아니라 any로 case에 올린다(계획서
  // "Case-grain 롤업 변수 3종 추가" 절). dependsOn은 diagnosis.assessment.status보다
  // 완전하다 — resolveAssessmentSide가 실제로 moduleId/code/name/activeModules를
  // 읽으므로(축성 진단은 side와 무관하게 항상 Right 슬롯) 이 신규 변수는 그 의존성을
  // 정확히 선언한다.
  {
    key: 'diagnosis.rollup.anyHighRelatedness',
    label: '업무관련성 높음 상병 포함 여부',
    group: '신청상병 · 판정',
    moduleId: 'diagnosis',
    grain: 'case',
    type: 'boolean',
    provenance: 'clinician_judgment',
    dependsOn: [
      'shared.diagnoses[].id',
      'shared.diagnoses[].side',
      'shared.diagnoses[].assessmentRight',
      'shared.diagnoses[].assessmentLeft',
      'shared.diagnoses[].moduleId',
      'shared.diagnoses[].code',
      'shared.diagnoses[].name',
      'activeModules',
    ],
    availableAt: 'post_decision',
    shownToAssessor: true,
    // PR4-B2 — 예측 outcome(case grain).
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'outcome',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_rollup_any_high_relatedness',
    supportedFormulaPolicies: [],
  },

  // case grain 롤업 — "신청상병 부위군"을 단일 categorical mode가 아니라 부위 6개
  // 각각의 독립 boolean으로 올린다(계획서 동일 절). dependsOn은 moduleGroup과 동일 —
  // 같은 판정(resolveDiagnosisModule(diag, []))을 재사용하기 때문.
  {
    key: 'diagnosis.rollup.hasKnee',
    label: '무릎 상병 포함 여부',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].code', 'shared.diagnoses[].name', 'shared.diagnoses[].moduleId'],
    availableAt: 'assessment',
    shownToAssessor: true,
    // PR4-B2 — 공통 predictor(계획서 §0단계 허용표). derived predictor 검토목록 등재.
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_rollup_has_knee',
    supportedFormulaPolicies: [],
  },
  {
    key: 'diagnosis.rollup.hasWrist',
    label: '손목/손가락 상병 포함 여부',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].code', 'shared.diagnoses[].name', 'shared.diagnoses[].moduleId'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_rollup_has_wrist',
    supportedFormulaPolicies: [],
  },
  {
    key: 'diagnosis.rollup.hasElbow',
    label: '팔꿈치 상병 포함 여부',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].code', 'shared.diagnoses[].name', 'shared.diagnoses[].moduleId'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_rollup_has_elbow',
    supportedFormulaPolicies: [],
  },
  {
    key: 'diagnosis.rollup.hasShoulder',
    label: '어깨 상병 포함 여부',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].code', 'shared.diagnoses[].name', 'shared.diagnoses[].moduleId'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_rollup_has_shoulder',
    supportedFormulaPolicies: [],
  },
  {
    key: 'diagnosis.rollup.hasSpine',
    label: '요추(허리) 상병 포함 여부',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].code', 'shared.diagnoses[].name', 'shared.diagnoses[].moduleId'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_rollup_has_spine',
    supportedFormulaPolicies: [],
  },
  {
    key: 'diagnosis.rollup.hasCervical',
    label: '경추(목) 상병 포함 여부',
    group: '신청상병 · 공통',
    moduleId: 'diagnosis',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    dependsOn: ['shared.diagnoses[].id', 'shared.diagnoses[].code', 'shared.diagnoses[].name', 'shared.diagnoses[].moduleId'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_rollup_has_cervical',
    supportedFormulaPolicies: [],
  },
];

// §매핑표 확정 — 낮음 사유 7개 옵션(AssessmentTab.jsx LOW_REASON_OPTIONS와 값 동일).
// 옵션별 boolean 키로 분해한다(다중선택 계약). assessment!=='low'면 배열 내용과 무관하게
// not_applicable — extractDiagnosisAssessmentLowReasonOption(extractors.ts)이 강제한다.
const LOW_REASON_METADATA_ENTRIES: Array<[key: string, label: string]> = [
  ['unrelated', '신체부담과 관련없는 상병'],
  ['unconfirmed', '상병 미확인'],
  ['ageMild', '연령대비 경미'],
  ['delayed', '업무중단 후 상당기간 경과'],
  ['lowBurden', '누적 신체부담 낮음'],
  ['belowThreshold', '부담 정도가 최소 문턱값을 넘지 못함'],
  ['other', '기타'],
];

for (const [optionKey, label] of LOW_REASON_METADATA_ENTRIES) {
  DIAGNOSIS_METADATA.push({
    key: `diagnosis.assessment.lowReason.${optionKey}`,
    label: `업무관련성 낮음 사유 · ${label}`,
    group: '신청상병 · 판정',
    moduleId: 'diagnosis',
    grain: 'disease',
    type: 'boolean',
    provenance: 'clinician_judgment',
    dependsOn: [
      'shared.diagnoses[].id',
      'shared.diagnoses[].side',
      'shared.diagnoses[].assessmentRight',
      'shared.diagnoses[].assessmentLeft',
      'shared.diagnoses[].reasonRight',
      'shared.diagnoses[].reasonLeft',
    ],
    availableAt: 'post_decision',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'diagnosis_assessment_low_reason',
    supportedFormulaPolicies: [],
  });
}

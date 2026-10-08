// 변수 카탈로그 — shoulder.exposure.anyExceeded 1개(§1-1). "formula family당 대표 변수 1개"
// 확정 범위(총 7개, knee 포함) — 전체 카탈로그 확장은 PR0-B3.

import type { AnalyticsVariableMetadata } from '../../types';

// ELLMAN_OPTIONS(AssessmentTab.jsx)가 실제로 제공하는 4개 등급의 심각도 순서 — 오름차순.
// Ellman 분류의 임상 관례상 Grade 1~3은 회전근개 부분층 파열의 깊이 등급, Full은 전층
// 파열(부분층보다 중증)이라 등급 순서의 맨 끝에 둔다. "N/A"는 klGrade와 동일한 이유로
// 이 순서에 끼워넣지 않는다(knee/metadata.ts KNEE_KLG_ORDER 주석 참고).
export const SHOULDER_ELLMAN_ORDER = ['Grade 1', 'Grade 2', 'Grade 3', 'Full'] as const;

export const SHOULDER_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'shoulder.exposure.anyExceeded',
    label: '노출 한도 초과 여부(5종 중 1개 이상)',
    group: '어깨 · 파생지표',
    moduleId: 'shoulder',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    // dependsOn: 공식이 읽는 필드 + missing/qualityFlags 판정에 영향 주는 필드 전부(§5.2 원칙).
    dependsOn: [
      'activeModules',
      'shared.jobs[].id',
      'shared.jobs[].excludeFromAnalysis',
      'shared.jobs[].startDate',
      'shared.jobs[].endDate',
      'shared.jobs[].workPeriodOverride',
      'shared.jobs[].workDaysPerYear',
      'modules.shoulder.jobExtras[].sharedJobId',
      'modules.shoulder.jobExtras[].overheadHours',
      'modules.shoulder.jobExtras[].repetitiveMediumHours',
      'modules.shoulder.jobExtras[].repetitiveFastHours',
      'modules.shoulder.jobExtras[].heavyLoadCount',
      'modules.shoulder.jobExtras[].heavyLoadSeconds',
      'modules.shoulder.jobExtras[].vibrationHours',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_exposure',
    // BK2117 임계값(EXPOSURE_LIMITS, derived.ts)에는 버전 개념이 없다 — 과거 구현이 보존된
    // 대체 버전이 없어 recompute_recorded_version 선언 불가(knee.relatedness.max와 같은 사유).
    supportedFormulaPolicies: ['recompute_current'],
  },
  {
    // PR0-B3 Part B — diagnosis_side grain. knee.diagnosisSide.klGrade와 동일한 패턴.
    key: 'shoulder.diagnosisSide.ellmanClass',
    label: 'Ellman Class',
    group: '어깨 · 진단별 판정',
    moduleId: 'shoulder',
    grain: 'disease',
    type: 'ordinal',
    provenance: 'clinician_judgment',
    dependsOn: [
      'activeModules',
      'shared.diagnoses[].id',
      'shared.diagnoses[].code',
      'shared.diagnoses[].name',
      'shared.diagnoses[].moduleId',
      'shared.diagnoses[].side',
      'shared.diagnoses[].ellmanRight',
      'shared.diagnoses[].ellmanLeft',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    // PR4-B2 — disease 예측 전용 predictor(계획서 §0단계 허용표).
    allowedAnalysisPurposes: ['association', 'formula_audit', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_ellman_class_side',
    supportedFormulaPolicies: [],
  },

  // PR0-B4 Slice 3 — coverage 잔여 필드(매핑표 §3). anyExceeded(boolean)에만 흡수됐던
  // jobExtras 원시값 6종을 job grain에 독립 노출한다.
  {
    key: 'shoulder.job.overheadHours',
    label: '어깨 위 작업 시간(원본)',
    group: '어깨 · 원본입력',
    moduleId: 'shoulder',
    grain: 'job',
    type: 'continuous',
    unit: '시간',
    provenance: 'raw',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].excludeFromAnalysis', 'modules.shoulder.jobExtras[].sharedJobId', 'modules.shoulder.jobExtras[].overheadHours'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_job_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'shoulder.job.repetitiveMediumHours',
    label: '중등도 반복작업 시간(원본)',
    group: '어깨 · 원본입력',
    moduleId: 'shoulder',
    grain: 'job',
    type: 'continuous',
    unit: '시간',
    provenance: 'raw',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].excludeFromAnalysis', 'modules.shoulder.jobExtras[].sharedJobId', 'modules.shoulder.jobExtras[].repetitiveMediumHours'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_job_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'shoulder.job.repetitiveFastHours',
    label: '고빈도 반복작업 시간(원본)',
    group: '어깨 · 원본입력',
    moduleId: 'shoulder',
    grain: 'job',
    type: 'continuous',
    unit: '시간',
    provenance: 'raw',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].excludeFromAnalysis', 'modules.shoulder.jobExtras[].sharedJobId', 'modules.shoulder.jobExtras[].repetitiveFastHours'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_job_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'shoulder.job.heavyLoadCount',
    label: '중량물 취급 횟수(원본)',
    group: '어깨 · 원본입력',
    moduleId: 'shoulder',
    grain: 'job',
    type: 'continuous',
    provenance: 'raw',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].excludeFromAnalysis', 'modules.shoulder.jobExtras[].sharedJobId', 'modules.shoulder.jobExtras[].heavyLoadCount'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_job_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'shoulder.job.heavyLoadSeconds',
    label: '중량물 취급 시간(원본)',
    group: '어깨 · 원본입력',
    moduleId: 'shoulder',
    grain: 'job',
    type: 'continuous',
    unit: '초',
    provenance: 'raw',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].excludeFromAnalysis', 'modules.shoulder.jobExtras[].sharedJobId', 'modules.shoulder.jobExtras[].heavyLoadSeconds'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_job_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'shoulder.job.vibrationHours',
    label: '진동 노출 시간(원본)',
    group: '어깨 · 원본입력',
    moduleId: 'shoulder',
    grain: 'job',
    type: 'continuous',
    unit: '시간',
    provenance: 'raw',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].excludeFromAnalysis', 'modules.shoulder.jobExtras[].sharedJobId', 'modules.shoulder.jobExtras[].vibrationHours'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_job_raw',
    supportedFormulaPolicies: [],
  },

  // case grain 합계 5종 — job grain 원본 6종을 직업 간에 합산한 것(직업력 단순합: 일일 입력값의
  // 합계이며 근속기간·연간근무일수 가중 없음 — 연간 누적량이 아니다). 중량물은 직업별
  // (횟수 × 초/회 ÷ 3600)을 먼저 계산한 뒤 합산한다. 결측 정책은 extractors.ts의
  // extractShoulderCaseSum 주석 참고(손상값이 하나라도 있으면 부분합 없이 결측).
  //
  // 예측 사용 목적: 이 변수들은 평가자 판정(diagnosis.rollup.anyHighRelatedness 등)의 근거
  // 입력값이다. prediction 허용은 "노출 요인이 평가자 판정을 얼마나 설명·재현하는가(판정
  // 일관성 점검)" 용도이며 임상 위험 예측이 아니다 — 모델이 판정 규칙을 거의 그대로 학습할
  // 수 있다는 한계를 해석 시 감안한다. formula_audit는 허용하지 않는다(job raw 변수와 동일).
  // case→disease broadcast는 isGrainCompatible 범용 규칙으로 자동 적용된다.
  caseSumMetadata({
    key: 'shoulder.case.sumOverheadHours',
    label: '어깨 위 작업 시간 합계(직업력 단순합)',
    unit: '시간',
    fields: ['overheadHours'],
  }),
  caseSumMetadata({
    key: 'shoulder.case.sumRepetitiveMediumHours',
    label: '중등도 반복작업 시간 합계(직업력 단순합)',
    unit: '시간',
    fields: ['repetitiveMediumHours'],
  }),
  caseSumMetadata({
    key: 'shoulder.case.sumRepetitiveFastHours',
    label: '고빈도 반복작업 시간 합계(직업력 단순합)',
    unit: '시간',
    fields: ['repetitiveFastHours'],
  }),
  caseSumMetadata({
    key: 'shoulder.case.sumHeavyLoadHoursPerDay',
    label: '중량물 취급 시간 합계(직업별 횟수×초/회÷3600의 직업력 단순합)',
    unit: '시간/일',
    fields: ['heavyLoadCount', 'heavyLoadSeconds'],
  }),
  caseSumMetadata({
    key: 'shoulder.case.sumVibrationHours',
    label: '진동 노출 시간 합계(직업력 단순합)',
    unit: '시간',
    fields: ['vibrationHours'],
  }),
];

function caseSumMetadata(params: {
  key: string;
  label: string;
  unit: string;
  fields: string[];
}): AnalyticsVariableMetadata {
  return {
    key: params.key,
    label: params.label,
    group: '어깨 · 직업력 합계',
    moduleId: 'shoulder',
    grain: 'case',
    type: 'continuous',
    unit: params.unit,
    provenance: 'derived',
    dependsOn: [
      'activeModules',
      'shared.jobs[].id',
      'shared.jobs[].excludeFromAnalysis',
      'modules.shoulder.jobExtras[].sharedJobId',
      ...params.fields.map((field) => `modules.shoulder.jobExtras[].${field}`),
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_case_raw_sum',
    supportedFormulaPolicies: [],
  };
}

// 변수 카탈로그 — cervical.case.maxJobCumulativeKgHours(§1-1) + cervical.case.totalNonNeutralHoursPerDay.
// 전자는 "formula family당 대표 변수 1개" 확정 범위에서 출발했고, 후자는 사용자 요청으로 추가됐다.
//
// §2.1(계획서) 근거: cervical.job.cumulativeKgHours는 job grain 반복 관측치라
// ExtractedValue<T>(단일값 계약)로 표현할 수 없다 — case grain 롤업으로 대체한다
// (2라운드 필수 보완 #3). 롤업은 처음에 Math.max였고, 사용자 요청으로 전 직업 합계로 바뀌었다. elbow/wrist의 anyFlagged류 근사 무의미 변수 문제가 cervical에는
// 처음부터 해당 없음 — burdenGrade가 아니라 실제 물리량(kg·h)을 대표 변수로 쓰므로 변량이
// 자연스럽게 존재한다.

import type { AnalyticsVariableMetadata } from '../../types';

export const CERVICAL_METADATA: AnalyticsVariableMetadata[] = [
  {
    // 키 이름의 "max"는 과거 의미(직업 중 최댓값)의 잔재다 — 현재 값은 전 직업의 합계다
    // (UI의 "BK2109 누적 총부하량 합계"와 일치). 키를 유지한 이유와 재실행 시 의미 변경 주의는
    // extractors.ts의 extractCervicalCaseMaxJobCumulativeKgHours 주석 참고.
    key: 'cervical.case.maxJobCumulativeKgHours',
    label: '경추 BK2109 누적 총부하량(전 직업 합계)',
    group: '경추(목) · 파생지표',
    moduleId: 'cervical',
    grain: 'case',
    type: 'continuous',
    unit: 'kg·h',
    provenance: 'derived',
    // dependsOn: 공식이 읽는 필드 + missing/qualityFlags 판정에 영향 주는 필드 전부(§5.2 원칙).
    // shared.diagnoses[]는 buildJobSummary가 diagnosisText/diagnoses 표시용으로만 읽고
    // 이 변수의 값/missing/qualityFlags에는 전혀 영향을 주지 않으므로 포함하지 않는다
    // (isCervicalAssessmentComplete의 별도 diagnosis 완료판정과는 무관 — knee/elbow 전례와
    // 동일한 경계).
    dependsOn: [
      'activeModules',
      'shared.jobs[].id',
      'shared.jobs[].workDaysPerYear',
      'shared.jobs[].startDate',
      'shared.jobs[].endDate',
      'shared.jobs[].workPeriodOverride',
      'modules.cervical.tasks[].sharedJobId',
      'modules.cervical.tasks[].name',
      'modules.cervical.tasks[].exposure_types',
      'modules.cervical.tasks[].load_weight_kg',
      'modules.cervical.tasks[].carry_hours_per_shift',
      'modules.cervical.tasks[].forced_neck_posture',
      'modules.cervical.tasks[].neck_nonneutral_hours_per_day',
      'modules.cervical.tasks[].combined_flexion_rotation_posture',
      'modules.cervical.tasks[].precision_work',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    // 예측 사용 목적: 이 값은 BK2109 판정 기준 자체라 평가자 판정의 근거 입력이다. prediction 허용은
    // "노출 요인이 평가자 판정을 얼마나 설명·재현하는가(판정 일관성 점검)" 용도이며 임상 위험
    // 예측이 아니다 — 모델이 판정 규칙을 거의 그대로 학습할 수 있다는 한계를 해석 시 감안한다.
    // 기존 formula_audit 허용은 유지한다.
    allowedAnalysisPurposes: ['association', 'formula_audit', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'cervical_bk2109',
    // BK2109_REFERENCE_KG_HOURS(44000, derived.ts)는 코드 상수 하나뿐 — 과거 구현이 보존된
    // 대체 버전이 없어 recompute_recorded_version 선언 불가.
    supportedFormulaPolicies: ['recompute_current'],
  },
  {
    // 비중립 정적 자세 시간(시간/일)의 전 직업·전 작업 단순합 — 근무일수·근속연수 가중 없음
    // (연간 누적 시간이 아니다). 대상 작업은 awkward_static_neck_load가 선택된 작업만이고, 손상값은
    // 부분합 없이 결측이다(extractors.ts 참고). 예측 사용 목적·한계는 위 누적 총부하량과 동일하며
    // formula_audit는 허용하지 않는다.
    key: 'cervical.case.totalNonNeutralHoursPerDay',
    label: '경추 비중립 정적 자세 시간 합계(전 직업·작업 단순합)',
    group: '경추(목) · 파생지표',
    moduleId: 'cervical',
    grain: 'case',
    type: 'continuous',
    unit: '시간/일',
    provenance: 'derived',
    dependsOn: [
      'activeModules',
      'shared.jobs[].id',
      'modules.cervical.tasks[].sharedJobId',
      'modules.cervical.tasks[].exposure_types',
      'modules.cervical.tasks[].neck_nonneutral_hours_per_day',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'prediction'],
    predictionRole: 'predictor',
    sensitivity: 'non_sensitive',
    formulaFamily: 'cervical_case_awkward_sum',
    supportedFormulaPolicies: [],
  },
];

// 변수 카탈로그 — cervical.case.maxJobCumulativeKgHours 1개(§1-1). "formula family당 대표
// 변수 1개" 확정 범위(총 7개, knee 포함) — 전체 카탈로그 확장은 PR0-B3.
//
// §2.1(계획서) 근거: cervical.job.cumulativeKgHours는 job grain 반복 관측치라
// ExtractedValue<T>(단일값 계약)로 표현할 수 없다 — case grain 롤업(Math.max)으로 대체한다
// (2라운드 필수 보완 #3). elbow/wrist의 anyFlagged류 근사 무의미 변수 문제가 cervical에는
// 처음부터 해당 없음 — burdenGrade가 아니라 실제 물리량(kg·h)을 대표 변수로 쓰므로 변량이
// 자연스럽게 존재한다.

import type { AnalyticsVariableMetadata } from '../../types';

export const CERVICAL_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'cervical.case.maxJobCumulativeKgHours',
    label: '경추 BK2109 누적 총부하량(직업 중 최댓값)',
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
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'cervical_bk2109',
    // BK2109_REFERENCE_KG_HOURS(44000, derived.ts)는 코드 상수 하나뿐 — 과거 구현이 보존된
    // 대체 버전이 없어 recompute_recorded_version 선언 불가.
    supportedFormulaPolicies: ['recompute_current'],
  },
];

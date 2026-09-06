// 변수 카탈로그 — spine은 MDDM/WBV 두 formula family라 계획서(§1-1 표)가 변수 2개를 지정한다:
// `spine.mddm.lifetimeDoseMNh` + `spine.vibration.dvMax`. "formula family당 대표 변수 1개"
// 확정 범위(총 7개, knee 포함) — 전체 카탈로그 확장은 PR0-B3.

import type { AnalyticsVariableMetadata } from '../../types';

export const SPINE_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'spine.mddm.lifetimeDoseMNh',
    label: 'MDDM 평생 누적 압박력 선량',
    group: '요추(허리) · 파생지표',
    moduleId: 'spine',
    grain: 'case',
    type: 'continuous',
    unit: 'MN·h',
    provenance: 'derived',
    // dependsOn: 공식이 읽는 필드 + missing/qualityFlags 판정에 영향 주는 필드 전부(§5.2 원칙).
    dependsOn: [
      'activeModules',
      'shared.gender',
      'shared.jobs[].id',
      'shared.jobs[].jobName',
      'shared.jobs[].workDaysPerYear',
      'shared.jobs[].startDate',
      'shared.jobs[].endDate',
      'shared.jobs[].workPeriodOverride',
      'modules.spine.mddmStatus',
      'modules.spine.evalMethod',
      'modules.spine.formulaVersion',
      // 구형식(legacy) — hasLegacyFields 판정 자체가 careerYears/workDaysPerYear의
      // undefined 여부로 갈리므로(계획서 §1-3 "legacy 호환 분기") 값뿐 아니라 존재 여부도
      // 결과에 영향을 준다.
      'modules.spine.careerYears',
      'modules.spine.careerMonths',
      'modules.spine.workDaysPerYear',
      'modules.spine.tasks[].sharedJobId',
      'modules.spine.tasks[].posture',
      'modules.spine.tasks[].weight',
      'modules.spine.tasks[].frequency',
      'modules.spine.tasks[].timeValue',
      'modules.spine.tasks[].timeUnit',
      'modules.spine.tasks[].correctionFactor',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'spine_mddm',
    // calculateDailyDoseLegacy/V513 둘 다 코드에 보존돼 있어(§2.3) 저장된 버전을 그대로
    // 재계산(recompute_recorded_version)하거나 항상 최신(v5.1.3, recompute_current)으로
    // 강제 재계산하는 두 정책 모두 지원한다.
    supportedFormulaPolicies: ['recompute_recorded_version', 'recompute_current'],
    formulaVersionKey: 'modules.spine.formulaVersion',
  },
  {
    key: 'spine.vibration.dvMax',
    label: '전신진동(BK2110) 평생 누적용량(상한)',
    group: '요추(허리) · 파생지표',
    moduleId: 'spine',
    grain: 'case',
    type: 'continuous',
    unit: '(m/s²)²·일·년',
    provenance: 'derived',
    dependsOn: [
      'activeModules',
      'shared.gender',
      'shared.jobs[].id',
      'shared.jobs[].jobName',
      'shared.jobs[].workDaysPerYear',
      'shared.jobs[].startDate',
      'shared.jobs[].endDate',
      'shared.jobs[].workPeriodOverride',
      'modules.spine.vibrationExposureStatus',
      'modules.spine.evalMethod',
      'modules.spine.vibrationIntervals[].sharedJobId',
      'modules.spine.vibrationIntervals[].awMin',
      'modules.spine.vibrationIntervals[].awMax',
      'modules.spine.vibrationIntervals[].timeValue',
      'modules.spine.vibrationIntervals[].timeUnit',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'spine_wbv',
    // WBV_FORMULA_V1 상수 하나뿐(대체 구현이 없어 recompute_recorded_version 선언 불가 —
    // knee.relatedness.max·shoulder.exposure.anyExceeded와 같은 사유).
    supportedFormulaPolicies: ['recompute_current'],
  },
];

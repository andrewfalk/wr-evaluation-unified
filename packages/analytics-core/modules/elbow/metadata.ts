// 변수 카탈로그 — elbow.assessment.burdenGradeMax 1개(§1-1). "formula family당 대표 변수
// 1개" 확정 범위(총 7개, knee 포함) — 전체 카탈로그 확장은 PR0-B3.
//
// 원래 후보는 anyFlagged(boolean, "위험요인 플래그가 하나라도 있는가")였으나 리뷰(2026-09-05)
// 에서 "필수 필드가 모두 채워진 완전한 평가는 core_exposure_present/core_exposure_unclear/
// daily_share_* 중 하나가 구조적으로 항상 켜져 거의 항상 true — 비교 변수로 무의미"라는
// 지적을 받았다. burdenGrade(getElbowBurdenGrade, derived.ts)는 RISK_FACTOR_FLAGS만 세는
// riskFactorCount 기반이라 실제 분산이 있다(사용자 확정, 2026-09-05) — 대표 변수를 이걸로
// 교체한다. type을 'ordinal'로 선언한다.

import type { AnalyticsVariableMetadata } from '../../types';

// getElbowBurdenGrade(derived.ts)가 실제로 반환하는 4개 값의 심각도 순서 — 오름차순.
// 새 등급을 추가/변경할 때는 derived.ts의 GRADE와 함께 갱신할 것.
export const ELBOW_BURDEN_GRADE_ORDER = ['부담 작업 아님', '경도', '중등도', '고도'] as const;

export const ELBOW_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'elbow.assessment.burdenGradeMax',
    label: '팔꿈치 부담 등급(최고, 부담 작업 아님<경도<중등도<고도)',
    group: '팔꿈치 · 파생지표',
    moduleId: 'elbow',
    grain: 'case',
    type: 'ordinal',
    provenance: 'derived',
    // dependsOn: 공식이 읽는 필드 + missing/qualityFlags 판정에 영향 주는 필드 전부(§5.2 원칙).
    // burdenGrade는 anyFlagged와 같은 diagnosisSummaries 파이프라인에서 나오므로 dependsOn은
    // 동일하다(계산 자체가 바뀐 게 아니라 어떤 파생값을 대표로 뽑는지만 바뀜).
    // isElbowAssessmentComplete(모듈 registry의 별도 isComplete)가 추가로 읽는
    // diag.side/confirmedRight/assessmentRight 등은 이 변수의 값/missing/qualityFlags에
    // 영향을 주지 않으므로 여기 포함하지 않는다(knee 전례와 동일한 경계).
    dependsOn: [
      'activeModules',
      'shared.jobs[].id',
      'shared.diagnoses[].id',
      'shared.diagnoses[].code',
      'shared.diagnoses[].name',
      'shared.diagnoses[].moduleId',
      // 시간적 선후관계(공통 필드) — missingCommonFields가 not_entered 판정에 관여
      'modules.elbow.temporalSequence.recent_task_change',
      'modules.elbow.temporalSequence.task_change_date',
      'modules.elbow.temporalSequence.symptom_onset_interval',
      'modules.elbow.temporalSequence.improves_with_rest',
      'modules.elbow.temporalRelation.recent_task_change',
      'modules.elbow.temporalRelation.task_change_date',
      'modules.elbow.temporalRelation.symptom_onset_interval',
      'modules.elbow.temporalRelation.improves_with_rest',
      // job × 진단 entry
      'modules.elbow.jobEvaluations[].sharedJobId',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].diagnosisId',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].selectedBkType',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bkSelectionMode',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].main_task_name',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].direct_anatomic_link',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].exposure_types',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].repetition_level',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].daily_exposure_hours',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].shift_share_percent',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].days_per_week',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].work_pattern',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].rest_distribution',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].force_level',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].awkward_posture_level',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].static_holding_level',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].direct_pressure_level',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].vibration_exposure',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2101_cycle_seconds',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2101_repetition_per_hour',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2101_monotony',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2101_forced_dorsal_extension',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2101_prosupination',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2105_elbow_leaning',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2105_pressure_source',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2106_pressure_source',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2103_vibration_tool_type',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2103_daily_vibration_hours',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2103_tool_pressing',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2103_frequent_high_force_grip',
      // legacy 유출 필드(정규화 시 bk2103_tool_pressing 자동보정 소스, normalizeDiagnosisEntry 참고)
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2106_tool_pressing',
      'modules.elbow.jobEvaluations[].diagnosisEntries[].bk2106_frequent_high_force_grip',
      // 구형식(legacy, job별이 아니라 진단별 flat 저장) — buildLegacyEntryMap(legacyNormalize.ts)
      // 이 레거시 entry 전체를 `{...createElbowDiagnosisEntry(diagnosis), ...legacyEntry}`로
      // 그대로 스프레드하므로, 위 jobEvaluations[].diagnosisEntries[]와 동일한 필드 전부가
      // 값/missing/qualityFlags에 영향을 준다(§리뷰 지적 — wrist에서 먼저 발견, elbow도
      // 동일 구조라 함께 교정).
      'modules.elbow.diagnosisEvaluations[].diagnosisId',
      'modules.elbow.diagnosisEvaluations[].linkedJobId',
      'modules.elbow.diagnosisEvaluations[].selectedBkType',
      'modules.elbow.diagnosisEvaluations[].bkSelectionMode',
      'modules.elbow.diagnosisEvaluations[].main_task_name',
      'modules.elbow.diagnosisEvaluations[].direct_anatomic_link',
      'modules.elbow.diagnosisEvaluations[].exposure_types',
      'modules.elbow.diagnosisEvaluations[].repetition_level',
      'modules.elbow.diagnosisEvaluations[].daily_exposure_hours',
      'modules.elbow.diagnosisEvaluations[].shift_share_percent',
      'modules.elbow.diagnosisEvaluations[].days_per_week',
      'modules.elbow.diagnosisEvaluations[].work_pattern',
      'modules.elbow.diagnosisEvaluations[].rest_distribution',
      'modules.elbow.diagnosisEvaluations[].force_level',
      'modules.elbow.diagnosisEvaluations[].awkward_posture_level',
      'modules.elbow.diagnosisEvaluations[].static_holding_level',
      'modules.elbow.diagnosisEvaluations[].direct_pressure_level',
      'modules.elbow.diagnosisEvaluations[].vibration_exposure',
      'modules.elbow.diagnosisEvaluations[].bk2101_cycle_seconds',
      'modules.elbow.diagnosisEvaluations[].bk2101_repetition_per_hour',
      'modules.elbow.diagnosisEvaluations[].bk2101_monotony',
      'modules.elbow.diagnosisEvaluations[].bk2101_forced_dorsal_extension',
      'modules.elbow.diagnosisEvaluations[].bk2101_prosupination',
      'modules.elbow.diagnosisEvaluations[].bk2105_elbow_leaning',
      'modules.elbow.diagnosisEvaluations[].bk2105_pressure_source',
      'modules.elbow.diagnosisEvaluations[].bk2106_pressure_source',
      'modules.elbow.diagnosisEvaluations[].bk2103_vibration_tool_type',
      'modules.elbow.diagnosisEvaluations[].bk2103_daily_vibration_hours',
      'modules.elbow.diagnosisEvaluations[].bk2103_tool_pressing',
      'modules.elbow.diagnosisEvaluations[].bk2103_frequent_high_force_grip',
      'modules.elbow.diagnosisEvaluations[].bk2106_tool_pressing',
      'modules.elbow.diagnosisEvaluations[].bk2106_frequent_high_force_grip',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_assessment',
    // 부담 등급 규칙(getElbowBurdenGrade, derived.ts)에는 버전 개념이 없다 — 과거 구현이
    // 보존된 대체 버전이 없어 recompute_recorded_version 선언 불가.
    supportedFormulaPolicies: ['recompute_current'],
  },
];

// 변수 카탈로그 — wrist.assessment.burdenGradeMax 1개(§1-1). "formula family당 대표 변수
// 1개" 확정 범위(총 7개, knee 포함) — 전체 카탈로그 확장은 PR0-B3.
//
// elbow 이관(2026-09-05)에서 anyFlagged(boolean)가 "필수 필드가 모두 채워진 완전한 평가는
// core_exposure_present/unclear·daily_share_* 중 하나가 구조적으로 항상 켜져 비교 변수로
// 무의미하다"는 지적을 받아 burdenGrade(ordinal)로 교체했다 — wrist도 완전히 동일한 계산
// 구조(getWristBurdenGrade, RISK_FACTOR_FLAGS 기반 riskFactorCount)라 처음부터 burdenGrade
// 로 채택한다(사용자 확정, 2026-09-05 — elbow에서 지적한 사용자가 wrist도 동일하게
// 바꿔야 하지 않냐고 먼저 확인).

import type { AnalyticsVariableMetadata } from '../../types';

// getWristBurdenGrade(derived.ts)가 실제로 반환하는 4개 값의 심각도 순서 — 오름차순.
export const WRIST_BURDEN_GRADE_ORDER = ['부담 작업 아님', '경도', '중등도', '고도'] as const;

export const WRIST_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'wrist.assessment.burdenGradeMax',
    label: '손목/손 부담 등급(최고, 부담 작업 아님<경도<중등도<고도)',
    group: '손목/손가락 · 파생지표',
    moduleId: 'wrist',
    grain: 'case',
    type: 'ordinal',
    provenance: 'derived',
    // dependsOn: 공식이 읽는 필드 + missing/qualityFlags 판정에 영향 주는 필드 전부(§5.2 원칙).
    // isWristAssessmentComplete(모듈 registry의 별도 isComplete)가 추가로 읽는
    // diag.side/confirmedRight/assessmentRight 등은 이 변수의 값/missing/qualityFlags에
    // 영향을 주지 않으므로 여기 포함하지 않는다(elbow/knee 전례와 동일한 경계).
    dependsOn: [
      'activeModules',
      'shared.jobs[].id',
      'shared.diagnoses[].id',
      'shared.diagnoses[].code',
      'shared.diagnoses[].name',
      'shared.diagnoses[].moduleId',
      // 시간적 선후관계(공통 필드) — missingCommonFields가 not_entered 판정에 관여
      'modules.wrist.temporalSequence.recent_task_change',
      'modules.wrist.temporalSequence.task_change_date',
      'modules.wrist.temporalSequence.symptom_onset_interval',
      'modules.wrist.temporalSequence.improves_with_rest',
      'modules.wrist.temporalRelation.recent_task_change',
      'modules.wrist.temporalRelation.task_change_date',
      'modules.wrist.temporalRelation.symptom_onset_interval',
      'modules.wrist.temporalRelation.improves_with_rest',
      // job × 진단 entry
      'modules.wrist.jobEvaluations[].sharedJobId',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].diagnosisId',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].selectedBkType',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bkSelectionMode',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].main_task_name',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].direct_anatomic_link',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].exposure_types',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].repetition_level',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].daily_exposure_hours',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].shift_share_percent',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].days_per_week',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].work_pattern',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].rest_distribution',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].force_level',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].awkward_posture_level',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].static_holding_level',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].direct_pressure_level',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].vibration_exposure',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2113_repetitive_wrist_motion',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2101_cycle_seconds',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2101_repetition_per_hour',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2101_monotony',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2101_forced_dorsal_extension',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2101_prosupination',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2106_pressure_source',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2103_vibration_tool_type',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2103_daily_vibration_hours',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2103_tool_pressing',
      'modules.wrist.jobEvaluations[].diagnosisEntries[].bk2103_frequent_high_force_grip',
      // 구형식(legacy, job별이 아니라 진단별 flat 저장) — buildLegacyEntryMap(legacyNormalize.ts)
      // 이 레거시 entry 전체를 `{...createWristDiagnosisEntry(diagnosis), ...legacyEntry}`로
      // 그대로 스프레드하므로, 위 jobEvaluations[].diagnosisEntries[]와 동일한 필드 전부가
      // 값/missing/qualityFlags에 영향을 준다(§리뷰 지적 — direct_anatomic_link 하나만
      // 빠져도 '부담 작업 아님'↔not_entered가 뒤집힘을 실측 확인).
      'modules.wrist.diagnosisEvaluations[].diagnosisId',
      'modules.wrist.diagnosisEvaluations[].linkedJobId',
      'modules.wrist.diagnosisEvaluations[].selectedBkType',
      // bkSelectionMode는 여기 의도적으로 없다 — buildLegacyEntryMap(legacyNormalize.ts)이
      // `{...createWristDiagnosisEntry(diagnosis), ...legacyEntry}`로 스프레드는 하지만
      // 바로 다음 줄에서 `bkSelectionMode: legacyEntry.selectedBkType ? 'manual' : 'auto'`로
      // 무조건 재계산해 덮어쓴다 — legacyEntry.bkSelectionMode 원래 값은 결과에 전혀
      // 반영되지 않는다(§coverage inventory 재검토, 2026-09-06 — 처음엔 elbow와 맞추려
      // 추가했었으나 elbow도 legacyNormalize.ts:196에 동일한 무조건 덮어쓰기가 있어 elbow
      // 쪽 선언도 근거가 약하다는 게 드러났다. elbow는 이미 리뷰를 통과한 기존 선언이라
      // 이번 범위에서 되돌리지 않고 사용자에게 별도 보고).
      'modules.wrist.diagnosisEvaluations[].main_task_name',
      'modules.wrist.diagnosisEvaluations[].direct_anatomic_link',
      'modules.wrist.diagnosisEvaluations[].exposure_types',
      'modules.wrist.diagnosisEvaluations[].repetition_level',
      'modules.wrist.diagnosisEvaluations[].daily_exposure_hours',
      'modules.wrist.diagnosisEvaluations[].shift_share_percent',
      'modules.wrist.diagnosisEvaluations[].days_per_week',
      'modules.wrist.diagnosisEvaluations[].work_pattern',
      'modules.wrist.diagnosisEvaluations[].rest_distribution',
      'modules.wrist.diagnosisEvaluations[].force_level',
      'modules.wrist.diagnosisEvaluations[].awkward_posture_level',
      'modules.wrist.diagnosisEvaluations[].static_holding_level',
      'modules.wrist.diagnosisEvaluations[].direct_pressure_level',
      'modules.wrist.diagnosisEvaluations[].vibration_exposure',
      'modules.wrist.diagnosisEvaluations[].bk2113_repetitive_wrist_motion',
      'modules.wrist.diagnosisEvaluations[].bk2101_cycle_seconds',
      'modules.wrist.diagnosisEvaluations[].bk2101_repetition_per_hour',
      'modules.wrist.diagnosisEvaluations[].bk2101_monotony',
      'modules.wrist.diagnosisEvaluations[].bk2101_forced_dorsal_extension',
      'modules.wrist.diagnosisEvaluations[].bk2101_prosupination',
      'modules.wrist.diagnosisEvaluations[].bk2106_pressure_source',
      'modules.wrist.diagnosisEvaluations[].bk2103_vibration_tool_type',
      'modules.wrist.diagnosisEvaluations[].bk2103_daily_vibration_hours',
      'modules.wrist.diagnosisEvaluations[].bk2103_tool_pressing',
      'modules.wrist.diagnosisEvaluations[].bk2103_frequent_high_force_grip',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'wrist_assessment',
    // 부담 등급 규칙(getWristBurdenGrade, derived.ts)에는 버전 개념이 없다 — 과거 구현이
    // 보존된 대체 버전이 없어 recompute_recorded_version 선언 불가. DEFAULT_BURDEN_THRESHOLDS
    // 도 코드 상수 하나뿐(대체 임계값 세트가 없음).
    supportedFormulaPolicies: ['recompute_current'],
  },
];

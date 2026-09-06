// §5.3 coverage inventory — modules.elbow 전체 필드. 출처: src/modules/elbow/utils/data.js
// (createElbowModuleData/createElbowTemporalSequence/createElbowJobEvaluation/
// createElbowDiagnosisEntry) + packages/analytics-core/modules/elbow/metadata.ts의 dependsOn.
import type { CoverageInventory } from '../types';

const DEFERRED = 'PR0-B3 전체 카탈로그 확장 대상 — 현재 대표 변수(elbow.assessment.burdenGradeMax)의 dependsOn에는 없음';
const TECHNICAL = '기술 ID/UI 상태 — 계산값이 아니라 참조·라우팅·워크플로용';
const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';
// FIELD_LABELS(derived.ts)에 라벨은 있지만 실제 flag 계산 로직(computeDiagnosisFlags)
// 어디에서도 값을 읽지 않는 것을 grep으로 확인(2026-09-06) — burdenGrade에 영향 없음.
const LABEL_ONLY_UNUSED = '입력 폼과 라벨 맵(FIELD_LABELS)에는 있지만 실제 계산 로직에서 값을 읽지 않음 — PR0-B3에서 재검토 필요';

// jobEvaluations[].diagnosisEntries[]와 diagnosisEvaluations[](레거시 flat 저장) 둘 다
// createElbowDiagnosisEntry()로 만들어지는 동일 shape라 필드 목록이 같다 — linkedJobId만
// diagnosisEvaluations[] 전용(레거시 구조는 job으로 그룹핑되지 않아 자체 FK가 필요).
const DIAGNOSIS_ENTRY_FIELDS: Record<string, { included: true } | { included: false; reason: string }> = {
  diagnosisId: { included: true },
  selectedBkType: { included: true },
  bkSelectionMode: { included: true },
  main_task_name: { included: true },
  direct_anatomic_link: { included: true },
  exposure_types: { included: true },
  repetition_level: { included: true },
  daily_exposure_hours: { included: true },
  shift_share_percent: { included: true },
  days_per_week: { included: true },
  work_pattern: { included: true },
  rest_distribution: { included: true },
  force_level: { included: true },
  awkward_posture_level: { included: true },
  static_holding_level: { included: true },
  direct_pressure_level: { included: true },
  vibration_exposure: { included: true },
  bk2101_cycle_seconds: { included: true },
  bk2101_repetition_per_hour: { included: true },
  bk2101_monotony: { included: true },
  bk2101_forced_dorsal_extension: { included: true },
  bk2101_prosupination: { included: true },
  bk2105_elbow_leaning: { included: true },
  bk2105_repeated_friction_impact: { included: false, reason: LABEL_ONLY_UNUSED },
  bk2105_pressure_source: { included: true },
  bk2106_repeated_mechanical_exposure: { included: false, reason: LABEL_ONLY_UNUSED },
  bk2106_noncorrectable_posture: { included: false, reason: LABEL_ONLY_UNUSED },
  bk2106_prolonged_joint_position: { included: false, reason: LABEL_ONLY_UNUSED },
  bk2106_pressure_source: { included: true },
  bk2103_vibration_tool_type: { included: true },
  bk2103_daily_vibration_hours: { included: true },
  bk2103_handheld_or_guided: { included: false, reason: LABEL_ONLY_UNUSED },
  bk2103_tool_pressing: { included: true },
  bk2103_frequent_high_force_grip: { included: true },
  // 레거시 유출 필드(정규화 시 bk2103_tool_pressing 자동보정 소스, normalizeDiagnosisEntry) —
  // createElbowDiagnosisEntry()는 이 둘을 만들지 않지만, 구버전에 저장된 값이 스프레드로
  // 들어올 수 있어 dependsOn에 명시돼 있다.
  bk2106_tool_pressing: { included: true },
  bk2106_frequent_high_force_grip: { included: true },
};

function diagnosisEntryInventory(prefix: string): CoverageInventory {
  const inv: CoverageInventory = {};
  for (const [field, entry] of Object.entries(DIAGNOSIS_ENTRY_FIELDS)) {
    inv[`${prefix}.${field}`] = entry;
  }
  return inv;
}

export const ELBOW_INVENTORY: CoverageInventory = {
  'modules.elbow.returnConsiderations': { included: false, reason: FREE_TEXT },
  'modules.elbow.temporalSequence.recent_task_change': { included: true },
  'modules.elbow.temporalSequence.task_change_date': { included: true },
  'modules.elbow.temporalSequence.symptom_onset_interval': { included: true },
  'modules.elbow.temporalSequence.improves_with_rest': { included: true },
  'modules.elbow.temporalRelation.recent_task_change': { included: true },
  'modules.elbow.temporalRelation.task_change_date': { included: true },
  'modules.elbow.temporalRelation.symptom_onset_interval': { included: true },
  'modules.elbow.temporalRelation.improves_with_rest': { included: true },

  'modules.elbow.jobEvaluations[].sharedJobId': { included: true },
  'modules.elbow.jobEvaluations[]._pendingPreset': { included: false, reason: TECHNICAL + ' — 프리셋 적용 대기 중인 임시 상태, 저장 직전 제거됨(data.js normalizeElbowModuleData)' },
  'modules.elbow.jobEvaluations[].diagnosisEntries[].bkAutoSyncedFrom': { included: false, reason: TECHNICAL + ' — BK유형 자동복사 출처 진단ID(provenance), 계산에 관여하지 않음' },
  ...diagnosisEntryInventory('modules.elbow.jobEvaluations[].diagnosisEntries[]'),

  // 레거시(구형식, job별이 아니라 진단별 flat 저장) — linkedJobId만 이 구조 전용.
  'modules.elbow.diagnosisEvaluations[].linkedJobId': { included: true },
  ...diagnosisEntryInventory('modules.elbow.diagnosisEvaluations[]'),
  // bkSelectionMode는 jobEvaluations[]와 다르게 여기서는 계산에 영향이 없다 —
  // buildLegacyEntryMap(legacyNormalize.ts:196)이 `{...createElbowDiagnosisEntry(diagnosis),
  // ...legacyEntry}`로 스프레드한 바로 다음 줄에서 `bkSelectionMode: legacyEntry.
  // selectedBkType ? 'manual' : 'auto'`로 무조건 재계산해 legacyEntry.bkSelectionMode
  // 원래 값을 덮어쓴다 — 저장된 값이 무엇이었든 결과에 반영되지 않는다(wrist와 동일한
  // 구조, §리뷰 지적으로 wrist에서 먼저 발견돼 함께 바로잡음, 2026-09-06).
  'modules.elbow.diagnosisEvaluations[].bkSelectionMode': {
    included: false,
    reason: 'buildLegacyEntryMap이 스프레드 직후 selectedBkType 유무로 무조건 재계산해 덮어씀 — 저장된 값은 결과에 영향 없음',
  },
};

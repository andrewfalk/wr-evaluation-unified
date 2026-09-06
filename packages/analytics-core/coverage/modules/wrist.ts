// §5.3 coverage inventory — modules.wrist 전체 필드. 출처: src/modules/wrist/utils/data.js
// (createWristModuleData/createWristTemporalSequence/createWristJobEvaluation/
// createWristDiagnosisEntry) + packages/analytics-core/modules/wrist/metadata.ts의 dependsOn.
import type { CoverageInventory } from '../types';

const TECHNICAL = '기술 ID/UI 상태 — 계산값이 아니라 참조·라우팅·워크플로용';
const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';

// wrist는 elbow와 달리 createWristDiagnosisEntry()가 만드는 필드 전부가 dependsOn에도
// 그대로 있다(§리뷰 확인, 2026-09-06) — elbow의 5개 미사용 필드(bk2105_repeated_friction_
// impact 등) 같은 사례가 wrist에는 없다.
const DIAGNOSIS_ENTRY_FIELDS: Record<string, { included: true }> = {
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
  bk2113_repetitive_wrist_motion: { included: true },
  bk2101_cycle_seconds: { included: true },
  bk2101_repetition_per_hour: { included: true },
  bk2101_monotony: { included: true },
  bk2101_forced_dorsal_extension: { included: true },
  bk2101_prosupination: { included: true },
  bk2106_pressure_source: { included: true },
  bk2103_vibration_tool_type: { included: true },
  bk2103_daily_vibration_hours: { included: true },
  bk2103_tool_pressing: { included: true },
  bk2103_frequent_high_force_grip: { included: true },
};

function diagnosisEntryInventory(prefix: string): CoverageInventory {
  const inv: CoverageInventory = {};
  for (const [field, entry] of Object.entries(DIAGNOSIS_ENTRY_FIELDS)) {
    inv[`${prefix}.${field}`] = entry;
  }
  return inv;
}

export const WRIST_INVENTORY: CoverageInventory = {
  'modules.wrist.returnConsiderations': { included: false, reason: FREE_TEXT },
  'modules.wrist.temporalSequence.recent_task_change': { included: true },
  'modules.wrist.temporalSequence.task_change_date': { included: true },
  'modules.wrist.temporalSequence.symptom_onset_interval': { included: true },
  'modules.wrist.temporalSequence.improves_with_rest': { included: true },
  // temporalRelation은 createWristModuleData()가 만드는 현재 필드명이 아니라, legacyNormalize.ts
  // 가 구버전 저장 데이터의 옛 필드명을 방어적으로 읽는 legacy alias다(temporalSequence가
  // 없을 때만 대체 사용). dependsOn에 그대로 있으므로 포함.
  'modules.wrist.temporalRelation.recent_task_change': { included: true },
  'modules.wrist.temporalRelation.task_change_date': { included: true },
  'modules.wrist.temporalRelation.symptom_onset_interval': { included: true },
  'modules.wrist.temporalRelation.improves_with_rest': { included: true },

  'modules.wrist.jobEvaluations[].sharedJobId': { included: true },
  'modules.wrist.jobEvaluations[]._pendingPreset': { included: false, reason: TECHNICAL + ' — 프리셋 적용 대기 중인 임시 상태, 저장 직전 제거됨' },
  'modules.wrist.jobEvaluations[].diagnosisEntries[].bkAutoSyncedFrom': { included: false, reason: TECHNICAL + ' — BK유형 자동복사 출처 진단ID(provenance), 계산에 관여하지 않음' },
  ...diagnosisEntryInventory('modules.wrist.jobEvaluations[].diagnosisEntries[]'),

  // 레거시(구형식, job별이 아니라 진단별 flat 저장) — linkedJobId만 이 구조 전용.
  'modules.wrist.diagnosisEvaluations[].linkedJobId': { included: true },
  ...diagnosisEntryInventory('modules.wrist.diagnosisEvaluations[]'),
  // bkSelectionMode는 jobEvaluations[]와 다르게 여기서는 계산에 영향이 없다 —
  // buildLegacyEntryMap(legacyNormalize.ts:203)이 `{...createWristDiagnosisEntry(diagnosis),
  // ...legacyEntry}`로 스프레드한 바로 다음 줄에서 `bkSelectionMode: legacyEntry.
  // selectedBkType ? 'manual' : 'auto'`로 무조건 재계산해 legacyEntry.bkSelectionMode
  // 원래 값을 덮어쓴다 — 저장된 값이 무엇이었든 결과에 반영되지 않는다(§리뷰 지적,
  // 2026-09-06 — 처음엔 elbow와 맞추려 dependsOn에 추가했다가 되돌림).
  'modules.wrist.diagnosisEvaluations[].bkSelectionMode': {
    included: false,
    reason: 'buildLegacyEntryMap이 스프레드 직후 selectedBkType 유무로 무조건 재계산해 덮어씀 — 저장된 값은 결과에 영향 없음',
  },
};

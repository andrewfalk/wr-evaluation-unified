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

// PR0-B4 Slice 8b job_diagnosis ordinal 변수 4개의 선언 순서 — server/src/statsOrdinalOrder.ts
// 의 getOrdinalOrder()가 그대로 재사용한다(9차 검토 P1 재현: 이 등록이 없으면 그룹비교/
// 분할표가 전부 METHOD_TYPE_MISMATCH로 막힌다). repetitionLevel·awkwardPostureLevel은
// 둘 다 ExposureForm.jsx의 COMMON_FREQUENCY_OPTIONS(occasional/frequent)를 쓰므로 같은
// 상수를 공유한다.
export const ELBOW_FREQUENCY_LEVEL_ORDER = ['occasional', 'frequent'] as const;
export const ELBOW_FORCE_LEVEL_ORDER = ['mild', 'moderate', 'high'] as const;
export const ELBOW_REST_DISTRIBUTION_ORDER = ['adequate', 'moderate', 'insufficient'] as const;

// PR0-B4 Slice 8c BK 분기 ordinal 변수 2개의 선언 순서 — DiseaseSpecificFields.jsx의
// FREQUENCY_OPTIONS(none/occasional/frequent, ExposureForm.jsx의 COMMON_FREQUENCY_OPTIONS
// 와는 다른 상수 — 'none' 포함 3단계). staticHoldingLevel·directPressureLevel 둘 다 같은
// 상수를 쓴다. 9~13차 검토에서 확립된 원칙 — 신규 ordinal은 반드시 즉시 등록한다.
export const ELBOW_FREQUENCY_WITH_NONE_ORDER = ['none', 'occasional', 'frequent'] as const;

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
      // bkSelectionMode는 여기 의도적으로 없다 — buildLegacyEntryMap(legacyNormalize.ts:196)이
      // `{...createElbowDiagnosisEntry(diagnosis), ...legacyEntry}`로 스프레드한 바로
      // 다음 줄에서 `bkSelectionMode: legacyEntry.selectedBkType ? 'manual' : 'auto'`로
      // 무조건 재계산해 legacyEntry.bkSelectionMode 원래 값을 덮어쓴다 — 저장된 값이
      // 무엇이었든 결과에 반영되지 않는다(§coverage inventory 재검토, 2026-09-06 —
      // wrist에서 먼저 발견돼 동일 구조인 elbow도 함께 바로잡음).
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

// ── PR0-B4 Slice 8a/8b — 신설. temporal 4개는 병합 결과(normalizeElbowModuleData가 이미
// temporalSequence ?? temporalRelation을 계산해둔 moduleData.temporalSequence) 기준
// case grain 변수로만 등록한다(계획 §6 확정 — temporalSequence/temporalRelation 각각
// 변수화 금지). job_diagnosis 공통 필드 14개는 BK유형과 무관하게 항상 존재하는 필드만
// 대상이다(BK 분기 필드는 Slice 8c).
const TEMPORAL_BASE_DEPENDS_ON = [
  'activeModules',
  'modules.elbow.temporalSequence.recent_task_change',
  'modules.elbow.temporalSequence.task_change_date',
  'modules.elbow.temporalSequence.symptom_onset_interval',
  'modules.elbow.temporalSequence.improves_with_rest',
  'modules.elbow.temporalRelation.recent_task_change',
  'modules.elbow.temporalRelation.task_change_date',
  'modules.elbow.temporalRelation.symptom_onset_interval',
  'modules.elbow.temporalRelation.improves_with_rest',
];

// job_diagnosis 공통 필드의 dependsOn 생성기 — 신규 경로(jobEvaluations[].diagnosisEntries[])
// 와 레거시 flat 경로(diagnosisEvaluations[])가 normalizeDiagnosisEntry 안에서 동일하게
// 스프레드되므로(burdenGradeMax dependsOn과 동일 원칙, 위 참고) 필드마다 두 경로 모두
// 추가한다. bkAutoSyncedFrom은 selectedBkType을 제외한 모든 필드에서 inferred_link
// 품질 플래그 판정에 관여한다(BK_GROUP_META_FIELDS라 도너 복사에서 제외되는 필드는
// selectedBkType/bkSelectionMode/diagnosisId/bkAutoSyncedFrom 자체뿐).
const JOB_DIAGNOSIS_BASE_DEPENDS_ON = [
  'activeModules',
  'shared.jobs[].id',
  'shared.diagnoses[].id',
  'shared.diagnoses[].code',
  'shared.diagnoses[].name',
  'shared.diagnoses[].moduleId',
  'modules.elbow.jobEvaluations[].sharedJobId',
  'modules.elbow.jobEvaluations[].diagnosisEntries[].diagnosisId',
  'modules.elbow.diagnosisEvaluations[].diagnosisId',
  'modules.elbow.diagnosisEvaluations[].linkedJobId',
];

function elbowJobDiagnosisDependsOn(fields: string[], { includeProvenance = true }: { includeProvenance?: boolean } = {}): string[] {
  const perField = fields.flatMap((field) => [
    `modules.elbow.jobEvaluations[].diagnosisEntries[].${field}`,
    `modules.elbow.diagnosisEvaluations[].${field}`,
  ]);
  const provenance = includeProvenance ? ['modules.elbow.jobEvaluations[].diagnosisEntries[].bkAutoSyncedFrom'] : [];
  return [...JOB_DIAGNOSIS_BASE_DEPENDS_ON, ...perField, ...provenance];
}

ELBOW_METADATA.push(
  {
    key: 'elbow.temporal.recentTaskChange',
    label: '팔꿈치 최근 작업변화',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'case',
    type: 'categorical',
    provenance: 'raw',
    dependsOn: TEMPORAL_BASE_DEPENDS_ON,
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_temporal_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.temporal.taskChangeDate',
    label: '팔꿈치 작업변화 시점',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'case',
    type: 'date',
    provenance: 'raw',
    dependsOn: TEMPORAL_BASE_DEPENDS_ON,
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_temporal_raw',
    supportedFormulaPolicies: [],
    // 날짜 정책(계획 확정) — 기술통계 엔진이 date 타입을 지원하지 않아 filter_only.
    analysisRole: 'filter_only',
  },
  {
    key: 'elbow.temporal.symptomOnsetInterval',
    label: '팔꿈치 작업변화 후 증상발생까지 기간',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'case',
    type: 'high_cardinality',
    provenance: 'raw',
    dependsOn: TEMPORAL_BASE_DEPENDS_ON,
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_temporal_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.temporal.improvesWithRest',
    label: '팔꿈치 휴가/업무중단 시 호전 여부',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'case',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: TEMPORAL_BASE_DEPENDS_ON,
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_temporal_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.selectedBkType',
    label: '팔꿈치 BK 유형',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'categorical',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['selectedBkType'], { includeProvenance: false }),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.mainTaskName',
    label: '팔꿈치 문제 작업명',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'high_cardinality',
    provenance: 'raw',
    // 게이트: direct_anatomic_link !== 'yes'면 not_applicable.
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'main_task_name']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'quasi_identifier',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.directAnatomicLink',
    label: '팔꿈치 병변 부위와 직접 연결되는 핵심 동작/자세 여부',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.exposureType.repetition',
    label: '팔꿈치 핵심 노출 지표 — 반복 동작',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'exposure_types']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.exposureType.force',
    label: '팔꿈치 핵심 노출 지표 — 힘 사용',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'exposure_types']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.exposureType.awkwardPosture',
    label: '팔꿈치 핵심 노출 지표 — 비중립 자세',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'exposure_types']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.repetitionLevel',
    label: '팔꿈치 반복 동작 정도',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'ordinal',
    provenance: 'raw',
    // 게이트: direct_anatomic_link!=='yes' 또는 exposure_types에 repetition 미포함이면
    // not_applicable.
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'exposure_types', 'repetition_level']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.forceLevel',
    label: '팔꿈치 힘 사용 정도',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'ordinal',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'exposure_types', 'force_level']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.awkwardPostureLevel',
    label: '팔꿈치 비중립 자세 정도',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'ordinal',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'exposure_types', 'awkward_posture_level']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.workPattern',
    label: '팔꿈치 작업 형태',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'categorical',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'work_pattern']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.restDistribution',
    label: '팔꿈치 휴식 분포',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'ordinal',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'rest_distribution']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.dailyExposureHours',
    label: '팔꿈치 1일 총시간(시간)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'continuous',
    unit: '시간/일',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'daily_exposure_hours']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.shiftSharePercent',
    label: '팔꿈치 하루 작업 비중(%)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'continuous',
    unit: '%',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'shift_share_percent']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.daysPerWeek',
    label: '팔꿈치 주당 수행일수',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'continuous',
    unit: '일/주',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'days_per_week']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_raw',
    supportedFormulaPolicies: [],
  },
);

// ── PR0-B4 Slice 8c — BK유형별 세부 분기 필드. 전부 direct_anatomic_link==='yes'(외곽
// 게이트, Slice 8b 공통 필드와 동일)와 selectedBkType이 해당 유형일 때만(내곽 게이트)
// 의미가 있다 — DiseaseSpecificFields.jsx가 selectedBkType별로 완전히 다른 분기 UI를
// 렌더링한다(BK2101/BK2103/BK2105/BK2106 4종, elbow에는 BK2113 없음). 일부 필드는 그
// 안에서 한 단계 더(direct_pressure_level/vibration_exposure) 게이트된다.
ELBOW_METADATA.push(
  {
    key: 'elbow.jobDiagnosis.staticHoldingLevel',
    label: '팔꿈치 같은 자세 유지 정도(BK2101/BK2106)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'ordinal',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'static_holding_level']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.directPressureLevel',
    label: '팔꿈치 직접 압박/마찰/충격 정도(BK2105/BK2106)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'ordinal',
    provenance: 'raw',
    // bk2105_pressure_source/bk2106_pressure_source의 게이트 자체이기도 하다(아래 다중선택
    // 그룹 dependsOn 참고).
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'direct_pressure_level']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.vibrationExposure',
    label: '팔꿈치 진동 공구 사용 여부(BK2103)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    // bk2103_vibration_tool_type/bk2103_daily_vibration_hours의 게이트 자체.
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'vibration_exposure']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2101CycleSeconds',
    label: '팔꿈치 1회 동작 주기(초, BK2101)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'continuous',
    unit: '초',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2101_cycle_seconds']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2101RepetitionPerHour',
    label: '팔꿈치 예상 시간당 반복 횟수(원본 저장값, BK2101)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'continuous',
    unit: '회/시간',
    provenance: 'raw',
    // UI는 이 값을 bk2101_cycle_seconds로부터 매번 재계산해 표시하는 readOnly
    // 입력이지만(getBk2101RepetitionPerHour, derived.ts), 필드 자체는 레거시 입력/가져오기
    // 경로로 값이 남아있을 수 있는 진짜 raw 저장값이다 — 파생값을 재계산하지 않고 저장된
    // 값 자체를 그대로 노출한다(재구현 금지 원칙).
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2101_repetition_per_hour']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2101Monotony',
    label: '팔꿈치 단조로운 반복패턴 여부(BK2101)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2101_monotony']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2101ForcedDorsalExtension',
    label: '팔꿈치 강제적 손 배측굴곡 여부(BK2101)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2101_forced_dorsal_extension']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2101Prosupination',
    label: '팔꿈치 반복적/급작스러운 회내·회외 여부(BK2101)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2101_prosupination']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2105ElbowLeaning',
    label: '팔꿈치를 대고 버티는 작업 여부(BK2105)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2105_elbow_leaning']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2103DailyVibrationHours',
    label: '팔꿈치 진동 공구 1일 사용 시간(BK2103)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'continuous',
    unit: '시간/일',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn([
      'direct_anatomic_link', 'selectedBkType', 'vibration_exposure', 'bk2103_daily_vibration_hours',
    ]),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2103ToolPressing',
    label: '팔꿈치 공구를 강하게 쥐거나 누르는 작업 여부(BK2103)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2103_tool_pressing']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
  {
    key: 'elbow.jobDiagnosis.bk2103FrequentHighForceGrip',
    label: '팔꿈치 강한 힘으로 쥐는 동작 빈발 여부(BK2103, 레거시 유입값)',
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    // 현재 UI에는 이 필드를 직접 입력하는 컨트롤이 없다(DiseaseSpecificFields.jsx에
    // 렌더링 없음, 레거시/가져오기 경로로만 채워짐). 다만 normalizeDiagnosisEntry가 이
    // 값을 bk2103_tool_pressing 자동보정 소스로 실제 소비하므로(legacyNormalize.ts:251-259)
    // 계산에 관여하는 진짜 raw 필드다.
    dependsOn: elbowJobDiagnosisDependsOn(['direct_anatomic_link', 'selectedBkType', 'bk2103_frequent_high_force_grip']),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  },
);

// 다중선택 그룹 3종 — 옵션마다 boolean 변수로 분해(§다중선택 배열 계약). [원본 값,
// camelCase 접미사, 라벨] 튜플로 명시해 변환 실수를 피한다(elbow/wrist 옵션 값이
// 일부만 다르므로 프로그래밍 변환보다 명시가 안전).
const ELBOW_BK2105_PRESSURE_SOURCE_OPTIONS = [
  ['hard_surface', 'hardSurface', '딱딱한 표면'],
  ['tool_edge', 'toolEdge', '공구 모서리'],
  ['ground_contact', 'groundContact', '바닥 접촉'],
  ['carrying_contact', 'carryingContact', '운반 접촉'],
  ['other', 'other', '기타'],
] as const;

for (const [, camelKey, label] of ELBOW_BK2105_PRESSURE_SOURCE_OPTIONS) {
  ELBOW_METADATA.push({
    key: `elbow.jobDiagnosis.bk2105PressureSource.${camelKey}`,
    label: `팔꿈치 압박 원인(BK2105) — ${label}`,
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn([
      'direct_anatomic_link', 'selectedBkType', 'direct_pressure_level', 'bk2105_pressure_source',
    ]),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  });
}

// bk2106과 값 집합은 같지만(같은 PRESSURE_SOURCE_OPTIONS 상수 재사용, DiseaseSpecificFields.jsx)
// 별도 namespace의 별개 필드다.
for (const [, camelKey, label] of ELBOW_BK2105_PRESSURE_SOURCE_OPTIONS) {
  ELBOW_METADATA.push({
    key: `elbow.jobDiagnosis.bk2106PressureSource.${camelKey}`,
    label: `팔꿈치 압박 원인(BK2106) — ${label}`,
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn([
      'direct_anatomic_link', 'selectedBkType', 'direct_pressure_level', 'bk2106_pressure_source',
    ]),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  });
}

const ELBOW_BK2103_VIBRATION_TOOL_OPTIONS = [
  ['grinder', 'grinder', '그라인더'],
  ['jackhammer', 'jackhammer', '착암기'],
  ['demolition_hammer', 'demolitionHammer', '파쇄 해머'],
  ['chipping_hammer', 'chippingHammer', '치핑 해머'],
  ['tamping_machine', 'tampingMachine', '탬핑 머신'],
  ['rotary_hammer', 'rotaryHammer', '로터리 해머'],
  ['compactor', 'compactor', '컴팩터'],
  ['reciprocating_saw', 'reciprocatingSaw', '왕복톱'],
  ['rivet_hammer', 'rivetHammer', '리벳 해머'],
  ['rust_hammer', 'rustHammer', '러스트 해머'],
  ['powder_actuated_tool', 'powderActuatedTool', '화약식 공구'],
  ['forging_hammer', 'forgingHammer', '단조 해머'],
  ['other', 'other', '기타'],
] as const;

for (const [, camelKey, label] of ELBOW_BK2103_VIBRATION_TOOL_OPTIONS) {
  ELBOW_METADATA.push({
    key: `elbow.jobDiagnosis.bk2103VibrationToolType.${camelKey}`,
    label: `팔꿈치 진동 공구 종류(BK2103) — ${label}`,
    group: '팔꿈치 · 원본입력',
    moduleId: 'elbow',
    grain: 'job_diagnosis',
    type: 'boolean',
    provenance: 'raw',
    dependsOn: elbowJobDiagnosisDependsOn([
      'direct_anatomic_link', 'selectedBkType', 'vibration_exposure', 'bk2103_vibration_tool_type',
    ]),
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'elbow_jobDiagnosis_branch_raw',
    supportedFormulaPolicies: [],
  });
}
